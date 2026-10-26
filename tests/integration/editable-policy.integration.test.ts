/** @file Owner policy changes through a running public daemon and its MCP boundary. */

import { FileSystem } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {
  Daemon,
  type DecisionProvider,
  type DecisionRequest,
  type MessageMiddleware,
} from "@moltzap/social-harness/service";
import {
  ConfigProvider,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Schedule,
  Schema,
} from "effect";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  acquireDaemonManagementClient,
  acquireDaemonProcess,
  acquireProcessInfrastructure,
  type DaemonProcessFixture,
  makeDaemonProcessFixture,
  makeRegistrationRequest,
  processTrace,
} from "./daemon-process-harness.js";
import {
  anyNumber,
  anyString,
  arrayContaining,
  objectContaining,
} from "./test-matchers.js";

const pair = Effect.gen(function* () {
  const infrastructure = yield* acquireProcessInfrastructure;
  const alice = yield* makeDaemonProcessFixture(infrastructure, "alice");
  const bob = yield* makeDaemonProcessFixture(infrastructure, "bob");
  yield* acquireDaemonProcess(bob);
  const management = yield* acquireDaemonManagementClient(bob.endpoint);
  yield* management.register(makeRegistrationRequest(bob));
  return { alice, bob };
});

const settings = {
  timeoutMilliseconds: 10000,
  middlewareTimeoutMilliseconds: 8000,
  maximumInputBytes: 1000000,
  maximumResultBytes: 1000000,
};

const provider: DecisionProvider = {
  decide: (request) => Effect.succeed(answer(request)),
};

const options: Daemon.FirewallOptions = {
  mode: "enforcement",
  incoming: [],
  outgoing: [],
  settings,
  facts: [],
  codeDigest: "a".repeat(64),
  english: {
    provider,
    settings: {
      minimumProbability: 0.5,
      maximumRequestBytes: 1000000,
      timeoutMilliseconds: 5000,
    },
  },
};

const readSchema = Schema.Struct({
  rules: Schema.Array(Schema.Struct({ id: Schema.String })),
  fixedRules: Schema.Array(Schema.Unknown),
  activeRevision: Schema.String,
});

const read = (client: Client) =>
  call(client, "policy_read").pipe(
    Effect.flatMap(Schema.decodeUnknown(readSchema)),
  );

const updateSchema = Schema.Struct({
  activeRevision: Schema.String,
  retroactive: Schema.Literal(false),
});

const update = (client: Client, args: Readonly<Record<string, unknown>>) =>
  call(client, "policy_update", args).pipe(
    Effect.flatMap(Schema.decodeUnknown(updateSchema)),
  );

const secretText = "private candidate never returned by the decisions feed";

const send = (client: Client) =>
  call(client, "send_message", {
    input: { to: "agent:bob", text: secretText },
  });

const blockedRule = {
  id: "private",
  kind: "safety",
  text: "Never disclose private text.",
} as const;

interface PolicyRevisions {
  readonly before: { readonly activeRevision: string };
  readonly changed: {
    readonly activeRevision: string;
    readonly retroactive: boolean;
  };
}

interface FixedPolicyScenario {
  readonly client: Client;
  readonly codeRule: {
    readonly id: string;
    readonly kind: "safety";
    readonly guidance: string;
  };
  readonly middleware: MessageMiddleware;
}

const acquirePolicyCheckScenario = Effect.gen(function* () {
  const { alice } = yield* pair;
  const entered = yield* Deferred.make<undefined>();
  const release = yield* Deferred.make<undefined>();
  const middleware: MessageMiddleware = {
    id: "code",
    revision: "1",
    rules: [{ id: "fixed-code", kind: "safety" }],
    check: () =>
      Deferred.succeed(entered, undefined).pipe(
        Effect.zipRight(Deferred.await(release)),
        Effect.as({
          findings: [{ ruleId: "fixed-code", outcome: "pass" }],
          expectations: [],
        }),
      ),
  };
  yield* start(alice, {
    ...options,
    outgoing: [middleware],
  });
  const client = yield* connect(alice.endpoint);
  yield* register(client, alice);
  return { entered, release, client };
});

const fixedRule = {
  id: "owner",
  kind: "norm",
  text: "Follow the owner.",
  guidance: "Ask the owner.",
} as const;

const acquireFixedPolicyScenario = Effect.gen(function* () {
  const { alice } = yield* pair;
  const codeRule = {
    id: "no-links",
    kind: "safety",
    guidance: "Send the page title instead of the link.",
  } as const;
  const middleware: MessageMiddleware = {
    id: "links",
    revision: "1",
    rules: [codeRule],
    check: () =>
      Effect.succeed({
        findings: [{ ruleId: codeRule.id, outcome: "pass" }],
        expectations: [],
      }),
  };
  yield* start(alice, {
    ...options,
    incoming: [middleware],
    outgoing: [middleware],
    english: {
      provider,
      settings: {
        minimumProbability: 0.5,
        maximumRequestBytes: 1000000,
        timeoutMilliseconds: 5000,
      },
      fixedRules: [fixedRule],
    },
  });
  const client = yield* connect(alice.endpoint);
  yield* register(client, alice);
  return { codeRule, middleware, client };
});

const decisionsSchema = Schema.Struct({
  decisions: Schema.Array(
    Schema.Struct({
      checkId: Schema.String,
      time: Schema.Number,
      direction: Schema.String,
      peerAgentId: Schema.NullOr(Schema.String),
      outcome: Schema.String,
      cause: Schema.String,
      decidedBy: Schema.Array(
        Schema.Struct({ ruleId: Schema.String, from: Schema.String }),
      ),
      checkedRuleIds: Schema.Array(Schema.String),
      activeRevision: Schema.String,
    }),
  ),
});

const swapDuringCheck = Effect.gen(function* () {
  const scenario = yield* acquirePolicyCheckScenario;
  const { client, entered } = scenario;
  const before = yield* read(client);
  expect(
    yield* update(client, { remove: ["fixed-code"] }).pipe(Effect.isFailure),
  ).toBe(true);
  const inFlight = yield* send(client).pipe(Effect.forkScoped);
  yield* Deferred.await(entered);
  const changed = yield* update(client, { add: [blockedRule] });
  expect(changed.activeRevision).not.toBe(before.activeRevision);
  expect(changed.retroactive).toBe(false);
  yield* Deferred.succeed(scenario.release, undefined);
  yield* Fiber.join(inFlight);
  yield* expectPolicyRevisionsInDecisionFeed(client, { before, changed });
  expect(
    yield* call(client, "firewall_decisions", {
      since: Number.MAX_SAFE_INTEGER,
    }),
  ).toEqual({ decisions: [], activations: [] });
});

const persistAndValidate = Effect.gen(function* () {
  const { alice } = yield* pair;
  const fixedOptions = {
    ...options,
    english: {
      ...options.english,
      provider,
      settings: {
        minimumProbability: 0.5,
        maximumRequestBytes: 1000000,
        timeoutMilliseconds: 5000,
      },
      fixedRules: [fixedRule],
    },
  };
  const runtime = yield* start(alice, fixedOptions);
  const client = yield* connect(alice.endpoint);
  yield* register(client, alice);
  const changed = yield* update(client, { add: [blockedRule] });
  expect(
    yield* update(client, { remove: [fixedRule.id] }).pipe(Effect.isFailure),
  ).toBe(true);
  expect(
    yield* update(client, { add: [{ ...blockedRule, id: fixedRule.id }] }).pipe(
      Effect.isFailure,
    ),
  ).toBe(true);
  expect(
    yield* update(client, {
      add: [{ id: "invalid", kind: "norm", text: "Missing guidance" }],
    }).pipe(Effect.isFailure),
  ).toBe(true);
  expect(yield* read(client)).toMatchObject({
    activeRevision: changed.activeRevision,
    fixedRules: arrayContaining([{ from: "english", ...fixedRule }]),
    rules: [{ id: blockedRule.id }],
  });
  expect(yield* send(client).pipe(Effect.isFailure)).toBe(true);
  yield* Fiber.interrupt(runtime);
  const restarted = yield* start(alice, fixedOptions);
  const fresh = yield* connect(alice.endpoint);
  expect(yield* read(fresh)).toMatchObject({
    activeRevision: changed.activeRevision,
    rules: [{ id: blockedRule.id }],
  });
  expect(yield* send(fresh).pipe(Effect.isFailure)).toBe(true);
  yield* update(fresh, { remove: [blockedRule.id] });
  yield* send(fresh);
  yield* Fiber.interrupt(restarted);
});

const readFixed = acquireFixedPolicyScenario.pipe(
  Effect.flatMap(expectFixedPolicyCannotBeEdited),
);

const concurrentEdits = Effect.gen(function* () {
  const { alice } = yield* pair;
  const runtime = yield* start(alice, options);
  const client = yield* connect(alice.endpoint);
  yield* register(client, alice);
  const additions = [
    fixedRule,
    { ...fixedRule, id: "second" },
    { ...fixedRule, id: "third" },
  ];
  yield* Effect.forEach(additions, (rule) => update(client, { add: [rule] }), {
    concurrency: 4,
  });
  const before = yield* read(client);
  expect(before.rules.map((rule) => rule.id)).toEqual(
    arrayContaining(additions.map((rule) => rule.id)),
  );
  yield* send(client);
  yield* Fiber.interrupt(runtime);
  yield* start(alice, options);
  const fresh = yield* connect(alice.endpoint);
  expect(yield* read(fresh)).toEqual(before);
});

const consecutiveActivations = Effect.gen(function* () {
  const { alice } = yield* pair;
  const runtime = yield* start(alice, options);
  const client = yield* connect(alice.endpoint);
  yield* register(client, alice);
  const before = yield* read(client);
  const first = yield* update(client, { add: [blockedRule] });
  const second = yield* update(client, {
    remove: [blockedRule.id],
    add: [fixedRule],
  });
  expect(first.activeRevision).not.toBe(before.activeRevision);
  expect(second.activeRevision).not.toBe(first.activeRevision);
  const feed = yield* call(client, "firewall_decisions");
  const expected = [
    {
      time: anyNumber,
      activeRevision: second.activeRevision,
      addedRuleIds: [fixedRule.id],
      removedRuleIds: [blockedRule.id],
    },
    {
      time: anyNumber,
      activeRevision: first.activeRevision,
      addedRuleIds: [blockedRule.id],
      removedRuleIds: [],
    },
  ];
  expect(feed).toEqual({ decisions: [], activations: expected });
  yield* Fiber.interrupt(runtime);
  yield* start(alice, options);
  const fresh = yield* connect(alice.endpoint);
  expect(yield* call(fresh, "firewall_decisions")).toEqual(feed);
});

const tunnelAuthority = Effect.gen(function* () {
  const { alice } = yield* pair;
  const fs = yield* FileSystem.FileSystem;
  const ownerToken = "owner-test-token-".repeat(3);
  const runtimeToken = "runtime-test-token-".repeat(3);
  const ownerPath = join(alice.stateDirectory, "owner-token");
  const runtimePath = join(alice.stateDirectory, "runtime-token");
  yield* fs.writeFileString(ownerPath, ownerToken);
  yield* fs.writeFileString(runtimePath, runtimeToken);
  yield* start(alice, options, {
    SHARNESS_MCP_RUNTIME_CREDENTIAL_FILE: runtimePath,
    SHARNESS_MCP_OWNER_CREDENTIAL_FILE: ownerPath,
  });
  const owner = yield* connect(alice.endpoint, ownerToken);
  yield* register(owner, alice);
  const runtime = yield* connect(alice.endpoint, runtimeToken);
  const catalog = yield* Effect.tryPromise(() => runtime.listTools());
  expect(catalog.tools).not.toContainEqual(
    objectContaining({ name: "policy_read" }),
  );
  expect(catalog.tools).not.toContainEqual(
    objectContaining({ name: "policy_update" }),
  );
  expect(catalog.tools).not.toContainEqual(
    objectContaining({ name: "firewall_decisions" }),
  );
  expect(yield* call(runtime, "policy_read").pipe(Effect.isFailure)).toBe(true);
  expect(
    yield* call(runtime, "policy_update", { add: [blockedRule] }).pipe(
      Effect.isFailure,
    ),
  ).toBe(true);
  expect(
    yield* call(runtime, "firewall_decisions").pipe(Effect.isFailure),
  ).toBe(true);
  yield* update(owner, { add: [blockedRule] });
  expect((yield* read(owner)).rules).toEqual([{ id: blockedRule.id }]);
});

describe("editable firewall through the daemon public API", () => {
  it(
    "swaps at the next check while retaining an in-flight decision and both decision revisions",
    processTrace(
      Effect.scoped(swapDuringCheck).pipe(Effect.provide(NodeContext.layer)),
    ),
    60000,
  );
  it(
    "rejects invalid and fixed edits and restores active policy after restart",
    processTrace(persistAndValidate.pipe(Effect.provide(NodeContext.layer))),
    60000,
  );
  it(
    "returns fixed English text and code rule descriptions and refuses to edit them",
    processTrace(readFixed.pipe(Effect.provide(NodeContext.layer))),
    60000,
  );
  it(
    "serializes concurrent additions without losing rules across restart",
    processTrace(concurrentEdits.pipe(Effect.provide(NodeContext.layer))),
    60000,
  );
  it(
    "retains consecutive activations with no intervening messages in the feed",
    processTrace(
      consecutiveActivations.pipe(Effect.provide(NodeContext.layer)),
    ),
    60000,
  );
  it(
    "exposes policy management only to owner authority in tunnel mode",
    processTrace(tunnelAuthority.pipe(Effect.provide(NodeContext.layer))),
    60000,
  );
});

function expectPolicyRevisionsInDecisionFeed(
  client: Client,
  { before, changed }: PolicyRevisions,
) {
  return Effect.gen(function* () {
    expect(yield* send(client).pipe(Effect.isFailure)).toBe(true);
    const raw = yield* call(client, "firewall_decisions");
    expect(JSON.stringify(raw)).not.toContain(secretText);
    expect(JSON.stringify(raw)).not.toContain(blockedRule.text);
    const feed = yield* Schema.decodeUnknown(decisionsSchema)(raw);
    expect(feed.decisions).toEqual(
      arrayContaining([
        objectContaining({
          activeRevision: before.activeRevision,
          outcome: "allow",
          direction: "outgoing",
          cause: "default",
          decidedBy: [],
        }),
        objectContaining({
          activeRevision: changed.activeRevision,
          outcome: "block",
          cause: "judgment",
          decidedBy: arrayContaining([
            { ruleId: blockedRule.id, from: "editable" },
          ]),
          checkedRuleIds: arrayContaining(["fixed-code", blockedRule.id]),
        }),
      ]),
    );
    expect(
      feed.decisions.every((decision) =>
        decision.peerAgentId?.startsWith("agt_"),
      ),
    ).toBe(true);
  });
}

function expectFixedPolicyCannotBeEdited(state: FixedPolicyScenario) {
  return Effect.gen(function* () {
    const { codeRule, middleware, client } = state;
    const policy = yield* call(client, "policy_read");
    const removeCode = yield* call(client, "policy_update", {
      remove: [codeRule.id],
    }).pipe(Effect.flip);
    const replaceEnglish = yield* call(client, "policy_update", {
      add: [{ ...blockedRule, id: fixedRule.id }],
    }).pipe(Effect.flip);
    expect(policy).toEqual({
      rules: [],
      fixedRules: arrayContaining([
        objectContaining({
          from: "code",
          middleware: middleware.id,
          ...codeRule,
        }),
        objectContaining({ from: "english", ...fixedRule }),
      ]),
      activeRevision: anyString,
    });
    expect(removeCode.cause).toMatchObject({ data: { reason: "fixed-rule" } });
    expect(replaceEnglish.cause).toMatchObject({
      data: { reason: "fixed-rule" },
    });
    expect(yield* call(client, "policy_read")).toEqual(policy);
  });
}

function answer(request: DecisionRequest) {
  return {
    provider: "fixture",
    model: "deterministic",
    usage: {},
    raw: secretText,
    answers: Object.fromEntries(
      Object.entries(request.questions).map(([id, question]) => {
        const selected =
          request.stage === "safety" && question.ruleId === blockedRule.id
            ? "prohibited"
            : (["compliant", "autonomous", "none", "relevant"].find((choice) =>
                Object.hasOwn(question.criteria, choice),
              ) ?? "unresolved");
        return [
          id,
          {
            choice: selected,
            probabilities: Object.fromEntries(
              Object.keys(question.criteria).map((choice) => [
                choice,
                choice === selected ? 1 : 0,
              ]),
            ),
          },
        ];
      }),
    ),
  };
}

function start(
  fixture: DaemonProcessFixture,
  policy: Daemon.FirewallOptions,
  extra: Readonly<Record<string, string>> = {},
) {
  return Layer.launch(Daemon.withFirewall(policy)).pipe(
    Effect.withConfigProvider(
      ConfigProvider.fromMap(
        new Map(Object.entries({ ...fixture.environment, ...extra })),
      ),
    ),
    Effect.forkScoped,
  );
}

function connect(endpoint: URL, bearer?: string) {
  return Effect.gen(function* () {
    const client = new Client(
      { name: "policy-test", version: "1" },
      { capabilities: {}, versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    yield* Effect.acquireRelease(
      Effect.tryPromise(() =>
        client.connect(
          new StreamableHTTPClientTransport(
            endpoint,
            bearer === undefined
              ? {}
              : {
                  requestInit: {
                    headers: { authorization: `Bearer ${bearer}` },
                  },
                },
          ),
        ),
      ).pipe(
        Effect.retry(
          Schedule.intersect(
            Schedule.spaced("25 millis"),
            Schedule.recurs(200),
          ),
        ),
      ),
      () => Effect.tryPromise(() => client.close()).pipe(Effect.ignore),
    );
    return client;
  });
}

function register(client: Client, fixture: DaemonProcessFixture) {
  return call(client, "register", { ...makeRegistrationRequest(fixture) });
}

function call(
  client: Client,
  name: string,
  args: Readonly<Record<string, unknown>> = {},
) {
  return Effect.tryPromise(() =>
    client.callTool({ name, arguments: args }),
  ).pipe(Effect.map((result) => result.structuredContent));
}
