/** @file Pins Events discovery and failure isolation through loopback HTTP. */

import {
  mcpTestCredential,
  mcpTestHeaders,
} from "../../__tests__/mcp-http-fixtures.js";
import type { Implementation } from "@modelcontextprotocol/server";
import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { scopedLive as it } from "@effect/vitest";
import {
  Client,
  fromJsonSchema,
  type JsonSchemaType,
  ProtocolError,
  ProtocolErrorCode,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Schema,
  Scope,
  Stream,
} from "effect";
import {
  Agent,
  type Dispatcher,
  getGlobalDispatcher,
  MockAgent,
  setGlobalDispatcher,
} from "undici";
import { describe, expect } from "vitest";
import { digest, testAgentView } from "../../__tests__/agent-card-fixtures.js";
import { collectiveOperationId } from "../../__tests__/collective-id-fixtures.js";
import { requestId } from "../../__tests__/collective-operation-fixtures.js";
import { localGuidance } from "../../__tests__/message-policy-fixtures.js";
import {
  CollectiveError,
  CollectiveId,
  SendInput,
} from "../../communication/collectives/contracts.js";
import {
  ListenError,
  SendError,
} from "../../communication/conversations/errors.js";
import {
  DeliveryToken,
  encodeRuntimeValue,
} from "../../communication/store/index.js";
import { acquireHarnessEndpoint } from "../../host-client/index.js";
import { FirewallSendError } from "../../host-protocol/advice.js";
import { InboundItem } from "../../host-protocol/items.js";
import {
  HARNESS_SEND_TOOL,
  INBOX_PENDING_EVENT,
} from "../../host-protocol/names.js";
import {
  type SendResult,
  SendResultSchema,
} from "../../host-protocol/send-result.js";
import { LIVE_WIRE_VERSIONS } from "../../identity/wire-version.js";
import { readRuntimeEvent } from "../inbox/inbox.js";
import { openDaemonStore } from "../store.js";
import { acquireHarnessMcpHttpServer } from "./http.js";
import {
  type HarnessMcpOperations,
  makeHarnessMcpHttpHandler,
} from "./tools.js";

const MODERN_PROTOCOL_VERSION = "2026-07-28";
const IMPLEMENTATION = {
  name: "harness-boundary-test",
  version: "1.0.0",
} satisfies Implementation;
const PRIVATE_STATUS_DEFECT = "private status defect";

const unusedOperation = Effect.dieMessage("operation is outside this test");
const operations: HarnessMcpOperations = {
  protocolActive: () => false,
  readEvent: () => Effect.fail({ reason: "unknown-event" }),
  readInboxSummary: () =>
    Effect.succeed({ pendingCount: 0, newestSequence: 0 }),
  readInbox: () => Effect.succeed({ items: [] }),
  readStatus: () => Effect.succeed({ kind: "unregistered" }),
  register: () => unusedOperation,
  searchConversations: () => unusedOperation,
  readConversation: () => unusedOperation,
  send: () => unusedOperation,
  acknowledgeDelivery: () => unusedOperation,
};

function acquireBoundaryServer(
  selectedOperations: HarnessMcpOperations,
  onSubscriptionActiveChange?: (active: boolean) => void,
  keepAliveMillis?: number,
) {
  return Effect.gen(function* () {
    const handler = yield* makeHarnessMcpHttpHandler({
      credential: mcpTestCredential,
      implementation: IMPLEMENTATION,
      operations: selectedOperations,
      ...(onSubscriptionActiveChange === undefined
        ? {}
        : { onSubscriptionActiveChange }),
      keepAliveMillis,
    });
    const server = yield* acquireHarnessMcpHttpServer({ port: 0, handler });
    const address = server.address();
    const port =
      typeof address === "object" && address !== null ? address.port : 0;
    return { port, server };
  });
}

function acquireProtocolClient(port: number, name: string) {
  // eslint-disable-next-line agent-code-guard/acquire-release-requires-scope -- scopedLive's `it` supplies the test scope that releases it.
  return Effect.acquireRelease(
    Effect.gen(function* () {
      const client = new Client(
        { name, version: "1.0.0" },
        {
          capabilities: {},
          versionNegotiation: { mode: { pin: MODERN_PROTOCOL_VERSION } },
        },
      );
      yield* Effect.tryPromise({
        try: (signal) =>
          client.connect(
            new StreamableHTTPClientTransport(
              new URL(`http://127.0.0.1:${port}/mcp`),
              { requestInit: { headers: mcpTestHeaders } },
            ),
            { signal },
          ),
        catch: (cause) => cause,
      });
      return client;
    }),
    (client) => Effect.tryPromise(() => client.close()).pipe(Effect.ignore),
  );
}

function capturesProtocolError(
  client: Client,
  toolArguments: Readonly<Record<string, unknown>>,
) {
  return Effect.tryPromise({
    try: (signal) =>
      client.callTool({ name: "status", arguments: toolArguments }, { signal }),
    catch: (cause) => cause,
  }).pipe(
    Effect.match({
      onFailure: (cause) => cause,
      onSuccess: () => new Error("status unexpectedly succeeded"),
    }),
  );
}

function advertisesEventsBeforeRegistration() {
  return Effect.gen(function* () {
    const { port } = yield* acquireBoundaryServer(operations);
    const client = yield* acquireProtocolClient(
      port,
      "harness-capability-client",
    );
    const capabilities = yield* Effect.tryPromise(() =>
      client.request(
        { method: "events/list", params: {} },
        fromJsonSchema<{ events: unknown[] }>({
          type: "object",
          properties: { events: { type: "array" } },
          required: ["events"],
        }),
      ),
    );

    const pushDelivery: unknown = expect.arrayContaining(["push"]);
    expect(capabilities.events).toContainEqual(
      expect.objectContaining({
        name: INBOX_PENDING_EVENT,
        delivery: pushDelivery,
      }),
    );
  });
}

function distinguishesProtocolAndDomainFailures() {
  return Effect.gen(function* () {
    const failingOperations: HarnessMcpOperations = {
      ...operations,
      readStatus: () => Effect.fail({ reason: "incompatible-daemon" }),
    };
    const { port } = yield* acquireBoundaryServer(failingOperations);
    const client = yield* acquireProtocolClient(
      port,
      "harness-boundary-client",
    );
    const privateInput = "private-status-input";
    const [malformedCause, domainCause] = yield* Effect.all(
      [
        capturesProtocolError(client, { unexpected: privateInput }),
        capturesProtocolError(client, {}),
      ],
      { concurrency: 1 },
    );

    expect(ProtocolError.isInstance(malformedCause)).toBe(true);
    expect(ProtocolError.isInstance(domainCause)).toBe(true);
    if (
      !ProtocolError.isInstance(malformedCause) ||
      !ProtocolError.isInstance(domainCause)
    ) {
      throw new Error("expected protocol errors from both calls");
    }
    expect(malformedCause).toMatchObject({
      code: ProtocolErrorCode.InvalidParams,
      data: {
        issues: [{ path: ["unexpected"], message: "Unexpected field" }],
      },
    });
    expect(JSON.stringify(malformedCause.data)).not.toContain(privateInput);
    expect(domainCause).toMatchObject({
      code: ProtocolErrorCode.InternalError,
      data: { reason: "incompatible-daemon" },
    });
  });
}

/**
 * A status failure outside the status vocabulary, such as
 * `persistence-failed`, which other owner tools admit, reaches the owner as
 * `incompatible-daemon`. A failure the vocabulary admits cannot show this,
 * because the fallback reason equals the one admitted reason.
 */
function reportsOutsideVocabularyStatusFailure() {
  return Effect.gen(function* () {
    const failingOperations: HarnessMcpOperations = {
      ...operations,
      readStatus: () => Effect.fail({ reason: "persistence-failed" }),
    };
    const { port } = yield* acquireBoundaryServer(failingOperations);
    const client = yield* acquireProtocolClient(
      port,
      "harness-status-vocabulary-client",
    );
    const cause = yield* capturesProtocolError(client, {});

    expect(cause).toMatchObject({
      code: ProtocolErrorCode.InternalError,
      data: { reason: "incompatible-daemon" },
    });
  });
}

function sanitizesUnexpectedOperationDefects() {
  return Effect.gen(function* () {
    const defectiveOperations: HarnessMcpOperations = {
      ...operations,
      readStatus: () => Effect.dieMessage(PRIVATE_STATUS_DEFECT),
    };
    const { port } = yield* acquireBoundaryServer(defectiveOperations);
    const client = yield* acquireProtocolClient(port, "harness-defect-client");
    const cause = yield* capturesProtocolError(client, {});

    expect(ProtocolError.isInstance(cause)).toBe(true);
    if (!ProtocolError.isInstance(cause)) {
      throw new Error("expected a sanitized defect response");
    }
    expect(cause).toMatchObject({
      code: ProtocolErrorCode.InternalError,
      data: { reason: "incompatible-daemon" },
    });
    expect(String(cause)).not.toContain(PRIVATE_STATUS_DEFECT);
  });
}

function reportsUnexpectedSubscriptionLoss() {
  return Effect.gen(function* () {
    const { server, receive } = yield* observeListeningSubscription();
    yield* Effect.sync(() => {
      server.closeAllConnections();
    });
    const result = yield* Fiber.join(receive).pipe(
      Effect.timeoutFail({
        duration: Duration.seconds(5),
        onTimeout: () => new Error("message stream did not observe disconnect"),
      }),
    );

    expect(result).toBeInstanceOf(ListenError);
    expect(result).toMatchObject({ reason: "transport-failed" });
  });
}

function keepsIdleSubscriptionAlive() {
  return Effect.gen(function* () {
    expect(yield* idleSubscriptionOutcome(100)).toEqual({ dropped: false });
  });
}

function losesIdleSubscriptionWithoutKeepAlive() {
  return Effect.gen(function* () {
    const outcome = yield* idleSubscriptionOutcome(60_000);
    expect(outcome).toMatchObject({
      dropped: true,
      cause: { reason: "transport-failed" },
    });
    expect(outcome.dropped ? outcome.cause : undefined).toBeInstanceOf(
      ListenError,
    );
  });
}

/**
 * Node's fetch aborts a silent response body after its body timeout (300 s
 * by default). The test compresses that to 1 s: an idle subscription with
 * keep-alive frames outlives three seconds of silence, one without them
 * fails as transport-failed. The undici devDependency is pinned to the
 * version Node bundles (`process.versions.undici`), because only that version
 * shares the global-dispatcher symbol Node's own fetch reads; if the two
 * diverge, the control test below fails instead of passing vacuously.
 */
function idleSubscriptionOutcome(keepAliveMillis: number) {
  return Effect.gen(function* () {
    yield* routeRequestsThrough(new Agent({ bodyTimeout: 1000 }));
    const { receive } = yield* observeListeningSubscription(keepAliveMillis);
    return yield* Fiber.join(receive).pipe(
      Effect.timeoutTo({
        duration: Duration.seconds(3),
        onTimeout: () => ({ dropped: false as const }),
        onSuccess: (cause) => ({ dropped: true as const, cause }),
      }),
    );
  });
}

/** A boundary server with one endpoint listening on it, and the fiber observing that stream's end. */
function observeListeningSubscription(keepAliveMillis?: number) {
  return Effect.gen(function* () {
    const subscriptionActive = yield* Deferred.make<undefined>();
    const { port, server } = yield* acquireBoundaryServer(
      { ...operations, protocolActive: () => true },
      (active) => {
        if (active) {
          Effect.runSync(Deferred.succeed(subscriptionActive, undefined));
        }
      },
      keepAliveMillis,
    );
    const endpoint = yield* acquireHarnessEndpoint(
      new URL(`http://127.0.0.1:${port}/mcp`),
      { credential: mcpTestCredential, receiveMode: "push" },
    );
    const receive = yield* endpoint.messages.pipe(
      Stream.runHead,
      Effect.match({
        onFailure: (cause) => cause,
        onSuccess: () =>
          new Error("message stream ended without a transport failure"),
      }),
      Effect.forkScoped,
    );
    yield* Deferred.await(subscriptionActive);
    return { server, receive };
  });
}

const sendInput = Schema.decodeUnknownSync(SendInput)({
  to: "agent:bob",
  text: "one semantic action",
});
const sendResult = Schema.decodeUnknownSync(SendResultSchema)({
  kind: "multicast",
  msgId: digest("msg_", 8),
  address: "agent:bob",
});

const SENDS_WITH_GUIDANCE: readonly SendResult[] = [
  { ...sendResult, guidance: localGuidance(14) },
  Schema.decodeUnknownSync(SendResultSchema)({
    kind: "response",
    msgId: digest("msg_", 15),
    address: "agent:bob",
    operationId: collectiveOperationId(
      testAgentView("agent:alice").agentId,
      16,
    ),
    guidance: localGuidance(15),
  }),
  {
    kind: "collective",
    operationId: collectiveOperationId(
      testAgentView("agent:alice").agentId,
      16,
    ),
    guidance: localGuidance(16),
  },
];

function preservesAdmittedSendGuidance(result: SendResult) {
  return Effect.gen(function* () {
    const endpoint = yield* acquireSendEndpoint({
      protocolActive: () => true,
      send: () => Effect.succeed(result),
    });

    expect(yield* endpoint.send(sendInput)).toEqual(result);
  });
}

/**
 * Bounds a hang in a boundary trace that starts servers and endpoints and
 * makes MCP requests one after another; no assertion depends on it. The
 * send-validation trace starts three servers and three endpoints and, as the
 * file's first, pays the MCP and endpoint stack's warm-up: it took 1.4 to
 * 5.2 s at a load average of 30 to 42 on 8 cores. The bookkeeping trace's
 * sequential requests took 2.6 to 4.6 s there. Both have timed out at the
 * 5 s default.
 */
const MCP_TRACE_TIMEOUT_MS = 30_000;

const distinguishesSendValidationFailures = () =>
  Effect.gen(function* () {
    const inactive = yield* acquireSendEndpoint(operations);
    expect(yield* inactive.send(sendInput).pipe(Effect.flip)).toMatchObject({
      reason: "outcome-unknown",
    });
    const refused = yield* acquireSendEndpoint({
      ...operations,
      protocolActive: () => true,
      send: () => Effect.fail(new SendError({ reason: "not-registered" })),
    });
    expect(yield* refused.send(sendInput).pipe(Effect.flip)).toMatchObject({
      reason: "not-registered",
    });
    const invalidOutput = yield* acquireSendEndpoint({
      ...operations,
      protocolActive: () => true,
      send: () =>
        Effect.succeed({
          kind: "collective",
          operationId: Schema.decodeUnknownSync(CollectiveId)(
            `col_${"A".repeat(64)}`,
          ),
          unexpected: true,
        }),
    });
    expect(
      yield* invalidOutput.send(sendInput).pipe(Effect.flip),
    ).toMatchObject({
      reason: "outcome-unknown",
    });
  });

const carriesARefusalDetailAcrossTheDaemonBoundary = (
  refusal: SendError | CollectiveError,
) =>
  Effect.gen(function* () {
    const endpoint = yield* acquireSendEndpoint({
      ...operations,
      protocolActive: () => true,
      send: () => Effect.fail(refusal),
    });

    const error = yield* endpoint.send(sendInput).pipe(Effect.flip);

    expect(error.message).toBe(refusal.message);
    expect(error).toStrictEqual(refusal);
  });

/** Refusals name a send's failure, the openOperationIds of an answer that named no request, or the questions open in other conversations. */
const DETAILED_REFUSALS = [
  new SendError({
    reason: "content-invalid",
    detail: "the answer does not match the requested form",
  }),
  new SendError({
    reason: "unknown-agent",
    detail: "agent:dana is not a known agent",
  }),
  new CollectiveError({
    operationId: Schema.decodeUnknownSync(CollectiveId)(
      `col_${"A".repeat(64)}`,
    ),
    failure: { kind: "request-expired" },
  }),
];

const carriesDeliveryPendingAcrossTheDaemonBoundary = () =>
  Effect.gen(function* () {
    const pending = new SendError({ reason: "delivery-pending" });
    const endpoint = yield* acquireSendEndpoint({
      ...operations,
      protocolActive: () => true,
      send: () => Effect.fail(pending),
    });

    const error = yield* endpoint.send(sendInput).pipe(Effect.flip);

    expect(error).toStrictEqual(pending);
  });

const answersOutcomeUnknownForAnUntypedSendFailure = () =>
  Effect.gen(function* () {
    const endpoint = yield* acquireSendEndpoint({
      ...operations,
      protocolActive: () => true,
      send: () => Effect.dieMessage("send defect"),
    });

    const error = yield* endpoint.send(sendInput).pipe(Effect.flip);

    expect(error).toStrictEqual(new SendError({ reason: "outcome-unknown" }));
  });

const reportsOutcomeUnknownWhenTheConnectionDropsMidSend = () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<undefined>();
    const { port, server } = yield* acquireBoundaryServer({
      ...operations,
      protocolActive: () => true,
      send: () =>
        Deferred.succeed(started, undefined).pipe(
          Effect.zipRight(Effect.never),
        ),
    });
    const endpoint = yield* acquireHarnessEndpoint(
      new URL(`http://127.0.0.1:${port}/mcp`),
      { credential: mcpTestCredential, receiveMode: "push" },
    );
    const sending = yield* Effect.fork(
      endpoint.send(sendInput).pipe(Effect.flip),
    );
    yield* Deferred.await(started);

    server.closeAllConnections();

    expect(yield* Fiber.join(sending)).toStrictEqual(
      new SendError({ reason: "outcome-unknown" }),
    );
  });

/**
 * Route this scope's requests through `dispatcher`, then restore the previous
 * global dispatcher and close this one.
 * @param dispatcher The undici dispatcher the MCP client's fetch uses.
 * @returns The scoped routing.
 */
function routeRequestsThrough(dispatcher: Dispatcher) {
  // eslint-disable-next-line agent-code-guard/acquire-release-requires-scope -- scopedLive's `it` supplies the test scope that releases it.
  return Effect.acquireRelease(
    Effect.sync(() => {
      const previous = getGlobalDispatcher();
      setGlobalDispatcher(dispatcher);
      return previous;
    }),
    (previous) =>
      Effect.sync(() => {
        setGlobalDispatcher(previous);
      }).pipe(
        Effect.zipRight(
          Effect.tryPromise({
            try: () => dispatcher.close(),
            catch: (cause) => cause,
          }),
        ),
        Effect.orDie,
      ),
  );
}

/**
 * A dispatcher that answers the next `send_message` POST with `status` before
 * it reaches the daemon and passes every other request through.
 * @param status The HTTP status the daemon's HTTP layer seems to answer.
 * @returns The dispatcher.
 */
function answerSendWithStatus(status: number): MockAgent {
  const agent = new MockAgent();
  agent.enableNetConnect();
  agent
    .get(/^http:\/\/127\.0\.0\.1:\d+$/)
    .intercept({
      path: "/mcp",
      method: "POST",
      body: (body) => body.includes(`"${HARNESS_SEND_TOOL}"`),
    })
    .reply(status, "refused");
  return agent;
}

const rpcCallSchema = Schema.parseJson(
  Schema.Struct({ id: Schema.Union(Schema.String, Schema.Number) }),
);

function answerSendWithMessage(
  message: Readonly<Record<string, unknown>>,
): MockAgent {
  const agent = new MockAgent();
  agent.enableNetConnect();
  agent
    .get(/^http:\/\/127\.0\.0\.1:\d+$/)
    .intercept({
      path: "/mcp",
      method: "POST",
      body: (body) => body.includes(`"${HARNESS_SEND_TOOL}"`),
    })
    .reply(
      200,
      ({ body }) => ({
        jsonrpc: "2.0",
        id: Schema.decodeUnknownSync(rpcCallSchema)(body).id,
        ...message,
      }),
      { headers: { "content-type": "application/json" } },
    );
  return agent;
}

function reportsAmbiguousSendAnswer(
  message: Readonly<Record<string, unknown>>,
) {
  return Effect.gen(function* () {
    const endpoint = yield* acquireSendEndpoint({
      protocolActive: () => true,
      send: () => Effect.succeed(sendResult),
    });
    yield* routeRequestsThrough(answerSendWithMessage(message));

    const error = yield* endpoint.send(sendInput).pipe(Effect.flip);

    expect(error).toStrictEqual(new SendError({ reason: "outcome-unknown" }));
  });
}

const AMBIGUOUS_SEND_ANSWERS = [
  {
    name: "a JSON-RPC error without refusal data",
    message: { error: { code: -32602, message: "Invalid completed result" } },
  },
  {
    name: "a JSON-RPC error with malformed refusal data",
    message: {
      error: { code: -32602, message: "Invalid completed result", data: false },
    },
  },
  {
    name: "a JSON-RPC error with an unknown refusal reason",
    message: {
      error: {
        code: -32603,
        message: "Unrecognized failure",
        data: { reason: "unrecognized-failure" },
      },
    },
  },
  {
    name: "an untyped tool error",
    message: { result: { content: [], isError: true } },
  },
  {
    name: "a malformed successful result",
    message: {
      result: {
        content: [],
        structuredContent: { kind: "collective", operationId: false },
      },
    },
  },
];

const classifiesAnHttpAnswerToASend = (
  status: number,
  reason: SendError["reason"],
) =>
  Effect.gen(function* () {
    const { port } = yield* acquireBoundaryServer({
      ...operations,
      protocolActive: () => true,
    });
    const endpoint = yield* acquireHarnessEndpoint(
      new URL(`http://127.0.0.1:${port}/mcp`),
      { credential: mcpTestCredential, receiveMode: "push" },
    );
    yield* routeRequestsThrough(answerSendWithStatus(status));

    const error = yield* endpoint.send(sendInput).pipe(Effect.flip);

    expect(error).toStrictEqual(new SendError({ reason }));
  });

/**
 * A send after the server closed. Its requests open one connection each, so
 * the send meets a refused connection rather than a pooled socket the server
 * closed, which the request may race.
 */
const keepsARefusedConnectionNetworkUnavailable = () =>
  Effect.gen(function* () {
    yield* routeRequestsThrough(new Agent({ pipelining: 0 }));
    const serverScope = yield* Scope.make();
    const { port } = yield* acquireBoundaryServer({
      ...operations,
      protocolActive: () => true,
    }).pipe(Scope.extend(serverScope));
    const endpoint = yield* acquireHarnessEndpoint(
      new URL(`http://127.0.0.1:${port}/mcp`),
      { credential: mcpTestCredential, receiveMode: "push" },
    );
    yield* Scope.close(serverScope, Exit.void);

    const error = yield* endpoint.send(sendInput).pipe(Effect.flip);

    expect(error).toStrictEqual(
      new SendError({ reason: "network-unavailable" }),
    );
  });

function acquireSendEndpoint(
  selected: Pick<HarnessMcpOperations, "protocolActive" | "send">,
) {
  return Effect.gen(function* () {
    const { port } = yield* acquireBoundaryServer({
      ...operations,
      ...selected,
    });
    return yield* acquireHarnessEndpoint(
      new URL(`http://127.0.0.1:${port}/mcp`),
      { credential: mcpTestCredential, receiveMode: "push" },
    );
  });
}

const invalidSendCalls = [
  { arguments: { input: sendInput, unexpected: true } },
  { arguments: { input: { to: "agent:bob", text: 1 } } },
];

const checksSemanticSendSchema = (client: Client) =>
  Effect.gen(function* () {
    const catalog = yield* Effect.tryPromise(() => client.listTools());
    const schema = catalog.tools.find(
      (tool) => tool.name === "send_message",
    )?.inputSchema;
    if (schema === undefined) {
      return yield* Effect.dieMessage("Expected the semantic send schema");
    }
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties ?? {})).toEqual(["input"]);
    const validator = fromJsonSchema(
      // eslint-disable-next-line agent-code-guard/require-assertion-rationale -- The real server emits JSONSchema.make output; the SDK catalog type widens its nested properties to JSON values.
      schema as JsonSchemaType,
    );
    for (const input of [
      {
        to: "group:alice,bob,carol",
        text: "Ready?",
        collective: {
          op: "gather",
          deadline: 600,
          requestedSchema: {
            type: "object",
            properties: { ready: { type: "boolean", default: false } },
            required: ["ready"],
          },
        },
      },
      {
        to: "agent:bob",
        collectiveResponse: {
          operationId: requestId,
          action: "accept",
          content: { ready: true },
        },
      },
    ]) {
      expect(
        yield* Effect.tryPromise(() =>
          Promise.resolve(validator["~standard"].validate({ input })),
        ),
      ).toHaveProperty("value");
    }
  });

/** Invalid model arguments fail before execution; unrelated SDK metadata remains transport-owned. */
function rejectsSendBookkeepingArguments() {
  return Effect.gen(function* () {
    const executed: unknown[] = [];
    const { port } = yield* acquireBoundaryServer({
      ...operations,
      protocolActive: () => true,
      send: (input) =>
        Effect.sync(() => {
          executed.push(input);
          return sendResult;
        }),
    });
    const client = yield* acquireProtocolClient(port, "semantic-send-client");
    yield* checksSemanticSendSchema(client);
    for (const call of invalidSendCalls) {
      const error = yield* Effect.tryPromise(() =>
        client.callTool({ name: "send_message", ...call }),
      ).pipe(Effect.flip);
      expect(error).toMatchObject({
        cause: { code: ProtocolErrorCode.InvalidParams },
      });
    }
    expect(executed).toEqual([]);
    yield* Effect.tryPromise(() =>
      client.callTool({
        name: "send_message",
        arguments: { input: sendInput },
        _meta: {
          "another.example/trace": { id: "independent" },
        },
      }),
    );
    expect(executed).toEqual([{ input: sendInput }]);
  });
}

function readsRetainedEventThroughSdk() {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const store = yield* openDaemonStore(yield* fs.makeTempDirectoryScoped(), {
      liveWireVersions: LIVE_WIRE_VERSIONS,
    });
    const deliveryToken = Schema.decodeUnknownSync(DeliveryToken)(
      digest("dlv_", 7),
    );
    const item = Schema.decodeUnknownSync(InboundItem)({
      kind: "operationFailed",
      operationId: collectiveOperationId(
        testAgentView("agent:alice").agentId,
        7,
      ),
      to: "agent:bob",
      error: "retained result",
    });
    const canonicalItem = yield* encodeRuntimeValue(item);
    const guidance = localGuidance(7);
    yield* store.putInboxItem({
      deliveryToken,
      canonicalItem,
      canonicalGuidance: yield* encodeRuntimeValue(guidance),
    });
    yield* store.acknowledgeInboxItem(deliveryToken);
    const { port } = yield* acquireBoundaryServer({
      ...operations,
      protocolActive: () => true,
      readEvent: ({ eventId }) => readRuntimeEvent(store, eventId),
    });
    const client = yield* acquireProtocolClient(port, "retained-event-client");
    const result = yield* Effect.tryPromise(() =>
      client.callTool({
        name: "read_event",
        arguments: { eventId: deliveryToken },
      }),
    );
    expect(result.structuredContent).toEqual({ item, guidance });
    expect((yield* store.readInboxSummary()).pendingCount).toBe(0);
  }).pipe(Effect.provide(NodeFileSystem.layer));
}

// @agent-code-guard/regression-only: this boundary pins the exact capability and closed transport failures.
describe("Harness MCP HTTP boundary", () => {
  it.each(SENDS_WITH_GUIDANCE)(
    "preserves admitted $kind identity and local guidance through MCP",
    preservesAdmittedSendGuidance,
  );
  it(
    "keeps dispatch and invalid output distinct from rejected send input",
    distinguishesSendValidationFailures,
    MCP_TRACE_TIMEOUT_MS,
  );
  it(
    "reads an acknowledged event with its guidance without redelivery",
    readsRetainedEventThroughSdk,
  );
  it(
    "rejects bookkeeping in model arguments and validates runtime metadata",
    rejectsSendBookkeepingArguments,
    MCP_TRACE_TIMEOUT_MS,
  );
  it(
    "advertises the event descriptor before registration",
    advertisesEventsBeforeRegistration,
  );
  it(
    "keeps malformed input separate from closed domain failures",
    distinguishesProtocolAndDomainFailures,
  );
  it(
    "reports a status failure outside its vocabulary as incompatible-daemon",
    reportsOutsideVocabularyStatusFailure,
  );
  it(
    "sanitizes unexpected operation defects",
    sanitizesUnexpectedOperationDefects,
  );
  it(
    "keeps an idle subscription alive past the fetch body timeout",
    keepsIdleSubscriptionAlive,
  );
  it(
    "loses an idle subscription to the fetch body timeout without keep-alive",
    losesIdleSubscriptionWithoutKeepAlive,
  );
  it(
    "reports an unexpected subscription disconnect",
    reportsUnexpectedSubscriptionLoss,
  );
});

function preservesFirewallRefusal() {
  return Effect.gen(function* () {
    const refusal = new FirewallSendError({
      checkId: `chk_${"1f".repeat(32)}`,
      refusal: "rule-violation",
      feedback: [{ nextAction: "revise", text: "Include Carol in the reply." }],
    });
    const endpoint = yield* acquireSendEndpoint({
      protocolActive: () => true,
      send: () => Effect.fail(refusal),
    });
    const error = yield* Effect.flip(endpoint.send(sendInput));
    expect(error).toBeInstanceOf(FirewallSendError);
    expect(error.message).toBe(refusal.message);
    expect(error.message).toContain(refusal.checkId);
    expect(error).toMatchObject({
      checkId: refusal.checkId,
      feedback: refusal.feedback,
    });
  });
}

describe("a refused send across the daemon boundary", () => {
  it.each(AMBIGUOUS_SEND_ANSWERS)(
    "reports outcome-unknown for $name",
    ({ message }) => reportsAmbiguousSendAnswer(message),
  );
  it(
    "preserves the typed firewall refusal and check reference through MCP",
    preservesFirewallRefusal,
  );
  it.each(DETAILED_REFUSALS)(
    "carries the detail of a refusal: %s",
    carriesARefusalDetailAcrossTheDaemonBoundary,
  );
  it("carries delivery-pending", carriesDeliveryPendingAcrossTheDaemonBoundary);
  it(
    "answers outcome-unknown for a send that ends without a typed failure",
    answersOutcomeUnknownForAnUntypedSendFailure,
  );
  it(
    "reports outcome-unknown when the connection drops during a send",
    reportsOutcomeUnknownWhenTheConnectionDropsMidSend,
    MCP_TRACE_TIMEOUT_MS,
  );
  it(
    "keeps a refused connection network-unavailable",
    keepsARefusedConnectionNetworkUnavailable,
    MCP_TRACE_TIMEOUT_MS,
  );
  it.each([
    [404, "network-unavailable"],
    [499, "outcome-unknown"],
    [500, "outcome-unknown"],
  ] as const)(
    "classifies an HTTP %i answer to a send as %s",
    ([status, reason]) => classifiesAnHttpAnswerToASend(status, reason),
    MCP_TRACE_TIMEOUT_MS,
  );
});
