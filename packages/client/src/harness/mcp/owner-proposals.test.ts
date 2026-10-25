/** @file Argument diagnostics and discoverability through the MCP HTTP interface. */

import { scopedLive as it } from "@effect/vitest";
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import { Effect, Redacted, Schema } from "effect";
import { expect } from "vitest";
import {
  stateDirectory,
  withStore,
} from "../../__tests__/store-schema-fixtures.js";
import {
  type FirewallOptions,
  installEditableFirewall,
} from "../../firewall/index.js";
import {
  type HarnessMcpOperations,
  makeHarnessMcpHttpHandler,
} from "./tools.js";

/* eslint-disable agent-code-guard/no-hardcoded-assertion-literals -- Tool names and closed reasons are the MCP authority contract under test. */

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

const credentials = {
  runtime: Redacted.make("runtime-secret-for-local-test-0001"),
  owner: Redacted.make("owner-secret-for-local-test-00001"),
};
const options: FirewallOptions = {
  incoming: [],
  outgoing: [],
  mode: "enforcement",
  facts: [],
  codeDigest: "a".repeat(64),
  settings: {
    timeoutMilliseconds: 1000,
    middlewareTimeoutMilliseconds: 1000,
    maximumInputBytes: 100000,
    maximumResultBytes: 10000,
  },
};
const acquireHandler = (selected: HarnessMcpOperations, authenticated = true) =>
  Effect.gen(function* () {
    const handler = yield* makeHarnessMcpHttpHandler({
      implementation: { name: "tool-contract-test", version: "1" },
      operations: selected,
      ...(authenticated ? { credentials } : {}),
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

const catalogSchema = Schema.Struct({
  tools: Schema.Array(Schema.Struct({ name: Schema.String })),
});
const resultSchema = Schema.Struct({ structuredContent: Schema.Unknown });
const decisionSchema = Schema.Struct({ id: Schema.NonEmptyString });
const proposalTools = [
  "policy_propose",
  "proposals_read",
  "proposal_accept",
  "proposal_decline",
];

function verifyCatalog(handler: Handler) {
  return Effect.gen(function* () {
    const runtime = yield* request(
      handler,
      "tools/list",
      {},
      credentials.runtime,
    );
    const runtimeNames = (yield* Schema.decodeUnknown(catalogSchema)(
      runtime.result,
    )).tools.map((tool) => tool.name);
    expect(runtimeNames).toContain("policy_propose");
    expect(runtimeNames).not.toContain("policy_update");
    expect(runtimeNames).not.toContain("proposals_read");
    expect(runtimeNames).not.toContain("proposal_accept");
    expect(runtimeNames).not.toContain("proposal_decline");
    const owner = yield* request(handler, "tools/list", {});
    const ownerNames = (yield* Schema.decodeUnknown(catalogSchema)(
      owner.result,
    )).tools.map((tool) => tool.name);
    expect(ownerNames).toEqual(expect.arrayContaining(proposalTools));
  });
}

function propose(handler: Handler) {
  return call(handler, "policy_propose", {}, credentials.runtime).pipe(
    Effect.flatMap((response) =>
      Schema.decodeUnknown(resultSchema)(response.result),
    ),
    Effect.flatMap((result) =>
      Schema.decodeUnknown(decisionSchema)(result.structuredContent),
    ),
  );
}

function call(
  handler: Handler,
  name: string,
  input: Readonly<Record<string, unknown>>,
  credential?: Redacted.Redacted,
) {
  return request(
    handler,
    "tools/call",
    { name, arguments: input },
    credential ?? credentials.owner,
  );
}

/** Uses the modern per-request envelope without opening a subscription or socket. */
function request(
  handler: Handler,
  method: string,
  params: Readonly<Record<string, unknown>>,
  credential?: Redacted.Redacted,
) {
  return Effect.tryPromise(() =>
    handler.fetch(
      new Request("http://127.0.0.1/mcp", {
        method: "POST",
        headers: {
          authorization: `Bearer ${Redacted.value(credential ?? credentials.owner)}`,
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

// @agent-code-guard/regression-only: The HTTP catalog and dispatch enforce the owner boundary before policy operations execute.
it("lets runtime propose while only owner authority lists and calls the decision tools", () =>
  withStore(stateDirectory(), (store) =>
    Effect.gen(function* () {
      const { policy } = yield* installEditableFirewall(options, store);
      const handler = yield* acquireHandler({
        ...operations,
        protocolActive: () => true,
        policy,
      });
      yield* verifyCatalog(handler);
      const proposal = yield* propose(handler);
      expect(
        yield* call(handler, "proposal_accept", proposal, credentials.runtime),
      ).toMatchObject({ error: { message: "Tool proposal_accept not found" } });
      const pending = yield* call(handler, "proposals_read", {});
      expect(pending).toMatchObject({
        result: {
          structuredContent: {
            proposals: [{ ...proposal, kind: "policy", add: [], remove: [] }],
          },
        },
      });
      expect(yield* call(handler, "proposal_accept", proposal)).toMatchObject({
        result: { structuredContent: proposal },
      });
      expect(yield* call(handler, "proposal_accept", proposal)).toMatchObject({
        result: { structuredContent: proposal },
      });
      expect(yield* call(handler, "proposal_decline", proposal)).toMatchObject({
        error: { data: { reason: "already-decided" } },
      });
      expect(
        yield* call(handler, "proposal_accept", { id: "missing" }),
      ).toMatchObject({ error: { data: { reason: "unknown-proposal" } } });
      const declined = yield* propose(handler);
      expect(yield* call(handler, "proposal_decline", declined)).toMatchObject({
        result: { structuredContent: declined },
      });
      expect(yield* call(handler, "proposals_read", {})).toMatchObject({
        result: { structuredContent: { proposals: [] } },
      });
    }).pipe(Effect.scoped),
  ));

it("lists all proposal tools to trusted local clients", () =>
  withStore(stateDirectory(), (store) =>
    Effect.gen(function* () {
      const { policy } = yield* installEditableFirewall(options, store);
      const handler = yield* acquireHandler(
        { ...operations, protocolActive: () => true, policy },
        false,
      );
      const catalog = yield* request(handler, "tools/list", {});
      const names = (yield* Schema.decodeUnknown(catalogSchema)(
        catalog.result,
      )).tools.map((tool) => tool.name);
      expect(names).toEqual(expect.arrayContaining(proposalTools));
    }).pipe(Effect.scoped),
  ));

it("hides all proposal tools when no policy is installed", () =>
  Effect.gen(function* () {
    const handler = yield* acquireHandler({
      ...operations,
      protocolActive: () => true,
    });
    const catalog = yield* request(handler, "tools/list", {});
    const names = (yield* Schema.decodeUnknown(catalogSchema)(
      catalog.result,
    )).tools.map((tool) => tool.name);
    expect(names).not.toContain("policy_propose");
    expect(names).not.toContain("proposals_read");
    expect(names).not.toContain("proposal_accept");
    expect(names).not.toContain("proposal_decline");
  }));

/* eslint-enable agent-code-guard/no-hardcoded-assertion-literals -- Restore default assertion rules outside the MCP contract tests. */
