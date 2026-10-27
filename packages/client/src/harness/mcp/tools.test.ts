/** @file Argument diagnostics and discoverability through the MCP HTTP interface. */

import { scopedLive as it } from "@effect/vitest";
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  ProtocolErrorCode,
} from "@modelcontextprotocol/server";
import { Effect, Schema } from "effect";
import { describe, expect } from "vitest";
import { HARNESS_SEND_META_KEY } from "../protocol/names.js";
import { decodeHarnessSendErrorData } from "../protocol/operations.js";
import {
  type HarnessMcpOperations,
  makeHarnessMcpHttpHandler,
} from "./tools.js";

const unused = () => Effect.dieMessage("invalid input reached an operation");
const operations: HarnessMcpOperations = {
  protocolActive: () => false,
  readStatus: () => Effect.succeed({ kind: "unregistered" }),
  readInboxSummary: () =>
    Effect.succeed({ pendingCount: 0, newestSequence: 0 }),
  register: unused,
  searchAgents: unused,
  searchConversations: unused,
  readConversation: unused,
  readEvent: unused,
  readInbox: unused,
  send: unused,
  acknowledgeDelivery: unused,
};

const acquireHandler = (selected: HarnessMcpOperations) =>
  Effect.gen(function* () {
    const handler = yield* makeHarnessMcpHttpHandler({
      implementation: { name: "tool-contract-test", version: "1" },
      operations: selected,
    });
    yield* Effect.addFinalizer(() =>
      Effect.tryPromise(() => handler.close()).pipe(Effect.orDie),
    );
    return handler;
  });

const responseSchema = Schema.parseJson(
  Schema.Struct({
    error: Schema.optional(
      Schema.Struct({
        code: Schema.Number,
        message: Schema.String,
        data: Schema.optional(Schema.Unknown),
      }),
    ),
    result: Schema.optional(Schema.Unknown),
  }),
);
type Handler = Effect.Effect.Success<ReturnType<typeof acquireHandler>>;

/** Uses the modern per-request envelope without opening a subscription or socket. */
function request(
  handler: Handler,
  method: string,
  params: Readonly<Record<string, unknown>>,
  metadata: Readonly<Record<string, unknown>> = {},
) {
  return Effect.tryPromise(() =>
    handler.fetch(
      new Request("http://127.0.0.1/mcp", {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "mcp-method": method,
          ...(typeof params.name === "string"
            ? { "mcp-name": params.name }
            : {}),
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method,
          params: {
            ...params,
            _meta: {
              ...metadata,
              [CLIENT_INFO_META_KEY]: {
                name: "tool-contract-test",
                version: "1",
              },
              [CLIENT_CAPABILITIES_META_KEY]: {},
              [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
            },
          },
        }),
      }),
    ),
  ).pipe(
    Effect.flatMap((response) => Effect.tryPromise(() => response.text())),
    Effect.flatMap(Schema.decodeUnknown(responseSchema)),
  );
}

const invalidCalls = [
  { name: "search_agents", arguments: {}, path: ["agentId"] },
  {
    name: "search_agents",
    arguments: { agentId: `agt_${"A".repeat(22)}`, agentName: "bob" },
    path: ["agentName"],
  },
  { name: "status", arguments: { unexpected: true }, path: ["unexpected"] },
  { name: "read_event", arguments: { eventId: "bad" }, path: ["eventId"] },
  { name: "acknowledge_delivery", arguments: {}, path: ["deliveryToken"] },
];
const invalidInvocationCalls = [
  {
    name: "send_message",
    arguments: { input: { to: "agent:bob", text: 123 } },
    path: ["input", "text"],
  },
  {
    name: "send_message",
    arguments: {
      input: {
        to: "agent:bob",
        collectiveResponse: { action: "accept", content: { choices: [1] } },
      },
    },
    path: ["input", "collectiveResponse", "content", "choices", 0],
  },
  {
    name: "send_message",
    arguments: { input: { to: "agent:bob", text: "hello" } },
    metadata: { [HARNESS_SEND_META_KEY]: { failureDelivery: "other" } },
    path: [HARNESS_SEND_META_KEY, "failureDelivery"],
  },
];
const invalidRegistrations = [
  { field: "operationId", value: "bad" },
  { field: "principalId", value: "bad" },
  { field: "operationId", value: `opn_${"A".repeat(22)}\n` },
  { field: "operationId", value: `prn_${"A".repeat(22)}` },
  { field: "principalId", value: `prn_${"A".repeat(21)}B` },
  { field: "operationId", value: `opn_${"A".repeat(21)}` },
];
const semanticFailures = [
  {
    name: "read_conversation",
    arguments: { continuation: `${"A".repeat(42)}B` },
    reason: "invalid-continuation",
  },
  {
    name: "search_conversations",
    arguments: { afterAddress: "group:carol,bob,alice" },
    reason: "invalid-address",
  },
];

const catalogSchema = Schema.Struct({
  tools: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      description: Schema.String,
      inputSchema: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
    }),
  ),
});

function checkDiagnostic(data: unknown, path: ReadonlyArray<string | number>) {
  return Schema.decodeUnknown(
    Schema.Struct({
      issues: Schema.Array(
        Schema.Struct({
          path: Schema.Array(Schema.Union(Schema.String, Schema.Number)),
          message: Schema.NonEmptyString,
        }),
      ),
    }),
  )(data).pipe(
    Effect.tap((diagnostics) =>
      Effect.sync(() => {
        expect(diagnostics.issues.map((issue) => issue.path)).toContainEqual(
          path,
        );
      }),
    ),
  );
}

function registrationOperation(
  accepted: unknown[],
): HarnessMcpOperations["register"] {
  return (input) =>
    Effect.sync(() => {
      accepted.push(input);
      return { kind: "name_taken" as const };
    });
}

function checksInvocationPrivacy() {
  return Effect.gen(function* () {
    const handler = yield* acquireHandler({
      ...operations,
      protocolActive: () => true,
    });
    const sentinel = "private-mcp-sentinel-1304";
    const malformedText = yield* request(handler, "tools/call", {
      name: "send_message",
      arguments: { input: { to: "agent:bob", text: `${sentinel}\ud800` } },
    });
    expect(malformedText.error).toMatchObject({
      code: ProtocolErrorCode.InvalidParams,
    });
    yield* checkDiagnostic(malformedText.error?.data, ["input", "text"]);
    expect(JSON.stringify(malformedText.error)).not.toContain(sentinel);
    const malformedToken = yield* request(
      handler,
      "tools/call",
      {
        name: "send_message",
        arguments: { input: { to: "agent:bob", text: sentinel } },
      },
      { [HARNESS_SEND_META_KEY]: { failureDelivery: `${sentinel}\u0000` } },
    );
    expect(malformedToken.error).toMatchObject({
      code: ProtocolErrorCode.InvalidParams,
    });
    yield* checkDiagnostic(malformedToken.error?.data, [
      HARNESS_SEND_META_KEY,
      "failureDelivery",
    ]);
    expect(JSON.stringify(malformedToken.error)).not.toContain(sentinel);
  });
}

function checksStructuralPrivacy() {
  return Effect.gen(function* () {
    const handler = yield* acquireHandler({
      ...operations,
      protocolActive: () => true,
    });
    const sentinel = "private-token-sentinel-1304";
    const response = yield* request(handler, "tools/call", {
      name: "acknowledge_delivery",
      arguments: { deliveryToken: { secret: sentinel } },
    });
    expect(response.error).toMatchObject({
      code: ProtocolErrorCode.InvalidParams,
    });
    yield* checkDiagnostic(response.error?.data, ["deliveryToken"]);
    expect(JSON.stringify(response.error)).not.toContain(sentinel);
  });
}

function checksDiagnosticCap() {
  return Effect.gen(function* () {
    const handler = yield* acquireHandler(operations);
    const sentinel = "private-excess-sentinel-1304";
    const response = yield* request(handler, "tools/call", {
      name: "status",
      arguments: Object.fromEntries(
        Array.from({ length: 25 }, () => sentinel).map((value, index) => [
          `extra${index}`,
          value,
        ]),
      ),
    });
    expect(response.error).toMatchObject({
      code: ProtocolErrorCode.InvalidParams,
    });
    const diagnostics = yield* checkDiagnostic(response.error?.data, [
      "extra0",
    ]);
    expect(diagnostics.issues).toHaveLength(20);
    expect(JSON.stringify(response.error)).not.toContain(sentinel);
  });
}

// @agent-code-guard/regression-only: malformed tool inputs name their fields without entering an operation.
describe("MCP tool argument diagnostics", () => {
  it.each(invalidInvocationCalls)(
    "retains invocation diagnostics for $name",
    (call) =>
      Effect.gen(function* () {
        const handler = yield* acquireHandler({
          ...operations,
          protocolActive: () => true,
        });
        const response = yield* request(
          handler,
          "tools/call",
          { name: call.name, arguments: call.arguments },
          call.metadata,
        );
        expect(response.error).toMatchObject({
          code: ProtocolErrorCode.InvalidParams,
        });
        yield* checkDiagnostic(response.error?.data, call.path);
        const failure = yield* decodeHarnessSendErrorData(response.error?.data);
        expect(failure).toMatchObject({ reason: "content-invalid" });
      }),
  );

  it(
    "keeps message text and runtime tokens out of invocation errors",
    checksInvocationPrivacy,
  );

  it("keeps token values out of structural errors", checksStructuralPrivacy);

  it(
    "caps structural diagnostics at twenty without exposing values",
    checksDiagnosticCap,
  );
});

// @agent-code-guard/regression-only: structural failures retain paths without entering operations.
describe("MCP structural argument diagnostics", () => {
  it.each(invalidCalls)("names the invalid field for $name", (call) =>
    Effect.gen(function* () {
      const handler = yield* acquireHandler({
        ...operations,
        protocolActive: () => true,
      });
      const response = yield* request(handler, "tools/call", {
        name: call.name,
        arguments: call.arguments,
      });
      expect(response.error).toMatchObject({
        code: ProtocolErrorCode.InvalidParams,
      });
      yield* checkDiagnostic(response.error?.data, call.path);
    }),
  );
});

// @agent-code-guard/regression-only: malformed identities must be rejected before registration side effects.
describe("MCP registration validation", () => {
  it.each(invalidRegistrations)(
    "rejects registration $field: $value before execution",
    (call) =>
      Effect.gen(function* () {
        const accepted: unknown[] = [];
        const handler = yield* acquireHandler({
          ...operations,
          register: registrationOperation(accepted),
        });
        const valid = {
          operationId: `opn_${"A".repeat(22)}`,
          principalId: `prn_${"A".repeat(22)}`,
          agentName: "alice",
        };
        const response = yield* request(handler, "tools/call", {
          name: "register",
          arguments: { ...valid, [call.field]: call.value },
        });
        expect(response.error).toMatchObject({
          code: ProtocolErrorCode.InvalidParams,
        });
        yield* checkDiagnostic(response.error?.data, [call.field]);
        expect(accepted).toEqual([]);
        const success = yield* request(handler, "tools/call", {
          name: "register",
          arguments: valid,
        });
        expect(success.result).toMatchObject({
          structuredContent: { kind: "name_taken" },
        });
        expect(accepted).toEqual([valid]);
      }),
  );
});

// @agent-code-guard/regression-only: structural diagnostics must preserve semantic operation failure reasons.
describe("MCP semantic failures", () => {
  it.each(semanticFailures)("preserves the owner operation's $reason", (call) =>
    Effect.gen(function* () {
      const handler = yield* acquireHandler({
        ...operations,
        protocolActive: () => true,
        readConversation: () => Effect.fail({ reason: "invalid-continuation" }),
        searchConversations: () => Effect.fail({ reason: "invalid-address" }),
      });
      const response = yield* request(handler, "tools/call", {
        name: call.name,
        arguments: call.arguments,
      });
      expect(response.error).toMatchObject({
        code: ProtocolErrorCode.InternalError,
        data: { reason: call.reason },
      });
    }),
  );
});

const fieldDescriptionsSchema = Schema.Record({
  key: Schema.String,
  value: Schema.Struct({ description: Schema.String }),
});

const checksInlineLookupSelector = () =>
  Effect.gen(function* () {
    const handler = yield* acquireHandler({
      ...operations,
      protocolActive: () => true,
    });
    const response = yield* request(handler, "tools/list", {});
    const catalog = yield* Schema.decodeUnknown(catalogSchema)(response.result);
    const search = catalog.tools.find((tool) => tool.name === "search_agents");

    expect(search?.inputSchema).not.toHaveProperty("$ref");
    const alternatives = yield* Schema.decodeUnknown(
      Schema.Array(
        Schema.Struct({
          type: Schema.Literal("object"),
          required: Schema.Array(Schema.String),
        }),
      ),
    )(search?.inputSchema.anyOf);
    expect(alternatives).toHaveLength(2);
    expect(alternatives.map((schema) => schema.required)).toContainEqual([
      "agentId",
    ]);
    expect(alternatives.map((schema) => schema.required)).toContainEqual([
      "agentName",
    ]);
  });

// @agent-code-guard/regression-only: descriptions expose identifier, retry and pagination intent to tool consumers.
describe("MCP tool discoverability", () => {
  it(
    "lists an inline exact lookup selector for search_agents",
    checksInlineLookupSelector,
  );

  it("describes every tool and the key input fields", () =>
    Effect.gen(function* () {
      const inactive = yield* acquireHandler(operations);
      const active = yield* acquireHandler({
        ...operations,
        protocolActive: () => true,
      });
      const inactiveResponse = yield* request(inactive, "tools/list", {});
      const activeResponse = yield* request(active, "tools/list", {});
      const before = yield* Schema.decodeUnknown(catalogSchema)(
        inactiveResponse.result,
      );
      const after = yield* Schema.decodeUnknown(catalogSchema)(
        activeResponse.result,
      );
      for (const tool of [...before.tools, ...after.tools]) {
        expect(tool.description.trim().length).toBeGreaterThan(0);
      }
      const registration = yield* Schema.decodeUnknown(fieldDescriptionsSchema)(
        before.tools.find((tool) => tool.name === "register")?.inputSchema
          .properties,
      );
      expect(
        registration.operationId?.description.trim().length,
      ).toBeGreaterThan(0);
      expect(
        registration.principalId?.description.trim().length,
      ).toBeGreaterThan(0);
      expect(registration.agentName?.description.trim().length).toBeGreaterThan(
        0,
      );
    }));
});
