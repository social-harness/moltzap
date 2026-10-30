/**
 * @file Focused daemon activation, supervision, and durable delivery tests.
 *
 * A fiber a test forks outside its scope runs as a daemon, so a failed
 * assertion is reported at once instead of waiting on an uninterruptible
 * registration or receipt that only a later step of the test releases.
 */

import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { scopedLive as it } from "@effect/vitest";
import { SUBSCRIPTION_ID_META_KEY } from "@modelcontextprotocol/server";
import {
  Cause,
  Data,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Option,
  Schema,
} from "effect";
import { join } from "node:path";
import { describe, expect, vi } from "vitest";
import type { EnginePendingMessage } from "../communication/conversations/index.js";
import type { EventStore } from "../host-protocol/operations.js";
import type { HarnessMcpEventHandler } from "./mcp/tools.js";
import type { DaemonStore } from "./store.js";
import { digest, testAgentView } from "../__tests__/agent-card-fixtures.js";
import { collectiveOperationId } from "../__tests__/collective-id-fixtures.js";
import {
  type Fixture,
  makeFixture,
} from "../__tests__/daemon-runtime-fixtures.js";
import {
  awaitFrame,
  awaitStage,
  EXPECTED_LISTENER_FAILURE,
  holdNextRead,
  makeHarness,
  makeListenRequest,
  makeStore,
  makeToolCallRequest,
  makeToolListChangesRequest,
  makeToolListRequest,
  openStream,
  type ReadBarrier,
  requireEventStore,
  requireHandler,
  requireOperations,
  run,
  type RuntimeHarness,
  SUBSCRIPTIONS_ACKNOWLEDGED_NOTIFICATION,
} from "../__tests__/daemon-runtime-harness.js";
import { stateDirectory } from "../__tests__/store-schema-fixtures.js";
import { InboundItem } from "../communication/collectives/inbound.js";
import { RouterWorkerTransportError } from "../communication/router/index.js";
import {
  DeliveryToken,
  encodeRuntimeValue,
  EndpointStoreError,
} from "../communication/store/index.js";
import { INBOX_PENDING_EVENT } from "../host-protocol/names.js";
import { AgentCard } from "../identity/cards.js";
import { AgentName } from "../identity/identifiers.js";
import { HistoryExportRecord } from "./inbox/host-traffic-log.js";
import { DaemonRuntimeError } from "./lifecycle.js";

/**
 * Covers a test's stages plus one `daemon-runtime-harness.ts →
 * STAGE_HANG_BOUND`, so a hung stage fails with its name first.
 */
const LIFECYCLE_TEST_TIMEOUT_MS = 60_000;

vi.setConfig({ testTimeout: LIFECYCLE_TEST_TIMEOUT_MS });

const withHistoryExport = (fixture: Fixture, path: string): Fixture => ({
  ...fixture,
  bootstrap: {
    ...fixture.bootstrap,
    configuration: {
      ...fixture.bootstrap.configuration,
      historyExport: path,
    },
  },
});

const decodeHistoryLine = Schema.decodeUnknownSync(
  Schema.parseJson(HistoryExportRecord),
);

/**
 * The records a history export file holds, one per NDJSON line.
 * @param path The export file.
 * @returns The decoded records, in file order.
 */
const readHistoryExport = (path: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fileSystem) => fileSystem.readFileString(path)),
    Effect.map((text) =>
      text
        .trimEnd()
        .split("\n")
        .map((line) => decodeHistoryLine(line)),
    ),
    Effect.provide(NodeFileSystem.layer),
  );

/**
 * The daemon opens the configured history export and hands that export to
 * delivery, so an inbox read writes the item to the configured file. The
 * engine has no pending delivery, so the read's item is the only record.
 */
const opensConfiguredHistoryExport = () =>
  Effect.gen(function* () {
    const path = join(stateDirectory(), "history.ndjson");
    const fixture = withHistoryExport(yield* makeFixture, path);
    const harness = yield* makeHarness(fixture, "none", true);
    harness.delivery.acknowledged = true;
    const store = makeStore(fixture, true);
    yield* Effect.forkScoped(run(fixture, store, harness));
    yield* awaitStage(
      Deferred.await(harness.engineEntered),
      "engine acquisition",
    );
    yield* Deferred.succeed(harness.engineRelease, undefined);
    yield* awaitStage(Deferred.await(harness.listenerReady), "listener");
    const item = Schema.decodeUnknownSync(InboundItem)({
      kind: "operationFailed",
      operationId: collectiveOperationId(
        testAgentView("agent:alice").agentId,
        8,
      ),
      to: "agent:bob",
      error: "retained failure",
    });
    yield* store.putInboxItem({
      deliveryToken: Schema.decodeUnknownSync(DeliveryToken)(digest("dlv_", 8)),
      canonicalItem: yield* encodeRuntimeValue(item),
    });
    yield* requireEventStore(harness).readInbox({ limit: 1 });

    expect(yield* readHistoryExport(path)).toEqual([
      expect.objectContaining({ kind: "inbound", item }),
    ]);
  });

const blocksStartupAndSupervisesWorker = () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    const harness = yield* makeHarness(fixture, "worker", true);
    const store = makeStore(fixture, true);
    const fiber = yield* Effect.forkScoped(run(fixture, store, harness));
    yield* awaitStage(
      Deferred.await(harness.engineEntered),
      "engine acquisition",
    );
    expect(
      Option.isNone(yield* Deferred.poll(harness.listenerReady)),
      "listener stays closed while the engine is blocked",
    ).toBe(true);

    yield* Deferred.succeed(harness.engineRelease, undefined);
    yield* awaitStage(Deferred.await(harness.listenerReady), "listener");

    yield* Deferred.succeed(harness.failure, undefined);
    const failure = yield* awaitStage(
      Effect.flip(Fiber.join(fiber)),
      "Router worker supervision",
    );
    expect(failure).toEqual(EXPECTED_LISTENER_FAILURE);
  });

/**
 * The harness whose listener, on release, interrupts the receipt fiber the
 * test hands it. This stands in for the MCP server ending an in-flight
 * webhook receipt request when the daemon shuts down.
 */
const withReceiptFinalizer = (
  harness: RuntimeHarness,
  receipt: Deferred.Deferred<Fiber.RuntimeFiber<void, EndpointStoreError>>,
): RuntimeHarness => ({
  ...harness,
  dependencies: {
    ...harness.dependencies,
    acquireListener: (input) =>
      harness.dependencies
        .acquireListener(input)
        .pipe(
          Effect.tap(() =>
            Effect.addFinalizer(() =>
              Deferred.await(receipt).pipe(
                Effect.flatMap(Fiber.interrupt),
                Effect.asVoid,
              ),
            ),
          ),
        ),
  },
});

/**
 * Fork one webhook receipt for `token` as the webhook runs it: uninterruptible
 * to its caller, so only the delivery-gate wait inside the receipt can stop it.
 */
const forkWaitingReceipt = (store: EventStore, token: DeliveryToken) =>
  Effect.forkDaemon(
    store
      .completeWebhookDelivery(token, new Uint8Array([1]))
      .pipe(Effect.uninterruptible),
  );

/**
 * A receipt waiting for the delivery gate while a pass's inbox persistence
 * fails is stopped by the fatal shutdown and commits nothing. The startup pass
 * sees the delivery as acknowledged, so only the subscription's pass reaches
 * the failing store. `yieldNow` lets the forked receipt reach its gate wait
 * before the persistence failure is released.
 */
const closesWhileReceiptWaitsOnFailedPersistence = () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    const original = yield* makeHarness(fixture, "none");
    original.delivery.acknowledged = true;
    const entered = yield* Deferred.make<undefined>();
    const fail = yield* Deferred.make<undefined>();
    const receipt =
      yield* Deferred.make<Fiber.RuntimeFiber<void, EndpointStoreError>>();
    const harness = withReceiptFinalizer(original, receipt);
    let commits = 0;
    const store: DaemonStore = {
      ...makeStore(fixture, true),
      putInboxItem: () =>
        Deferred.succeed(entered, undefined).pipe(
          Effect.zipRight(Deferred.await(fail)),
          Effect.zipRight(
            Effect.fail(new EndpointStoreError({ reason: "persistence" })),
          ),
        ),
      completeWebhookDelivery: () =>
        Effect.sync(() => {
          commits += 1;
        }),
    };
    const daemon = yield* Effect.forkDaemon(run(fixture, store, harness));
    yield* awaitStage(Deferred.await(harness.listenerReady), "listener");
    const eventStore = requireEventStore(harness);
    original.delivery.acknowledged = false;
    yield* openStream(
      requireHandler(harness),
      makeListenRequest("fatal-receipt"),
    );
    yield* awaitStage(Deferred.await(entered), "failing inbox persistence");
    const waiting = yield* forkWaitingReceipt(
      eventStore,
      fixture.pending.deliveryToken,
    );
    yield* Deferred.succeed(receipt, waiting);
    yield* Effect.yieldNow();
    yield* Deferred.succeed(fail, undefined);
    expect(
      yield* awaitStage(Fiber.join(daemon).pipe(Effect.flip), "fatal shutdown"),
    ).toEqual(new DaemonRuntimeError({ phase: "storage" }));
    expect(commits).toBe(0);
  });

const blocksRegistrationAndSupervisesOutbound = () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    const harness = yield* makeHarness(fixture, "outbound", true);
    const fiber = yield* Effect.forkScoped(
      run(fixture, makeStore(fixture, false), harness),
    );
    yield* awaitStage(Deferred.await(harness.listenerReady), "listener");
    const operations = requireOperations(harness);
    const registration = yield* Effect.forkDaemon(
      operations.register(fixture.registerRequest),
    );
    yield* awaitStage(
      Deferred.await(harness.engineEntered),
      "engine acquisition",
    );
    expect(
      Option.isNone(yield* Fiber.poll(registration)),
      "registration still running while the engine is blocked",
    ).toBe(true);

    yield* Deferred.succeed(harness.engineRelease, undefined);
    const registrationResult = yield* awaitStage(
      Fiber.join(registration),
      "registration",
    );
    const encodedLocalCard = yield* Schema.encode(AgentCard)(fixture.localCard);
    expect(registrationResult).toMatchObject({
      kind: "registered",
      agentCard: encodedLocalCard,
    });

    yield* Deferred.succeed(harness.failure, undefined);
    const failure = yield* awaitStage(
      Effect.flip(Fiber.join(fiber)),
      "engine outbound supervision",
    );
    expect(failure).toEqual(EXPECTED_LISTENER_FAILURE);
  });

/**
 * Registration runs the first delivery pass uninterruptibly. When that pass
 * cannot read pending deliveries, registration must still settle and the
 * daemon fail in storage, rather than the request waiting forever.
 */
const settlesRegistrationWhenThePassFails = () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    const harness = yield* makeHarness(fixture, "none");
    harness.delivery.failReads = true;
    const fiber = yield* Effect.forkScoped(
      run(fixture, makeStore(fixture, false), harness),
    );
    yield* awaitStage(Deferred.await(harness.listenerReady), "listener");
    const registration = yield* awaitStage(
      Effect.exit(requireOperations(harness).register(fixture.registerRequest)),
      "registration settling after the failed pass",
    );
    expect(registration).toEqual(Exit.fail({ reason: "persistence-failed" }));
    expect(
      yield* awaitStage(Effect.flip(Fiber.join(fiber)), "daemon failure"),
    ).toEqual(new DaemonRuntimeError({ phase: "storage" }));
  });

const receivesFirstDelivery = (handler: HarnessMcpEventHandler) =>
  Effect.gen(function* () {
    const reader = yield* openStream(handler, makeListenRequest("listener-1"));
    expect(
      yield* awaitFrame(reader, "first subscription acknowledgment"),
    ).toEqual({
      jsonrpc: "2.0",
      method: SUBSCRIPTIONS_ACKNOWLEDGED_NOTIFICATION,
      params: {
        cursor: null,
        truncated: false,
        _meta: { [SUBSCRIPTION_ID_META_KEY]: "listener-1" },
      },
    });
    expect(yield* awaitFrame(reader, "first message delivery")).toMatchObject({
      jsonrpc: "2.0",
      method: "notifications/events/event",
      params: {
        name: INBOX_PENDING_EVENT,
        data: { pendingCount: 1 },
        cursor: null,
        _meta: { [SUBSCRIPTION_ID_META_KEY]: "listener-1" },
      },
    });
    return reader;
  });

const acknowledgeDuringReplacementDelivery = (
  harness: RuntimeHarness,
  handler: HarnessMcpEventHandler,
  pending: EnginePendingMessage,
) =>
  Effect.gen(function* () {
    const readBarrier = yield* holdNextRead(harness);
    const reader = yield* openStream(handler, makeListenRequest("listener-2"));
    yield* awaitFrame(reader, "replacement subscription acknowledgment");
    yield* awaitStage(
      Deferred.await(readBarrier.entered),
      "pending delivery read",
    );

    const acknowledgment = yield* Effect.forkDaemon(
      requireOperations(harness).acknowledgeDelivery(pending.deliveryToken),
    );
    yield* Effect.yieldNow();
    yield* Deferred.succeed(readBarrier.release, undefined);
    expect(
      yield* awaitFrame(reader, "replacement message delivery"),
    ).toMatchObject({
      jsonrpc: "2.0",
      method: "notifications/events/event",
      params: {
        name: INBOX_PENDING_EVENT,
        data: { pendingCount: 1 },
        cursor: null,
        _meta: { [SUBSCRIPTION_ID_META_KEY]: "listener-2" },
      },
    });
    yield* awaitStage(Fiber.join(acknowledgment), "delivery acknowledgment");
  });

/**
 * A delivery replays to each new subscriber until it is acknowledged. The
 * first subscriber's detach runs a delivery pass of its own; the test holds
 * that pass's read and lets it finish before the replacement attaches, so the
 * pass cannot take the replacement's barrier or add to its reads.
 */
const replaysUntilAcknowledged = () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    const harness = yield* makeHarness(fixture, "none");
    yield* Effect.forkScoped(
      run(fixture, makeStore(fixture, true, harness.delivery), harness),
    );
    yield* awaitStage(Deferred.await(harness.listenerReady), "listener");
    const operations = requireOperations(harness);
    const pendingItem = {
      deliveryToken: fixture.pending.deliveryToken,
      item: { kind: "multicast", message: fixture.pending.message },
    };
    expect(
      (yield* operations.readInbox({})).items,
      "inbox before any subscriber attaches",
    ).toEqual([pendingItem]);
    const handler = requireHandler(harness);

    const firstReader = yield* receivesFirstDelivery(handler);
    const detachPass = yield* holdNextRead(harness);
    yield* Effect.tryPromise(() => firstReader.cancel());
    yield* awaitStage(
      Deferred.await(detachPass.entered),
      "first subscriber's detach pass",
    );
    yield* Deferred.succeed(detachPass.release, undefined);
    expect(
      (yield* operations.readInbox({})).items,
      "inbox after the first subscriber's delivery",
    ).toEqual([pendingItem]);
    yield* acknowledgeDuringReplacementDelivery(
      harness,
      handler,
      fixture.pending,
    );
    expect(
      (yield* operations.readInbox({})).items,
      "inbox after acknowledgment",
    ).toEqual([]);
  });

/** The names a `tools/list` response carries. */
const listedToolNames = Schema.decodeUnknown(
  Schema.Struct({
    result: Schema.Struct({
      tools: Schema.Array(Schema.Struct({ name: Schema.String })),
    }),
  }),
);

/** The delivery tokens a `read_inbox` response carries. */
const inboxTokens = Schema.decodeUnknown(
  Schema.Struct({
    result: Schema.Struct({
      structuredContent: Schema.Struct({
        items: Schema.Array(Schema.Struct({ deliveryToken: Schema.String })),
      }),
    }),
  }),
);

/** The JSON body of one MCP response through the daemon's handler. */
const fetchJson = (handler: HarnessMcpEventHandler, request: Request) =>
  Effect.tryPromise(() => handler.fetch(request)).pipe(
    Effect.flatMap((response) => Effect.tryPromise(() => response.json())),
  );

/** The tools the daemon's handler lists, sorted. */
const listTools = (handler: HarnessMcpEventHandler) =>
  fetchJson(handler, makeToolListRequest("tools-list")).pipe(
    Effect.flatMap(listedToolNames),
    Effect.map(({ result }) =>
      result.tools
        .map(({ name }) => name)
        .sort((left, right) => left.localeCompare(right)),
    ),
  );

/** The delivery tokens `read_inbox` returns through the daemon's handler. */
const readInboxThroughMcp = (handler: HarnessMcpEventHandler) =>
  fetchJson(
    handler,
    makeToolCallRequest({
      id: "read-inbox",
      name: "read_inbox",
      toolArguments: {},
    }),
  ).pipe(
    Effect.flatMap(inboxTokens),
    Effect.map(({ result }) =>
      result.structuredContent.items.map(({ deliveryToken }) => deliveryToken),
    ),
  );

/**
 * Sends a register request through MCP, cancels it once engine activation
 * has begun, then releases activation and waits until the activation's first
 * delivery pass has started, by which point the protocol is up. `yieldNow`
 * lets the cancel reach the register operation before activation is released.
 * @param fixture The registering identity.
 * @param harness The daemon's harness, with the engine blocked.
 * @param firstPass Holds the activation's first delivery pass.
 * @returns The cancelled request's response, once the pass is released.
 */
const cancelRegisterDuringActivation = (
  fixture: Fixture,
  harness: RuntimeHarness,
  firstPass: ReadBarrier,
) =>
  Effect.gen(function* () {
    const cancel = new AbortController();
    const registering = yield* Effect.forkDaemon(
      Effect.tryPromise(() =>
        requireHandler(harness).fetch(
          makeToolCallRequest({
            id: "register",
            name: "register",
            toolArguments: fixture.registerRequest,
            signal: cancel.signal,
          }),
        ),
      ),
    );
    yield* awaitStage(
      Deferred.await(harness.engineEntered),
      "engine acquisition",
    );
    cancel.abort();
    const cancelled = yield* Fiber.join(registering);
    yield* Effect.yieldNow();
    yield* Deferred.succeed(harness.engineRelease, undefined);
    yield* awaitStage(Deferred.await(firstPass.entered), "first delivery pass");
    yield* Deferred.succeed(firstPass.release, undefined);
    return cancelled;
  });

/**
 * Cancelling a register request through MCP once activation has begun
 * interrupts its operation, and registration and activation still finish.
 * The catalog reads the daemon's protocol state, so once the protocol is up
 * it lists the post-registration tools and serves `read_inbox`. Fails when
 * the catalog keeps its own flag that only a returned `registered` result
 * sets, which a cancelled call never returns.
 */
const listsToolsAfterACancelledRegister = () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    const harness = yield* makeHarness(fixture, "none", true);
    const firstPass = yield* holdNextRead(harness);
    yield* Effect.forkScoped(run(fixture, makeStore(fixture, false), harness));
    yield* awaitStage(Deferred.await(harness.listenerReady), "listener");
    const cancelled = yield* cancelRegisterDuringActivation(
      fixture,
      harness,
      firstPass,
    );

    const tools = yield* listTools(requireHandler(harness));

    expect(cancelled.ok, "the cancelled register returned a result").toBe(
      false,
    );
    expect(tools, "tools listed after the cancelled register").toEqual([
      "acknowledge_delivery",
      "read_conversation",
      "read_event",
      "read_inbox",
      "search_agents",
      "search_conversations",
      "send_message",
      "status",
    ]);
    expect(
      yield* readInboxThroughMcp(requireHandler(harness)),
      "inbox read through MCP",
    ).toEqual([fixture.pending.deliveryToken]);
  });

/**
 * Between the binding commit and the protocol coming up, status already
 * reports the binding while the catalog still offers only `register` and
 * `status`: the post-registration tools need the protocol. Fails when the
 * catalog follows the registration state instead of the protocol.
 */
const holdsTheCatalogWhileTheProtocolActivates = () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    const harness = yield* makeHarness(fixture, "none", true);
    yield* Effect.forkScoped(run(fixture, makeStore(fixture, false), harness));
    yield* awaitStage(Deferred.await(harness.listenerReady), "listener");
    const operations = requireOperations(harness);
    const registering = yield* Effect.forkDaemon(
      operations.register(fixture.registerRequest),
    );
    yield* awaitStage(
      Deferred.await(harness.engineEntered),
      "engine acquisition",
    );

    const status = yield* operations.readStatus();
    const tools = yield* listTools(requireHandler(harness));

    expect(status.kind, "status once the binding commits").toBe(
      "active" satisfies typeof status.kind,
    );
    expect(tools, "catalog while the protocol activates").toEqual([
      "register",
      "status",
    ]);
    yield* Deferred.succeed(harness.engineRelease, undefined);
    yield* awaitStage(Fiber.join(registering), "registration");
  });

/** The JSON-RPC error code that refuses a subscription before the protocol is up. */
const NOT_REGISTERED_ERROR_CODE = -32012;

/** The method of the SDK's first frame on a tool list change stream. */
const LISTEN_ACKNOWLEDGED_METHOD = "notifications/subscriptions/acknowledged";

/** The notification a host hears when the tool list changes. */
const TOOL_LIST_CHANGED_METHOD = "notifications/tools/list_changed";

/**
 * A host listening for tool list changes before registration hears that the
 * list changed once registration brings the protocol up. Fails when the
 * catalog changes without the notice, so a host holding the
 * pre-registration list never learns of the new tools.
 */
const announcesTheToolListChangeAtActivation = () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    const harness = yield* makeHarness(fixture, "none");
    yield* Effect.forkScoped(run(fixture, makeStore(fixture, false), harness));
    yield* awaitStage(Deferred.await(harness.listenerReady), "listener");
    const reader = yield* openStream(
      requireHandler(harness),
      makeToolListChangesRequest("tool-list-changes"),
    );
    const acknowledged = yield* awaitFrame(reader, "listen acknowledgment");

    yield* awaitStage(
      requireOperations(harness).register(fixture.registerRequest),
      "registration",
    );
    const changed = yield* awaitFrame(reader, "tool list change");

    expect(acknowledged, "listen acknowledgment").toMatchObject({
      method: LISTEN_ACKNOWLEDGED_METHOD,
      params: { notifications: { toolsListChanged: true } },
    });
    expect(changed, "notice after activation").toMatchObject({
      method: TOOL_LIST_CHANGED_METHOD,
    });
  });

/**
 * The inbox subscription needs the protocol: before registration it is
 * refused as not registered, and once registration brings the protocol up
 * the same handler acknowledges it. Fails when the gate is dropped, or reads
 * a protocol state captured when the handler was built.
 */
const refusesTheInboxStreamUntilTheProtocolIsUp = () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    const harness = yield* makeHarness(fixture, "none");
    yield* Effect.forkScoped(run(fixture, makeStore(fixture, false), harness));
    yield* awaitStage(Deferred.await(harness.listenerReady), "listener");
    const handler = requireHandler(harness);

    const refused = yield* fetchJson(
      handler,
      makeListenRequest("before-registration"),
    );
    yield* awaitStage(
      requireOperations(harness).register(fixture.registerRequest),
      "registration",
    );
    const reader = yield* openStream(
      handler,
      makeListenRequest("after-registration"),
    );
    const acknowledged = yield* awaitFrame(reader, "inbox acknowledgment");

    expect(refused, "subscription before registration").toMatchObject({
      error: { code: NOT_REGISTERED_ERROR_CODE },
    });
    expect(acknowledged, "subscription after registration").toMatchObject({
      method: SUBSCRIPTIONS_ACKNOWLEDGED_NOTIFICATION,
    });
  });

/** A fault a daemon hits, and the phase the daemon stops in. */
interface DaemonFault {
  readonly fault: string;
  readonly store: (store: DaemonStore) => DaemonStore;
  readonly harness: (harness: RuntimeHarness) => RuntimeHarness;
  readonly phase: DaemonRuntimeError["phase"];
}

/** A fault one activation hits, and how register fails. */
interface ActivationFault extends DaemonFault {
  readonly registerFailure: unknown;
}

const engineDefect = new Error("engine construction defect");

/**
 * Faults a registration's activation hits after the binding commits. A
 * typed failure gives register its closed reason; a defect has none, so
 * register dies with it. The runtime annotates a defect with its span on a
 * copy, so the defect row matches the message. Each one stops the daemon, in
 * the phase its cause belongs to.
 */
const routerUnreachable: ActivationFault = {
  fault: "cannot reach the Router",
  store: (store) => store,
  harness: (harness) => ({
    ...harness,
    dependencies: {
      ...harness.dependencies,
      makeWorker: () => Effect.fail(new RouterWorkerTransportError()),
    },
  }),
  registerFailure: { reason: "dependency-unavailable" },
  phase: "listener",
};

const activationFaults: readonly ActivationFault[] = [
  {
    fault: "cannot recover its store",
    store: (store) => ({
      ...store,
      recover: () =>
        Effect.fail(new EndpointStoreError({ reason: "persistence" })),
    }),
    harness: (harness) => harness,
    registerFailure: { reason: "persistence-failed" },
    phase: "storage",
  },
  routerUnreachable,
  {
    fault: "dies constructing the engine",
    store: (store) => store,
    harness: (harness) => ({
      ...harness,
      dependencies: {
        ...harness.dependencies,
        makeEngine: () => Effect.die(engineDefect),
      },
    }),
    registerFailure: expect.objectContaining({
      message: engineDefect.message,
    }),
    phase: "storage",
  },
];

/**
 * A registration whose activation hits `fault` fails register with the
 * row's failure and stops the daemon in the row's phase, since the binding
 * is durable and the daemon cannot serve it without a protocol. Fails when
 * a failure or defect leaves the daemon running, reporting active with no
 * protocol.
 */
const stopsWhenActivationFails = (row: ActivationFault) =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    const harness = row.harness(yield* makeHarness(fixture, "none"));
    const daemon = yield* Effect.forkScoped(
      run(fixture, row.store(makeStore(fixture, false)), harness),
    );
    yield* awaitStage(Deferred.await(harness.listenerReady), "listener");

    const registerFailure = yield* awaitStage(
      requireOperations(harness)
        .register(fixture.registerRequest)
        .pipe(Effect.sandbox, Effect.flip, Effect.map(Cause.squash)),
      "registration failure",
    );
    const stopped = yield* awaitStage(
      Effect.flip(Fiber.join(daemon)),
      "daemon failure",
    );

    expect(registerFailure, "register failure").toEqual(row.registerFailure);
    expect(stopped.phase, "phase the daemon stopped in").toBe(row.phase);
  });

/**
 * Startup registration whose activation cannot reach the Router, once the
 * binding commits, stops startup in the activation's phase rather than the
 * registration phase.
 */
const stopsStartupRegistrationInTheActivationPhase = () =>
  Effect.gen(function* () {
    const base = yield* makeFixture;
    const fixture = {
      ...base,
      bootstrap: {
        ...base.bootstrap,
        configuration: {
          ...base.bootstrap.configuration,
          registration: base.registerRequest,
        },
      },
    };
    const harness = routerUnreachable.harness(
      yield* makeHarness(fixture, "none"),
    );

    const stopped = yield* run(
      fixture,
      makeStore(fixture, false),
      harness,
    ).pipe(Effect.flip);

    expect(stopped.phase).toBe(routerUnreachable.phase);
  });

/** A listener the operating system refused to open. */
class ListenerUnavailableError extends Data.TaggedError(
  "ListenerUnavailableError",
) {}

/**
 * Faults a registered daemon's startup hits. A store fault in its first
 * delivery pass, a stored membership row that fails verification, or a
 * defect while its protocol activates, stops startup in storage before it
 * tries the listener; a listener that cannot open stops it in the listener
 * phase.
 */
const startupFaults: readonly DaemonFault[] = [
  {
    fault: "classified inbox persistence fails",
    store: (store) => ({
      ...store,
      putInboxItem: () =>
        Effect.fail(new EndpointStoreError({ reason: "persistence" })),
    }),
    harness: (harness) => harness,
    phase: "storage",
  },
  {
    fault: "the engine construction dies",
    store: (store) => store,
    harness: (harness) => ({
      ...harness,
      dependencies: {
        ...harness.dependencies,
        makeEngine: () => Effect.die(engineDefect),
      },
    }),
    phase: "storage",
  },
  {
    fault: "a stored membership fails verification",
    store: (store) => ({
      ...store,
      recover: () =>
        store.recover().pipe(
          Effect.map((recovery) => ({
            ...recovery,
            memberships: [
              {
                conversationId: digest("cnv_", 9),
                membershipHash: digest("mbr_", 9),
                canonicalMembership: Uint8Array.of(0x7b, 0x7d),
              },
            ],
          })),
        ),
    }),
    harness: (harness) => harness,
    phase: "storage",
  },
  {
    fault: "the listener cannot open",
    store: (store) => store,
    harness: (harness) => ({
      ...harness,
      dependencies: {
        ...harness.dependencies,
        acquireListener: () => Effect.fail(new ListenerUnavailableError()),
      },
    }),
    phase: "listener",
  },
];

/**
 * A registered daemon whose startup hits a fault fails in that phase
 * instead of carrying on past it.
 */
const failsStartupWith = (row: DaemonFault) =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    const harness = row.harness(yield* makeHarness(fixture, "none"));

    const error = yield* run(
      fixture,
      row.store(makeStore(fixture, true)),
      harness,
    ).pipe(Effect.flip);

    expect(error.phase, "phase startup failed in").toBe(row.phase);
  });

/** A daemon started unregistered, registered once, then registered again. */
const registerTwice = (fixture: Fixture, harness: RuntimeHarness) =>
  Effect.gen(function* () {
    yield* Effect.forkScoped(
      run(fixture, makeStore(fixture, false, harness.delivery), harness),
    );
    yield* awaitStage(Deferred.await(harness.listenerReady), "listener");
    const operations = requireOperations(harness);
    const first = yield* awaitStage(
      operations.register(fixture.registerRequest),
      "first registration",
    );
    const retried = yield* awaitStage(
      operations.register(fixture.registerRequest),
      "retried registration",
    );
    return { first, retried };
  });

/** A registration returns the bound card and its view; a retry returns the same result. */
const returnsTheCardAndItsViewToARegister = () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    const harness = yield* makeHarness(fixture, "none");

    const { first, retried } = yield* registerTwice(fixture, harness);

    expect(first).toEqual({
      kind: "registered",
      agentCard: yield* Schema.encode(AgentCard)(fixture.localCard),
      agent: {
        agentId: fixture.localCard.agentId,
        agentName: fixture.localCard.agentName,
        principalId: fixture.localCard.principalId,
      },
    });
    expect(retried).toEqual(first);
  });

/** A successful registration can be retried while its inbox remains usable. */
const keepsTheInboxUsableAcrossARetriedRegister = () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    const harness = yield* makeHarness(fixture, "none");

    yield* registerTwice(fixture, harness);

    const handler = requireHandler(harness);
    expect(yield* readInboxThroughMcp(handler)).toEqual([
      fixture.pending.deliveryToken,
    ]);
    yield* fetchJson(
      handler,
      makeToolCallRequest({
        id: "acknowledge-after-register-retry",
        name: "acknowledge_delivery",
        toolArguments: { deliveryToken: fixture.pending.deliveryToken },
      }),
    );
    expect(yield* readInboxThroughMcp(handler)).toEqual([]);
  });

/** The listener exposes the registered catalog only after startup activates the endpoint. */
const registersBeforeListening = (active: boolean) =>
  Effect.gen(function* () {
    const base = yield* makeFixture;
    const fixture = {
      ...base,
      bootstrap: {
        ...base.bootstrap,
        configuration: {
          ...base.bootstrap.configuration,
          registration: {
            ...base.registerRequest,
            agentName: active
              ? Schema.decodeUnknownSync(AgentName)("different-agent")
              : base.registerRequest.agentName,
          },
        },
      },
    };
    const harness = yield* makeHarness(fixture, "none");
    const store = makeStore(fixture, active);
    yield* Effect.forkScoped(run(fixture, store, harness));
    yield* awaitStage(
      Deferred.await(harness.listenerReady),
      "registered listener",
    );
    expect(yield* requireOperations(harness).readStatus()).toMatchObject({
      kind: "active",
      agentCard: yield* Schema.encode(AgentCard)(fixture.localCard),
    });
    expect((yield* store.readIdentity())?.agentId).toBe(
      fixture.localCard.agentId,
    );
  });

/** A Registry refusal ends startup rather than exposing an unregistered listener. */
const failsStartupRegistration = (reason: "name_taken" | "admission-refused") =>
  Effect.gen(function* () {
    const base = yield* makeFixture;
    const fixture = {
      ...base,
      bootstrap: {
        ...base.bootstrap,
        configuration: {
          ...base.bootstrap.configuration,
          registration: {
            ...base.registerRequest,
          },
        },
      },
    };
    const harness = yield* makeHarness(fixture, "none");
    const failure = yield* Effect.flip(
      run(fixture, makeStore(fixture, false), harness, reason),
    );
    expect(failure).toEqual(
      new DaemonRuntimeError({ phase: "registration", reason }),
    );
  });

describe("daemon runtime composition", () => {
  it("registers and activates before listening", () =>
    registersBeforeListening(false));
  it("retains an active registration at startup", () =>
    registersBeforeListening(true));
  it.each(["name_taken", "admission-refused"] as const)(
    "fails startup with %s when registration cannot complete",
    failsStartupRegistration,
  );
  it(
    "closes after fatal persistence with a receipt waiting for the delivery gate",
    closesWhileReceiptWaitsOnFailedPersistence,
  );
  it(
    "settles registration when its first delivery pass fails",
    settlesRegistrationWhenThePassFails,
  );
  it("opens the configured history export", opensConfiguredHistoryExport);
  it(
    "waits for the active engine and supervises the Router worker",
    blocksStartupAndSupervisesWorker,
  );
  it(
    "does not finish registration before engine activation",
    blocksRegistrationAndSupervisesOutbound,
  );
  it(
    "replays durable deliveries until acknowledgment",
    replaysUntilAcknowledged,
  );
});

describe("daemon activation", () => {
  it(
    "lists the post-registration tools after a cancelled register activates",
    listsToolsAfterACancelledRegister,
  );
  it(
    "offers only register and status until the protocol is up",
    holdsTheCatalogWhileTheProtocolActivates,
  );
  it(
    "tells a listening host the tool list changed once the protocol is up",
    announcesTheToolListChangeAtActivation,
  );
  it(
    "refuses an inbox subscription until the protocol is up",
    refusesTheInboxStreamUntilTheProtocolIsUp,
  );
  it.each(activationFaults)(
    "stops the daemon when activation $fault",
    stopsWhenActivationFails,
  );
  it(
    "fails startup registration in the listener phase when activation cannot reach the Router",
    stopsStartupRegistrationInTheActivationPhase,
  );
  it.each(startupFaults)(
    "fails a registered startup in phase $phase when $fault",
    failsStartupWith,
  );
  it(
    "returns the bound card and its view to a register, and the same result to its retry",
    returnsTheCardAndItsViewToARegister,
  );
  it(
    "keeps the inbox usable when a register is retried",
    keepsTheInboxUsableAcrossARetriedRegister,
  );
});
