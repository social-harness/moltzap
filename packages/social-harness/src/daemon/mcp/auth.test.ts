/** @file Runtime credentials cannot expose collective protocol history or owner tools. */

import type { ClientOptions } from "@modelcontextprotocol/client";
import { scopedLive as it } from "@effect/vitest";
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import { Effect, Redacted, Schema } from "effect";
import { describe, expect } from "vitest";
import type { EventStore } from "../../host-protocol/operations.js";
import { digest } from "../../__tests__/agent-card-fixtures.js";
import { connectInProcessClient } from "../../__tests__/mcp-http-fixtures.js";
import { makeFixture } from "../../__tests__/router-worker-fixtures.js";
import { stateDirectory } from "../../__tests__/store-schema-fixtures.js";
import {
  enqueue,
  input,
  scriptedWebhook,
} from "../../__tests__/webhook-fixtures.js";
import { openEndpointStore } from "../../communication/store/index.js";
import { AgentCard, agentViewOf } from "../../identity/cards.js";
import { LIVE_WIRE_VERSIONS } from "../../identity/wire-version.js";
import {
  type HarnessMcpOperations,
  makeHarnessMcpHttpHandler,
} from "./tools.js";

/* eslint-disable agent-code-guard/no-hardcoded-assertion-literals -- HTTP and JSON-RPC codes are external conformance expectations. */

const credentials = {
  runtime: Redacted.make("runtime-secret-for-local-test-0001"),
  owner: Redacted.make("owner-secret-for-local-test-00001"),
};
const info = { name: "local-dot-qualification", version: "1" };
const unreachable = () =>
  Effect.dieMessage("unauthorized tool reached its operation");
/** Policy operations fail when a test unexpectedly reaches the implementation. */
const unreachablePolicy: NonNullable<HarnessMcpOperations["policy"]> = {
  read: unreachable,
  update: unreachable,
  decisions: unreachable,
};
/**
 * A 2025-11-25 client: the SDK pins only 2026-07-28 and later, so this one
 * runs the `initialize` handshake offering and accepting only 2025-11-25.
 */
const OLDER_CLIENT: ClientOptions = {
  versionNegotiation: { mode: "legacy" },
  supportedProtocolVersions: ["2025-11-25"],
};
const operations: HarnessMcpOperations = {
  readEvent: () => Effect.fail({ reason: "unknown-event" }),
  protocolActive: () => false,
  readStatus: () => Effect.succeed({ kind: "unregistered" }),
  register: unreachable,
  searchAgents: () => Effect.succeed({ kind: "not_found" }),
  searchConversations: unreachable,
  readConversation: unreachable,
  send: unreachable,
  readInbox: () => Effect.succeed({ items: [] }),
  readInboxSummary: () =>
    Effect.succeed({ pendingCount: 0, newestSequence: 0 }),
  acknowledgeDelivery: unreachable,
};
const eventStore: EventStore = {
  readEventState: () => Effect.succeed(undefined),
  writeEventState: () => Effect.void,
  readInbox: unreachable,
  readInboxItem: () => Effect.succeed(undefined),
  readInboxSummary: () =>
    Effect.succeed({ pendingCount: 0, newestSequence: 0 }),
  completeWebhookDelivery: () => Effect.void,
};
type RequestParams = Readonly<Record<string, unknown>> &
  Partial<Record<"_meta", Readonly<Record<string, unknown>>>>;
const makeRequest = (
  method: string,
  params: RequestParams,
  credential: string,
) =>
  new Request("http://127.0.0.1/mcp", {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-method": method,
      ...(typeof params.name === "string" ? { "mcp-name": params.name } : {}),
      ...(credential === "" ? {} : { authorization: `Bearer ${credential}` }),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: {
        ...params,
        _meta: {
          ...params._meta,
          [CLIENT_INFO_META_KEY]: info,
          [CLIENT_CAPABILITIES_META_KEY]: {},
          [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
        },
      },
    }),
  });
const toolNames = Schema.parseJson(
  Schema.Struct({
    result: Schema.Struct({
      tools: Schema.Array(Schema.Struct({ name: Schema.String })),
    }),
  }),
);
const responseBody = (response: Response) =>
  Effect.tryPromise(() => response.text());

type Handler = Effect.Effect.Success<
  ReturnType<typeof makeHarnessMcpHttpHandler>
>;
const request = (
  handler: Handler,
  method: string,
  params: RequestParams,
  credential: Redacted.Redacted,
) =>
  Effect.tryPromise(() =>
    handler.fetch(makeRequest(method, params, Redacted.value(credential))),
  ).pipe(Effect.flatMap(responseBody));
const decodeJson = Schema.decodeUnknown(Schema.parseJson(Schema.Unknown));
const noCredential = Redacted.make("");
const deniedTools = [
  "read_inbox",
  "acknowledge_delivery",
  "read_conversation",
  "search_conversations",
  "status",
  "register",
  "event_subscription_status",
  "revoke_event_subscription",
  "resume_event_subscription",
];
const rejectedBearers = [
  { bearer: "no", credential: "" },
  { bearer: "a wrong", credential: "wrong" },
];
const unknownEvent = {
  name: "read_event",
  arguments: { eventId: digest("evt_", 1) },
};

/** The tools each credential role sees, sorted, before and after registration. */
const registrationStates = [
  {
    state: "unregistered",
    registered: false,
    runtimeTools: [],
    ownerTools: [
      "event_subscription_status",
      "register",
      "resume_event_subscription",
      "revoke_event_subscription",
      "status",
    ],
    localTools: ["register", "status"],
  },
  {
    state: "registered",
    registered: true,
    runtimeTools: ["read_event", "search_agents", "send_message"],
    ownerTools: [
      "acknowledge_delivery",
      "event_subscription_status",
      "read_conversation",
      "read_event",
      "read_inbox",
      "resume_event_subscription",
      "revoke_event_subscription",
      "search_agents",
      "search_conversations",
      "send_message",
      "status",
    ],
    localTools: [
      "acknowledge_delivery",
      "read_conversation",
      "read_event",
      "read_inbox",
      "search_agents",
      "search_conversations",
      "send_message",
      "status",
    ],
  },
];

/**
 * A handler for a daemon in the given registration state. With `credentials`
 * it authenticates runtime and owner bearers and serves webhook events;
 * without them every request is local. With `policy` it serves the firewall's
 * policy tools.
 */
const acquireHandler = (
  registered: boolean,
  access: Pick<
    Parameters<typeof makeHarnessMcpHttpHandler>[0],
    "credentials" | "eventStore"
  >,
  policy?: HarnessMcpOperations["policy"],
) =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    const agentCard = yield* Schema.encode(AgentCard)(fixture.localCard);
    const handler = yield* makeHarnessMcpHttpHandler({
      implementation: info,
      ...access,
      operations: {
        ...operations,
        policy,
        protocolActive: () => registered,
        readStatus: () =>
          Effect.succeed(
            registered
              ? {
                  kind: "active",
                  agentCard,
                  agent: agentViewOf(fixture.localCard),
                }
              : { kind: "unregistered" },
          ),
      },
    });
    yield* Effect.addFinalizer(() =>
      Effect.tryPromise(() => handler.close()).pipe(Effect.ignore),
    );
    return handler;
  });

const credentialedHandler = (registered: boolean) =>
  acquireHandler(registered, { credentials, eventStore });

const firewallHandler = (registered: boolean) =>
  acquireHandler(registered, { credentials, eventStore }, unreachablePolicy);

/**
 * Given a handler from `given`, run `when` against it and check its result
 * with `then`.
 */
const verify = <A, E, R>(
  given: ReturnType<typeof credentialedHandler>,
  when: (handler: Handler) => Effect.Effect<A, E, R>,
  then: (result: A) => void,
) => given.pipe(Effect.flatMap(when), Effect.map(then));

const callTool = (
  handler: Handler,
  params: RequestParams,
  credential: Redacted.Redacted,
) =>
  request(handler, "tools/call", params, credential).pipe(
    Effect.flatMap(decodeJson),
  );

const sortedNames = (tools: ReadonlyArray<{ readonly name: string }>) =>
  tools
    .map((tool) => tool.name)
    .sort((left, right) => left.localeCompare(right));

const listTools = (handler: Handler, credential: Redacted.Redacted) =>
  request(handler, "tools/list", {}, credential).pipe(
    Effect.flatMap(Schema.decodeUnknown(toolNames)),
    Effect.map((catalog) => sortedNames(catalog.result.tools)),
  );

/** A 2025-11-25 client of `handler` that sends `credential` as its bearer. */
const connectOlderClient = (
  handler: Handler,
  credential: Redacted.Redacted,
) => {
  const bearer = Redacted.value(credential);
  return connectInProcessClient(
    handler,
    OLDER_CLIENT,
    bearer === "" ? {} : { authorization: `Bearer ${bearer}` },
  );
};

/** The tool names a 2025-11-25 client of `handler` lists with `credential`, sorted. */
const listToolsAsOlderClient = (
  handler: Handler,
  credential: Redacted.Redacted,
) =>
  connectOlderClient(handler, credential).pipe(
    Effect.flatMap((client) => Effect.tryPromise(() => client.listTools())),
    Effect.map((catalog) => sortedNames(catalog.tools)),
  );

/** The failure a 2025-11-25 client of `handler` meets calling `name` with `credential`. */
const refusedCallAsOlderClient = (
  handler: Handler,
  name: string,
  credential: Redacted.Redacted,
) =>
  connectOlderClient(handler, credential).pipe(
    Effect.flatMap((client) =>
      Effect.tryPromise({
        try: () => client.callTool({ name, arguments: {} }),
        catch: (cause) => cause,
      }),
    ),
    Effect.flip,
  );

const responseStatus = (
  handler: Handler,
  method: string,
  params: RequestParams,
  credential: string,
) =>
  Effect.tryPromise(() =>
    handler.fetch(makeRequest(method, params, credential)),
  ).pipe(Effect.map((response) => response.status));

// @agent-code-guard/regression-only: direct calls and discovery must enforce the same authority before and after registration.
describe.each(registrationStates)(
  "runtime tool authority for a daemon that is $state",
  ({ registered, runtimeTools }) => {
    it.each(rejectedBearers)(
      "refuses discovery with $bearer bearer",
      ({ credential }) =>
        verify(
          credentialedHandler(registered),
          (handler) =>
            responseStatus(handler, "server/discover", {}, credential),
          (status) => {
            expect(status).toBe(401);
          },
        ),
    );

    it("lists exactly the runtime tools to the runtime credential", () =>
      verify(
        credentialedHandler(registered),
        (handler) => listTools(handler, credentials.runtime),
        (names) => {
          expect(names).toEqual(runtimeTools);
        },
      ));

    it.each(deniedTools)(
      "refuses the runtime credential a call to %s",
      (name) =>
        verify(
          credentialedHandler(registered),
          (handler) =>
            callTool(handler, { name, arguments: {} }, credentials.runtime),
          (body) => {
            expect(body).toMatchObject({
              error: { code: -32602, message: `Tool ${name} not found` },
            });
          },
        ),
    );
  },
);

// @agent-code-guard/regression-only: a 2025-11-25 client must meet the same bearer authority as a 2026-07-28 one.
describe.each(registrationStates)(
  "runtime tool authority over MCP 2025-11-25 for a daemon that is $state",
  ({ registered, runtimeTools }) => {
    it("refuses a client with no bearer", () =>
      verify(
        firewallHandler(registered),
        (handler) =>
          connectOlderClient(handler, noCredential).pipe(Effect.flip),
        (refused) => {
          expect(refused).toMatchObject({ data: { status: 401 } });
        },
      ));

    it("lists exactly the runtime tools to the runtime credential", () =>
      verify(
        firewallHandler(registered),
        (handler) => listToolsAsOlderClient(handler, credentials.runtime),
        (names) => {
          expect(names).toEqual(
            registered ? ["policy_update", ...runtimeTools] : runtimeTools,
          );
        },
      ));

    it("refuses the runtime credential a call to policy_read", () =>
      verify(
        firewallHandler(registered),
        (handler) =>
          refusedCallAsOlderClient(handler, "policy_read", credentials.runtime),
        (refused) => {
          expect(refused).toMatchObject({
            code: -32602,
            message: "Tool policy_read not found",
          });
        },
      ));
  },
);

describe.each(registrationStates)(
  "runtime event authority for a daemon that is $state",
  ({ registered }) => {
    it("lists the polling and webhook item event to the runtime credential", () =>
      verify(
        credentialedHandler(registered),
        (handler) =>
          request(handler, "events/list", {}, credentials.runtime).pipe(
            Effect.flatMap(decodeJson),
          ),
        (catalog) => {
          expect(catalog).toMatchObject({
            result: {
              events: [
                {
                  name: "org.social-harness/inbox.item",
                  delivery: ["poll", "webhook"],
                },
              ],
            },
          });
        },
      ));

    it("refuses the runtime credential a native inbox stream", () =>
      verify(
        credentialedHandler(registered),
        (handler) =>
          request(
            handler,
            "events/stream",
            { name: "org.social-harness/inbox.pending", arguments: {} },
            credentials.runtime,
          ).pipe(Effect.flatMap(decodeJson)),
        (refused) => {
          expect(refused).toMatchObject({
            error: { code: -32014, data: { feature: "stream" } },
          });
        },
      ));
  },
);

describe.each(registrationStates)(
  "owner and local authority for a daemon that is $state",
  ({ registered, ownerTools, localTools }) => {
    it("lets the owner credential read the event subscription status", () =>
      verify(
        credentialedHandler(registered),
        (handler) =>
          callTool(
            handler,
            { name: "event_subscription_status", arguments: {} },
            credentials.owner,
          ),
        (body) => {
          expect(body).toMatchObject({
            result: { structuredContent: { mode: "none" } },
          });
        },
      ));

    it("lists exactly the owner tools to the owner credential", () =>
      verify(
        credentialedHandler(registered),
        (handler) => listTools(handler, credentials.owner),
        (names) => {
          expect(names).toEqual(ownerTools);
        },
      ));

    it("lists exactly the local tools to an unauthenticated local handler", () =>
      verify(
        acquireHandler(registered, {}),
        (handler) => listTools(handler, noCredential),
        (names) => {
          expect(names).toEqual(localTools);
        },
      ));
  },
);

/**
 * Calls a non-runtime catalog does not list, by caller and registration
 * state. Each named tool reaches an operation or event that would answer if
 * it were admitted, so only admission yields "not found".
 */
const unlistedCalls = [
  {
    caller: "the local handler",
    state: "unregistered",
    name: "read_inbox",
    given: () => acquireHandler(false, {}),
    credential: noCredential,
  },
  {
    caller: "the local handler",
    state: "unregistered",
    name: "event_subscription_status",
    given: () => acquireHandler(false, {}),
    credential: noCredential,
  },
  {
    caller: "the local handler",
    state: "registered",
    name: "register",
    given: () => acquireHandler(true, {}),
    credential: noCredential,
  },
  {
    caller: "the local handler",
    state: "registered",
    name: "resume_event_subscription",
    given: () => acquireHandler(true, {}),
    credential: noCredential,
  },
  {
    caller: "the owner credential",
    state: "unregistered",
    name: "search_agents",
    given: () => credentialedHandler(false),
    credential: credentials.owner,
  },
  {
    caller: "the owner credential",
    state: "unregistered",
    name: "read_inbox",
    given: () => credentialedHandler(false),
    credential: credentials.owner,
  },
  {
    caller: "the owner credential",
    state: "registered",
    name: "register",
    given: () => credentialedHandler(true),
    credential: credentials.owner,
  },
];

// @agent-code-guard/regression-only: admission must refuse exactly what the caller's catalog does not list.
describe("calls a caller's catalog does not list", () => {
  it.each(unlistedCalls)(
    "refuses $caller a call to $name while $state",
    ({ name, given, credential }) =>
      verify(
        given(),
        (handler) => callTool(handler, { name, arguments: {} }, credential),
        (body) => {
          expect(body).toMatchObject({
            error: { code: -32602, message: `Tool ${name} not found` },
          });
        },
      ),
  );
});

/**
 * Calls a registered daemon's catalog lists, each with arguments only its own
 * tool accepts and the answer only its own operation gives.
 */
const admittedCalls = [
  {
    caller: "the runtime credential",
    name: "search_agents",
    toolArguments: { agentName: "bob" },
    credential: credentials.runtime,
    answer: { kind: "not_found" },
  },
  {
    caller: "the owner credential",
    name: "read_inbox",
    toolArguments: {},
    credential: credentials.owner,
    answer: { items: [] },
  },
];

/**
 * A store holding a runtime webhook subscription whose callback rejected an
 * inbox item terminally with 410 Gone, which only an owner revoke clears.
 */
const terminallyStalledWebhookStore = Effect.gen(function* () {
  const store = yield* openEndpointStore(stateDirectory(), {
    liveWireVersions: LIVE_WIRE_VERSIONS,
  });
  const callback = scriptedWebhook(store);
  const webhook = yield* callback.acquire;
  yield* webhook.subscribe(input, "runtime");
  yield* enqueue(store, 1, "rejected by the callback");
  callback.status(410);
  yield* webhook.observe();
  return store;
});

/**
 * Through its tools, the owner credential is refused a resume of a terminally
 * stalled webhook subscription and then revokes the subscription, reading it
 * before and after.
 */
const ownerResumeIsRefusedThenRevokeRetiresAStalledWebhook = () =>
  Effect.gen(function* () {
    const store = yield* terminallyStalledWebhookStore;
    const handler = yield* acquireHandler(true, {
      credentials,
      eventStore: store,
    });
    const ownerCall = (name: string) =>
      callTool(handler, { name, arguments: {} }, credentials.owner);

    const stalled = yield* ownerCall("event_subscription_status");
    const resumed = yield* ownerCall("resume_event_subscription");
    const revoked = yield* ownerCall("revoke_event_subscription");
    const retired = yield* ownerCall("event_subscription_status");

    expect(stalled).toMatchObject({
      result: {
        structuredContent: { mode: "webhook", stalled: "terminal" },
      },
    });
    expect(resumed).toMatchObject({ error: { code: -32014 } });
    expect(revoked).toHaveProperty("result.structuredContent", {});
    expect(retired).toHaveProperty("result.structuredContent", {
      mode: "none",
    });
  });

// @agent-code-guard/regression-only: each admitted tool must reach the operation its name documents.
describe("calls a caller's catalog lists", () => {
  // Value: protects=runtime search_agents and owner read_inbox answer from their own operations; fails_when=the tool dispatch keys either name to another handler or operation; why_new=the other read_inbox and search_agents tests stop at input decoding or call the operations object directly; seam=none
  it.each(admittedCalls)(
    "answers $name for $caller from its operation",
    ({ name, toolArguments, credential, answer }) =>
      verify(
        credentialedHandler(true),
        (handler) =>
          callTool(handler, { name, arguments: toolArguments }, credential),
        (body) => {
          expect(body).toHaveProperty("result.structuredContent", answer);
        },
      ),
  );

  // Value: protects=owner resume refuses a terminal stall and owner revoke retires the webhook subscription; fails_when=revoke_event_subscription or resume_event_subscription runs another event operation or none; why_new=webhook.test drives revoke and resume on the webhook object, not through the MCP tool dispatch; seam=none
  it(
    "refuses the owner a resume of a terminally stalled webhook subscription and lets it revoke the subscription",
    ownerResumeIsRefusedThenRevokeRetiresAStalledWebhook,
  );
});

describe("tunneled MCP event reads for a registered daemon", () => {
  it.each(rejectedBearers)(
    "refuses read_event with $bearer bearer",
    ({ credential }) =>
      verify(
        credentialedHandler(true),
        (handler) =>
          responseStatus(handler, "tools/call", unknownEvent, credential),
        (status) => {
          expect(status).toBe(401);
        },
      ),
  );

  it("reports an unknown event to the runtime credential", () =>
    verify(
      credentialedHandler(true),
      (handler) => callTool(handler, unknownEvent, credentials.runtime),
      (body) => {
        expect(body).toMatchObject({
          error: { data: { reason: "unknown-event" } },
        });
      },
    ));
});

/* eslint-enable agent-code-guard/no-hardcoded-assertion-literals -- Restore repository defaults. */

const normEdit = {
  name: "policy_update",
  arguments: {
    add: [
      {
        id: "shared",
        kind: "norm",
        text: "Confirm before booking.",
        guidance: "Confirm first.",
      },
    ],
  },
};

it.each(["modern", "legacy"] as const)(
  "assigns norm-edit authority from the bearer over %s MCP",
  (version) =>
    Effect.gen(function* () {
      const authorities: string[] = [];
      const handler = yield* acquireHandler(
        true,
        { credentials, eventStore },
        {
          ...unreachablePolicy,
          update: (change, authority) =>
            Effect.sync(() => {
              authorities.push(`${authority}:${change.add?.length ?? 0}`);
              return { activeRevision: "a".repeat(64) };
            }),
        },
      );
      const params = normEdit;
      for (const credential of [credentials.runtime, credentials.owner]) {
        if (version === "modern") {
          const response = yield* callTool(handler, params, credential);
          expect(response).toHaveProperty(
            "result.structuredContent.activeRevision",
          );
        } else {
          const client = yield* connectOlderClient(handler, credential);
          yield* Effect.tryPromise(() => client.callTool(params));
        }
      }
      expect(authorities).toEqual(["runtime:1", "owner:1"]);
      yield* refusedPolicyReads(handler);
      expect(
        yield* callTool(
          handler,
          { ...params, arguments: { ...params.arguments, authority: "owner" } },
          credentials.runtime,
        ),
      ).toMatchObject({ error: { code: -32602 } });
      expect(authorities).toHaveLength(2);
    }),
);

function refusedPolicyReads(handler: Handler) {
  return Effect.gen(function* () {
    for (const name of [
      "policy_read",
      "firewall_decisions",
      "read_conversation",
      "search_conversations",
    ]) {
      expect(
        yield* callTool(handler, { name, arguments: {} }, credentials.runtime),
      ).toMatchObject({ error: { code: -32602 } });
    }
  });
}
