/** @file Two real daemons certify, deliver, and recover multicast operations. */

import { FileSystem } from "@effect/platform";
import { ProtocolErrorCode } from "@modelcontextprotocol/client";
import {
  acquireHarnessEndpoint,
  AgentAddress,
  type Content,
  type HarnessEndpoint,
  type InboundDelivery,
  SendError,
  type SendInput,
} from "@moltzap/client";
import { AgentCard, type AgentName, WIRE_VERSION } from "@moltzap/identity";
import { WireVersions } from "@moltzap/identity/test";
import { Effect, Fiber, Option, Schema, Stream } from "effect";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { expectEveryMemberSigned } from "./certified-history.js";
import {
  acquireDaemonManagementClient,
  acquireDaemonProcess,
  acquireProcessInfrastructure,
  awaitDaemonStartupFailure,
  DAEMON_BINARY,
  type DaemonProcessFixture,
  makeDaemonProcessFixture,
  makeRegistrationRequest,
  type ProcessInfrastructure,
  ProcessTestError,
  processTrace,
  REGISTRY_BINARY,
  ROUTER_BINARY,
  type RunningProcess,
  stopProcess,
} from "./daemon-process-harness.js";
import {
  completedReanchorKind,
  configurationStartupPhase,
  legacySettingReason,
  newerSchemaReason,
  outboxTooOldReason,
  outboxTooOldRemedy,
  preResetReason,
  preResetRemedy,
  registeredDaemonStatus,
  registrationResultKind,
  resetReleaseDocsAnchor,
  storageStartupPhase,
} from "./expected-contracts.js";
import { arrayContaining } from "./test-matchers.js";

const registerFixture = (fixture: DaemonProcessFixture) =>
  Effect.scoped(
    Effect.gen(function* () {
      const management = yield* acquireDaemonManagementClient(fixture.endpoint);
      expect(yield* management.status()).toEqual({ kind: "unregistered" });

      const registered = yield* management.register(
        makeRegistrationRequest(fixture),
      );
      expect(registered.kind).toBe(registrationResultKind);
      if (registered.kind === registrationResultKind) {
        const agentCard = yield* Schema.decodeUnknown(AgentCard)(
          registered.agentCard,
        );
        expect(agentCard).toMatchObject({
          agentName: fixture.agentName,
        });
      }
    }),
  );

/** Sends one addressed post with `send` and waits for the peer to receive it. */
const deliverDirect = (input: {
  readonly from: DaemonProcessFixture;
  readonly to: DaemonProcessFixture;
  readonly text: string;
  readonly send: typeof sendOrQueue;
}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const sender = yield* acquireHarnessEndpoint(input.from.endpoint);
      const receiver = yield* acquireHarnessEndpoint(input.to.endpoint);
      const delivery = yield* Effect.forkScoped(
        nextDelivery(receiver.messages),
      );
      yield* input.send(sender, {
        to: directAddress(input.to.agentName),
        text: input.text,
      });
      const inbound = yield* Fiber.join(delivery);
      expect(inbound.item).toMatchObject({
        kind: "multicast",
        message: {
          kind: "direct",
          sender: directAddress(input.from.agentName),
          content: [{ type: "text", text: input.text }],
        },
      });
      yield* inbound.acknowledge;
    }),
  );

const beforeRestartText = "sent before the daemon restarts";

/** Sends one post as a host does, failing on any send failure. */
const certifiedSend = (endpoint: HarnessEndpoint, input: SendInput) =>
  endpoint.send(input).pipe(Effect.asVoid);

const fromRestartedText = "sent by the restarted daemon";

interface RestartScenario {
  readonly restartedFixture: DaemonProcessFixture;
  readonly peerFixture: DaemonProcessFixture;
  readonly restartedDaemon: RunningProcess;
}

interface RouterRestartScenario {
  readonly infrastructure: ProcessInfrastructure;
  readonly memberFixture: DaemonProcessFixture;
  readonly conciergeFixture: DaemonProcessFixture;
}

interface ProcessScenario {
  readonly callerFixture: DaemonProcessFixture;
  readonly targetFixture: DaemonProcessFixture;
  readonly targetDaemon: RunningProcess;
  readonly callerAddress: AgentAddress;
  readonly targetAddress: AgentAddress;
}

interface AdmissionScenario {
  readonly registeredFixture: DaemonProcessFixture;
  readonly unregisteredFixture: DaemonProcessFixture;
}

const acquireRestartPair = Effect.gen(function* () {
  const infrastructure = yield* acquireProcessInfrastructure;
  const [restartedFixture, peerFixture] = yield* Effect.all(
    [
      makeDaemonProcessFixture(infrastructure, "restart-subject"),
      makeDaemonProcessFixture(infrastructure, "restart-peer"),
    ] as const,
    { concurrency: 2 },
  );
  const [restartedDaemon] = yield* Effect.all(
    [
      acquireDaemonProcess(restartedFixture),
      acquireDaemonProcess(peerFixture),
    ] as const,
    { concurrency: 2 },
  );
  return { restartedFixture, peerFixture, restartedDaemon };
});

const acquireRouterRestartPair = Effect.gen(function* () {
  const infrastructure = yield* acquireProcessInfrastructure;
  const [memberFixture, conciergeFixture] = yield* Effect.all(
    [
      makeDaemonProcessFixture(infrastructure, "router-restart-member"),
      makeDaemonProcessFixture(infrastructure, "router-restart-concierge"),
    ] as const,
    { concurrency: 2 },
  );
  yield* Effect.all(
    [
      acquireDaemonProcess({
        ...memberFixture,
        wireVersions: {
          emitted: WIRE_VERSION,
          live: [WIRE_VERSION, "2026.1019.3"],
          history: [WIRE_VERSION, "2026.1019.3"],
        },
      }),
      acquireDaemonProcess({
        ...conciergeFixture,
        wireVersions: {
          emitted: "2026.1019.3",
          live: [WIRE_VERSION, "2026.1019.3"],
          history: [WIRE_VERSION, "2026.1019.3"],
        },
      }),
    ] as const,
    { concurrency: 2 },
  );
  return { infrastructure, memberFixture, conciergeFixture };
});

const acquireProcessPair = Effect.gen(function* () {
  const infrastructure = yield* acquireProcessInfrastructure;
  const [callerFixture, targetFixture] = yield* Effect.all(
    [
      makeDaemonProcessFixture(infrastructure, "process-caller"),
      makeDaemonProcessFixture(infrastructure, "process-target"),
    ] as const,
    { concurrency: 2 },
  );
  const [, targetDaemon] = yield* Effect.all(
    [acquireDaemonProcess(callerFixture), acquireDaemonProcess(targetFixture)],
    { concurrency: 2 },
  );
  return {
    callerFixture,
    targetFixture,
    targetDaemon,
    callerAddress: directAddress(callerFixture.agentName),
    targetAddress: directAddress(targetFixture.agentName),
  };
});

function expectRetiredConversationIdentifierRefused(
  callerFixture: DaemonProcessFixture,
) {
  return Effect.gen(function* () {
    yield* Effect.scoped(
      Effect.gen(function* () {
        const management = yield* acquireDaemonManagementClient(
          callerFixture.endpoint,
        );
        const retiredIdentifier = "retired-public-identifier";
        const malformed = yield* management.callExpectingProtocolError(
          "read_conversation",
          { conversationId: retiredIdentifier },
        );
        expect(malformed.code).toBe(ProtocolErrorCode.InvalidParams);
        expect(malformed.data).toMatchObject({
          issues: arrayContaining([
            { path: ["conversationId"], message: "Unexpected field" },
          ]),
        });
        expect(JSON.stringify(malformed.data)).not.toContain(retiredIdentifier);
      }),
    );
  });
}

const withoutAdmissionCredential = (
  fixture: DaemonProcessFixture,
): DaemonProcessFixture => ({
  ...fixture,
  environment: Object.fromEntries(
    Object.entries(fixture.environment).filter(
      ([name]) => name !== "SHARNESS_ADMISSION_CREDENTIAL_FILE",
    ),
  ),
});

const readActiveStatus = (fixture: DaemonProcessFixture) =>
  Effect.scoped(
    Effect.gen(function* () {
      const management = yield* acquireDaemonManagementClient(fixture.endpoint);
      return yield* management.status();
    }),
  );

const withMissingAdmissionCredential = (
  fixture: DaemonProcessFixture,
): DaemonProcessFixture => ({
  ...fixture,
  environment: {
    ...fixture.environment,
    SHARNESS_ADMISSION_CREDENTIAL_FILE: `${fixture.stateDirectory}.absent-admission`,
  },
});

const withAdmissionCredentialFile = (
  fixture: DaemonProcessFixture,
  path: string,
): DaemonProcessFixture => ({
  ...fixture,
  environment: {
    ...fixture.environment,
    SHARNESS_ADMISSION_CREDENTIAL_FILE: path,
  },
});

const acquireAdmissionFixtures = Effect.gen(function* () {
  const infrastructure = yield* acquireProcessInfrastructure;
  const [registeredFixture, unregisteredFixture] = yield* Effect.all(
    [
      makeDaemonProcessFixture(infrastructure, "admission-registered"),
      makeDaemonProcessFixture(infrastructure, "admission-unregistered"),
    ] as const,
    { concurrency: 2 },
  );
  return { registeredFixture, unregisteredFixture };
});

/**
 * Each test starts PGlite, the Registry, the Router and two daemons; two of
 * them restart a daemon and one restarts the Router. Beside a second full Client suite and another
 * integration file (load average 17 to 32 on 8 cores) the restart test has
 * taken 62 to 163 seconds, most of it process startup. The limit is the only
 * wall-clock bound these traces set themselves.
 */
const PROCESS_TEST_TIMEOUT_MS = 180_000;

const initialText = "hello from the first real daemon";

const responseText = "addressed response from the second real daemon";

const multicastPart = {
  type: "data",
  value: {
    "org.social-harness/collective": { kind: "operation", op: "multicast" },
  },
} as const;

const initialContent = [
  { type: "text", text: initialText },
  multicastPart,
] as const satisfies Content;

const responseContent = [
  { type: "text", text: responseText },
  multicastPart,
] as const satisfies Content;

const readDurableHistory = (
  fixture: DaemonProcessFixture,
  address: AgentAddress,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const management = yield* acquireDaemonManagementClient(fixture.endpoint);
      expect(yield* management.searchConversations()).toEqual({
        kind: "page",
        addresses: [address],
        hasMore: false,
      });
      const history = yield* management.readConversation(address);

      expectEveryMemberSigned(history.records, [
        fixture.agentName,
        address.slice("agent:".length),
      ]);
      return history;
    }),
  );

const toRestartedText = "sent to the restarted daemon";

/**
 * Either send after the restart may fail as queued, so each is confirmed by
 * its delivery. The restarted daemon's delivery of the peer's post shows it
 * stored that record, and an endpoint stores a record only after the one it
 * extends, so its durable history then holds all three posts.
 */
const singleRestartBehavior = Effect.gen(function* () {
  const scenario = yield* acquireRestartPair;
  yield* registerFixture(scenario.restartedFixture);
  yield* registerFixture(scenario.peerFixture);
  yield* restartSenderAndExpectDelivery(scenario);
  yield* expectRestartedRecipientHistory(scenario);
}).pipe(Effect.scoped);

function restartSenderAndExpectDelivery({
  restartedFixture,
  peerFixture,
  restartedDaemon,
}: RestartScenario) {
  return Effect.gen(function* () {
    yield* deliverDirect({
      from: restartedFixture,
      to: peerFixture,
      text: beforeRestartText,
      send: certifiedSend,
    });
    yield* stopProcess(restartedDaemon);
    yield* acquireDaemonProcess(restartedFixture);
    yield* deliverDirect({
      from: restartedFixture,
      to: peerFixture,
      text: fromRestartedText,
      send: sendOrQueue,
    });
  });
}

const beforeRouterRestartText = "sent before the Router restarts";

const afterRouterRestartText = "sent after the Router restarts";

const replyAfterRouterRestartText = "reply after the Router restarts";

/**
 * The Router restarts with every daemon still up, as a network redeploy
 * replaces it. Both daemons must re-anchor their conversation under the new
 * Router instance and then deliver in both directions.
 */
const routerRestartBehavior = Effect.gen(function* () {
  const scenario = yield* acquireRouterRestartPair;
  yield* registerFixture(scenario.memberFixture);
  yield* registerFixture(scenario.conciergeFixture);
  yield* restartRouterAndExpectBidirectionalDelivery(scenario);
  yield* expectRecoveredRouterHistory(scenario);
}).pipe(Effect.scoped);

const processBehavior = Effect.gen(function* () {
  const scenario = yield* acquireProcessPair;
  yield* registerFixture(scenario.callerFixture);
  yield* registerFixture(scenario.targetFixture);
  yield* expectRetiredConversationIdentifierRefused(scenario.callerFixture);
  yield* exchangeInitialPostsAndExpectDelivery(scenario);
  yield* expectInitialHistoriesMatch(scenario);
  yield* restartRecipientAndExpectRetainedHistory(scenario);
  yield* deliverDirect({
    from: scenario.callerFixture,
    to: scenario.targetFixture,
    text: "new message after the recipient restarts",
    send: sendOrQueue,
  });
  yield* deliverDirect({
    from: scenario.targetFixture,
    to: scenario.callerFixture,
    text: "reply from the restarted recipient",
    send: sendOrQueue,
  });
}).pipe(Effect.scoped);

/** `fixture` configured with `other`'s agent key in place of its own. */
const withAgentKeyOf = (
  fixture: DaemonProcessFixture,
  other: DaemonProcessFixture,
): DaemonProcessFixture => ({
  ...fixture,
  environment: {
    ...fixture.environment,
    SHARNESS_AGENT_PRIVATE_KEY_FILE: other.agentPrivateKeyFile,
  },
});

/** Starts `fixture`'s daemon and expects it to stop in `phase` before it listens. */
const expectStartupFailure = (
  fixture: DaemonProcessFixture,
  phase: typeof configurationStartupPhase | typeof storageStartupPhase,
) =>
  awaitDaemonStartupFailure(fixture).pipe(
    Effect.tap((failure) =>
      Effect.sync(() => {
        expect(failure.exitCode).not.toBe(0);
        expect(failure.logs).toContain(
          `sharnessd startup failed in phase ${phase}`,
        );
      }),
    ),
  );

/**
 * A registered daemon restarts without its admission credential, whether the
 * credential is unset, missing, empty or invalid. Started with another
 * agent's key, it refuses its identity row and stops in phase storage before
 * it listens. An unregistered daemon without the credential stops in phase
 * configuration.
 */
const admissionLifetimeBehavior = Effect.gen(function* () {
  const scenario = yield* acquireAdmissionFixtures;
  yield* registerAndExpectSingleStartupAnnouncement(scenario.registeredFixture);
  yield* expectRegisteredRestartWithoutAdmission(
    scenario.registeredFixture,
    withoutAdmissionCredential(scenario.registeredFixture),
  );
  yield* expectRegisteredRestartWithoutAdmission(
    scenario.registeredFixture,
    withMissingAdmissionCredential(scenario.registeredFixture),
  );
  yield* expectRegisteredRestartWithoutAdmission(
    scenario.registeredFixture,
    withAdmissionCredentialFile(scenario.registeredFixture, ""),
  );
  yield* expectRegisteredRestartWithoutAdmission(
    scenario.registeredFixture,
    withAdmissionCredentialFile(
      scenario.registeredFixture,
      scenario.registeredFixture.agentPrivateKeyFile,
    ),
  );
  yield* expectIdentityAndAdmissionFailures(scenario);
}).pipe(Effect.scoped);

function registerAndExpectSingleStartupAnnouncement(
  registeredFixture: DaemonProcessFixture,
) {
  return Effect.gen(function* () {
    const firstRun = yield* acquireDaemonProcess(registeredFixture);
    yield* registerFixture(registeredFixture);
    yield* stopProcess(firstRun);
    expect(firstRun.logs()).toContain(
      `sharnessd listening on ${registeredFixture.endpoint}`,
    );
    expect(firstRun.logs()).toMatch(/\(package \S+; WIRE_VERSION \S+\)/u);
    expect(firstRun.logs().match(/sharnessd listening on/gu)).toHaveLength(1);
  });
}

function expectRegisteredRestartWithoutAdmission(
  fixture: DaemonProcessFixture,
  configured: DaemonProcessFixture,
) {
  return Effect.gen(function* () {
    const running = yield* acquireDaemonProcess(configured);
    expect((yield* readActiveStatus(fixture)).kind).toBe(
      registeredDaemonStatus,
    );
    yield* stopProcess(running);
  });
}

/**
 * A release with an empty live window refuses this binary's retained outbound
 * bytes. The child composes only published service and Identity APIs.
 */
const retiredWindowDaemon = `
  import { NodeRuntime } from "@effect/platform-node";
  import { WIRE_VERSION } from "@moltzap/identity"; import { WireVersions } from "@moltzap/identity/test";
  import { Daemon } from "@moltzap/client/service";
  import { ConfigProvider, Effect, Layer } from "effect";
  Layer.launch(Daemon.layer).pipe(
    Effect.provideService(WireVersions, { live: [], history: [WIRE_VERSION] }),
    Effect.withConfigProvider(ConfigProvider.fromEnv()),
    NodeRuntime.runMain,
  );
`;

/** A retired version in a retained envelope must stop startup before any schema change. */
const refusesStaleOutbox = Effect.scoped(
  Effect.gen(function* () {
    const infrastructure = yield* acquireProcessInfrastructure;
    const local = yield* makeDaemonProcessFixture(
      infrastructure,
      "stale-outbox",
    );
    const peer = yield* makeDaemonProcessFixture(infrastructure, "stale-peer");
    const daemonProcess = yield* acquireDaemonProcess(local);
    yield* acquireDaemonProcess(peer);
    yield* registerFixture(local);
    yield* registerFixture(peer);
    yield* deliverDirect({
      from: local,
      to: peer,
      text: "outbox baseline",
      send: sendOrQueue,
    });
    yield* stopProcess(daemonProcess);
    const before = yield* markStoredOutboundPending(local.stateDirectory);
    const failed = yield* awaitDaemonStartupFailure(local, {
      executable: process.execPath,
      args: [
        "--conditions=sharness-test",
        "--input-type=module",
        "-e",
        retiredWindowDaemon,
      ],
      cwd: dirname(fileURLToPath(import.meta.url)),
    });
    expect(failed.exitCode).not.toBe(0);
    expect(failed.logs).toContain(outboxTooOldReason);
    expect(failed.logs).toContain(outboxTooOldRemedy);
    expect(failed.logs).toContain(resetReleaseDocsAnchor);
    const after = yield* storedSchema(local.stateDirectory);
    expect(after).toEqual(before);
  }),
);

it(
  "certifies fresh posts in both directions after one daemon restarts",
  processTrace(processBehavior),
  PROCESS_TEST_TIMEOUT_MS,
);

it(
  "restarts a registered daemon without the admission credential but not under another agent's key",
  processTrace(admissionLifetimeBehavior),
  PROCESS_TEST_TIMEOUT_MS,
);

it(
  "delivers both ways after one real daemon restarts while its peer stays up",
  processTrace(singleRestartBehavior),
  PROCESS_TEST_TIMEOUT_MS,
);

it(
  "certifies across adjacent emitted versions and re-anchors after the Router restarts",
  processTrace(
    routerRestartBehavior.pipe(
      Effect.provideService(WireVersions, {
        emitted: WIRE_VERSION,
        live: [WIRE_VERSION, "2026.1019.3"],
        history: [WIRE_VERSION, "2026.1019.3"],
      }),
    ),
  ),
  PROCESS_TEST_TIMEOUT_MS,
);

it(
  "reports outbox-too-old at the process boundary without changing schema or backups",
  processTrace(refusesStaleOutbox),
  PROCESS_TEST_TIMEOUT_MS,
);

it(
  "reports newer-schema in stderr before changing a newer database",
  processTrace(
    Effect.scoped(
      Effect.gen(function* () {
        const infrastructure = yield* acquireProcessInfrastructure;
        const local = yield* makeDaemonProcessFixture(
          infrastructure,
          "newer-schema",
        );
        const path = join(local.stateDirectory, "sharnessd.sqlite3");
        const database = new DatabaseSync(path);
        database.exec("PRAGMA user_version = 2147483647");
        database.close();
        const before = yield* storedSchema(local.stateDirectory);

        const failed = yield* awaitDaemonStartupFailure(local);

        expect(failed.exitCode).not.toBe(0);
        expect(failed.logs).toContain(storageStartupPhase);
        expect(failed.logs).toContain(newerSchemaReason);
        expect(yield* storedSchema(local.stateDirectory)).toEqual(before);
      }),
    ),
  ),
  PROCESS_TEST_TIMEOUT_MS,
);

it(
  "reports legacy-key and key names without values for every service",
  processTrace(
    Effect.scoped(
      Effect.gen(function* () {
        const infrastructure = yield* acquireProcessInfrastructure;
        const local = yield* makeDaemonProcessFixture(
          infrastructure,
          "legacy-key",
        );
        const retiredSecret = "retired-secret-value";
        for (const [executable, key] of [
          [DAEMON_BINARY, "MOLTZAPD_STATE_DIRECTORY"],
          [REGISTRY_BINARY, "MOLTZAP_REGISTRY_ADMISSION_CREDENTIAL"],
          [ROUTER_BINARY, "MOLTZAP_ROUTER_PORT"],
        ] as const) {
          const failed = yield* awaitDaemonStartupFailure(
            {
              ...local,
              environment: {
                ...local.environment,
                [key]: retiredSecret,
              },
            },
            {
              executable,
              args: [],
            },
          );
          expect(failed.exitCode).not.toBe(0);
          expect(failed.logs).toContain(legacySettingReason);
          expect(failed.logs).toContain(key);
          expect(failed.logs).not.toContain(retiredSecret);
        }
      }),
    ),
  ),
  PROCESS_TEST_TIMEOUT_MS,
);

it(
  "reports pre-reset for legacy filenames and every populated earlier schema without creating a replacement store",
  processTrace(
    Effect.scoped(
      Effect.gen(function* () {
        const infrastructure = yield* acquireProcessInfrastructure;
        for (const [name, filename, schema] of [
          ["legacy-file", "moltzapd.sqlite3", 8],
          ["legacy-schema", "sharnessd.sqlite3", 9],
          ["unversioned-schema", "sharnessd.sqlite3", 0],
        ] as const) {
          const local = yield* makeDaemonProcessFixture(infrastructure, name);
          const database = new DatabaseSync(
            join(local.stateDirectory, filename),
          );
          database.exec(
            `CREATE TABLE retained (value TEXT); PRAGMA user_version = ${schema}`,
          );
          database.close();
          const fs = yield* FileSystem.FileSystem;
          const before = yield* fs.readDirectory(local.stateDirectory);
          const failed = yield* awaitDaemonStartupFailure(local);
          expect(failed.exitCode).not.toBe(0);
          expect(failed.logs).toContain(preResetReason);
          expect(failed.logs).toContain(preResetRemedy);
          expect(failed.logs).toContain(resetReleaseDocsAnchor);
          expect(yield* fs.readDirectory(local.stateDirectory)).toEqual(before);
        }
      }),
    ),
  ),
  PROCESS_TEST_TIMEOUT_MS,
);

function expectRestartedRecipientHistory(state: RestartScenario) {
  return Effect.gen(function* () {
    const { restartedFixture, peerFixture } = state;
    yield* deliverDirect({
      from: peerFixture,
      to: restartedFixture,
      text: toRestartedText,
      send: sendOrQueue,
    });
    const history = yield* readDurableHistory(
      restartedFixture,
      directAddress(peerFixture.agentName),
    );
    expect(
      history.records.map(({ recordCore }) => recordCore.action.kind),
    ).toEqual(["GENESIS", "POST", "POST"]);
    expect(
      history.records.map(
        ({ recordCore }) => recordCore.action.postIntent.content[0],
      ),
    ).toEqual([
      { type: "text", text: beforeRestartText },
      { type: "text", text: fromRestartedText },
      { type: "text", text: toRestartedText },
    ]);
  });
}

function restartRouterAndExpectBidirectionalDelivery(
  state: RouterRestartScenario,
) {
  return Effect.gen(function* () {
    const { infrastructure, memberFixture, conciergeFixture } = state;
    yield* Effect.all(
      [
        deliverDirect({
          from: memberFixture,
          to: conciergeFixture,
          text: beforeRouterRestartText,
          send: certifiedSend,
        }),
        deliverDirect({
          from: conciergeFixture,
          to: memberFixture,
          text: "successor-authored head before Router restart",
          send: certifiedSend,
        }),
      ],
      { concurrency: 2 },
    );
    yield* infrastructure.restartRouter;
    yield* deliverDirect({
      from: memberFixture,
      to: conciergeFixture,
      text: afterRouterRestartText,
      send: sendOrQueue,
    });
    yield* deliverDirect({
      from: conciergeFixture,
      to: memberFixture,
      text: replyAfterRouterRestartText,
      send: sendOrQueue,
    });
  });
}

function expectRecoveredRouterHistory(state: RouterRestartScenario) {
  return Effect.gen(function* () {
    const { memberFixture, conciergeFixture } = state;
    const history = yield* readDurableHistory(
      memberFixture,
      directAddress(conciergeFixture.agentName),
    );
    const texts = history.records.map(
      ({ recordCore }) => recordCore.action.postIntent.content[0],
    );
    expect(texts.slice(0, 2)).toEqual(
      arrayContaining([
        { type: "text", text: beforeRouterRestartText },
        { type: "text", text: "successor-authored head before Router restart" },
      ]),
    );
    expect(texts.slice(2)).toEqual([
      { type: "text", text: afterRouterRestartText },
      { type: "text", text: replyAfterRouterRestartText },
    ]);
    const peerHistory = yield* readDurableHistory(
      conciergeFixture,
      directAddress(memberFixture.agentName),
    );
    expect(peerHistory.records.map(({ recordCore }) => recordCore)).toEqual(
      history.records.map(({ recordCore }) => recordCore),
    );
    const restartedAnchor = history.records[2]?.routerAnchor;
    expect(restartedAnchor?.kind).toBe(completedReanchorKind);
    if (restartedAnchor?.kind === completedReanchorKind) {
      expect(restartedAnchor.reanchor?.sharnessVersion).toBe(
        history.records[1]?.recordCore.sharnessVersion,
      );
    }
  });
}

function exchangeInitialPostsAndExpectDelivery(state: ProcessScenario) {
  return Effect.gen(function* () {
    const { callerFixture, targetFixture, callerAddress, targetAddress } =
      state;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const caller = yield* acquireHarnessEndpoint(callerFixture.endpoint);
        const target = yield* acquireHarnessEndpoint(targetFixture.endpoint);
        const callerDelivery = yield* Effect.forkScoped(
          nextDelivery(caller.messages),
        );
        const targetDelivery = yield* Effect.forkScoped(
          nextDelivery(target.messages),
        );

        yield* caller.send({ to: targetAddress, text: initialText });
        const targetInbound = yield* Fiber.join(targetDelivery);
        expect(targetInbound.item).toMatchObject({
          kind: "multicast",
          message: {
            kind: "direct",
            address: callerAddress,
            sender: callerAddress,
            content: [{ type: "text", text: initialText }],
          },
        });
        yield* targetInbound.acknowledge;

        yield* target.send({ to: callerAddress, text: responseText });
        const callerInbound = yield* Fiber.join(callerDelivery);
        expect(callerInbound.item).toMatchObject({
          kind: "multicast",
          message: {
            kind: "direct",
            address: targetAddress,
            sender: targetAddress,
            content: [{ type: "text", text: responseText }],
          },
        });
        yield* callerInbound.acknowledge;
      }),
    );
  });
}

function expectInitialHistoriesMatch(state: ProcessScenario) {
  return Effect.gen(function* () {
    const { callerFixture, targetFixture, callerAddress, targetAddress } =
      state;
    const callerHistory = yield* readDurableHistory(
      callerFixture,
      targetAddress,
    );
    const targetHistory = yield* readDurableHistory(
      targetFixture,
      callerAddress,
    );
    expect(callerHistory.continuation).toBeNull();
    expect(callerHistory.records).toHaveLength(2);
    expect(
      callerHistory.records.map(({ recordCore }) => recordCore.action.kind),
    ).toEqual(["GENESIS", "POST"]);
    expect(
      callerHistory.records.map(
        ({ recordCore }) => recordCore.action.postIntent.content,
      ),
    ).toEqual([initialContent, responseContent]);
    expect(targetHistory.continuation).toBeNull();
    expect(targetHistory.records).toHaveLength(2);
    expect(
      targetHistory.records.map(({ recordCore }) => recordCore.action.kind),
    ).toEqual(["GENESIS", "POST"]);
    expect(
      targetHistory.records.map(
        ({ recordCore }) => recordCore.action.postIntent.content,
      ),
    ).toEqual([initialContent, responseContent]);
  });
}

function restartRecipientAndExpectRetainedHistory({
  targetDaemon,
  targetFixture,
  callerAddress,
}: ProcessScenario) {
  return Effect.gen(function* () {
    yield* stopProcess(targetDaemon);
    yield* acquireDaemonProcess(targetFixture);
    const recovered = yield* readDurableHistory(targetFixture, callerAddress);
    expect(recovered.records).toHaveLength(2);
  });
}

function expectIdentityAndAdmissionFailures(state: AdmissionScenario) {
  return Effect.gen(function* () {
    const { registeredFixture, unregisteredFixture } = state;
    yield* expectStartupFailure(
      withAgentKeyOf(registeredFixture, unregisteredFixture),
      storageStartupPhase,
    );
    yield* expectStartupFailure(
      withoutAdmissionCredential(unregisteredFixture),
      configurationStartupPhase,
    );
    yield* expectStartupFailure(
      withMissingAdmissionCredential(unregisteredFixture),
      configurationStartupPhase,
    );
  });
}

function directAddress(agentName: AgentName): AgentAddress {
  return Schema.decodeUnknownSync(AgentAddress)(`agent:${agentName}`);
}

/** The next delivery on `stream`. */
function nextDelivery<E>(stream: Stream.Stream<InboundDelivery, E>) {
  return Stream.runHead(stream).pipe(Effect.flatMap(requireDelivery));
}

function requireDelivery(
  delivery: Option.Option<InboundDelivery>,
): Effect.Effect<InboundDelivery, ProcessTestError> {
  return Option.match(delivery, {
    onNone: () =>
      Effect.fail(
        new ProcessTestError({ message: "message subscription ended" }),
      ),
    onSome: Effect.succeed,
  });
}

/**
 * Sends one post from `endpoint` after a daemon restart. A send whose own
 * outbox drain outlasts its bound or loses the Router fails with
 * `delivery-pending`: the post is durably queued, and the daemon delivers it
 * once its Router worker answers. Under load that happens while the restarted
 * daemon and its peer exchange recovery traffic, so the trace takes that
 * failure as queued and confirms the post by the peer's delivery. Any other
 * failure fails the trace.
 * @param endpoint Endpoint that sends.
 * @param input The post.
 * @returns Completion once the post is certified or queued.
 */
function sendOrQueue(endpoint: HarnessEndpoint, input: SendInput) {
  return endpoint.send(input).pipe(
    Effect.asVoid,
    Effect.catchIf(
      (error) =>
        error instanceof SendError && error.reason === "delivery-pending",
      () => Effect.void,
    ),
  );
}

/** Retry an existing signed envelope unchanged under the narrower release window. */
function markStoredOutboundPending(directory: string) {
  return Effect.try({
    try: () => {
      const database = new DatabaseSync(join(directory, "sharnessd.sqlite3"));
      try {
        const result = database
          .prepare(
            "UPDATE outbound_messages SET disposition = 'pending' WHERE message_id = (SELECT message_id FROM outbound_messages LIMIT 1)",
          )
          .run();
        if (result.changes !== 1) {
          throw new Error("expected an existing signed outbound envelope");
        }
      } finally {
        database.close();
      }
    },
    catch: (cause) =>
      new ProcessTestError({
        message: "could not prepare retired outbox",
        cause,
      }),
  }).pipe(Effect.zipRight(storedSchema(directory)));
}

/** Capture schema and backup state without depending on a particular schema number. */
function storedSchema(directory: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const snapshot = yield* Effect.sync(() => {
      const database = new DatabaseSync(join(directory, "sharnessd.sqlite3"), {
        readOnly: true,
      });
      try {
        return {
          schema: database.prepare("PRAGMA user_version").get(),
          objects: database
            .prepare("SELECT sql FROM sqlite_schema ORDER BY name")
            .all(),
        };
      } finally {
        database.close();
      }
    });
    return {
      ...snapshot,
      backups: (yield* fs.readDirectory(directory)).filter((name) =>
        name.includes(".backup"),
      ),
    };
  });
}
