/** @file Exercises draft discovery and native inbox delivery through real HTTP. */

import { testAgentView } from "../../__tests__/agent-card-fixtures.js";
import { HttpClient, HttpClientRequest } from "@effect/platform";
import { NodeHttpClient } from "@effect/platform-node";
import { scopedLive as it } from "@effect/vitest";
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  createMcpHandler,
  fromJsonSchema,
  McpServer,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import { Chunk, Deferred, Effect, Fiber, Schema, Stream } from "effect";
import { describe, expect } from "vitest";
import type { HarnessMessageReadyEvent } from "../../host-protocol/operations.js";
import { digest } from "../../__tests__/agent-card-fixtures.js";
import { loopbackMcpEndpoint } from "../../__tests__/mcp-http-fixtures.js";
import { localGuidance } from "../../__tests__/message-policy-fixtures.js";
import { InboundItem } from "../../communication/collectives/inbound.js";
import { DeliveryToken } from "../../communication/store/index.js";
import { acquireHarnessEndpoint } from "../../host-client/index.js";
import { INBOX_PENDING_EVENT } from "../../host-protocol/names.js";
import { type HarnessEvents, makeHarnessEvents } from "./events.js";
import {
  type HarnessMcpOperations,
  makeHarnessMcpHttpHandler,
} from "./tools.js";

/* eslint-disable agent-code-guard/no-hardcoded-assertion-literals -- External MCP error codes and consumer ownership reasons are conformance expectations. */

const implementation = { name: "events-conformance", version: "1" };
const delivery = (byte: number): HarnessMessageReadyEvent => ({
  deliveryToken: Schema.decodeUnknownSync(DeliveryToken)(digest("dlv_", byte)),
  item: Schema.decodeUnknownSync(InboundItem)({
    kind: "multicast",
    message: {
      kind: "direct",
      postId: digest("pst_", byte),
      address: "agent:bob",
      sender: testAgentView("agent:bob"),
      content: [{ type: "text", text: `item ${String(byte)}` }],
    },
  }),
});

const registerInboxTools = (
  server: McpServer,
  unread: HarnessMessageReadyEvent[],
  acknowledged: string[],
) => {
  server.registerTool(
    "read_inbox",
    { inputSchema: fromJsonSchema({ type: "object" }) },
    () => ({
      content: [{ type: "text", text: "inbox" }],
      structuredContent: { items: [...unread] },
    }),
  );
  server.registerTool(
    "acknowledge_delivery",
    {
      inputSchema: fromJsonSchema<{ deliveryToken: string }>({
        type: "object",
        properties: { deliveryToken: { type: "string" } },
        required: ["deliveryToken"],
      }),
    },
    (input) => {
      acknowledged.push(input.deliveryToken);
      const index = unread.findIndex(
        (entry) => entry.deliveryToken === input.deliveryToken,
      );
      if (index >= 0) {
        unread.splice(index, 1);
      }
      return {
        content: [{ type: "text", text: "{}" }],
        structuredContent: {},
      };
    },
  );
};

/**
 * Wrap `gate` so the first gated step that finds a subscription reserved
 * signals one arrival and yields, placing that arrival after the reservation
 * and before the subscription is active.
 */
const yieldAfterReservation = (
  gate: Effect.Semaphore,
  current: () => HarnessEvents,
): Effect.Semaphore => {
  let triggered = false;
  const arrive = Effect.suspend(() => {
    const events = current();
    if (triggered || !events.hasActiveSubscription()) {
      return Effect.void;
    }
    triggered = true;
    events.notifyPending();
    return Effect.yieldNow();
  });
  return {
    resize: (permits) => gate.resize(permits),
    take: (permits) => gate.take(permits),
    release: (permits) => gate.release(permits),
    releaseAll: gate.releaseAll,
    withPermitsIfAvailable: (permits) => gate.withPermitsIfAvailable(permits),
    withPermits: (permits) => (operation) =>
      gate.withPermits(permits)(operation).pipe(Effect.tap(arrive)),
  };
};

const unreachable = () =>
  Effect.dieMessage("events scenario reached an unrelated operation");

/** An in-memory inbox: unread items in order and the newest sequence. */
interface MemoryInbox {
  readonly unread: HarnessMessageReadyEvent[];
  sequence: number;
}

/**
 * Registered daemon operations over `inbox`; operations outside the events
 * scenarios die.
 */
const inboxOperations = (inbox: MemoryInbox): HarnessMcpOperations => ({
  protocolActive: () => true,
  readStatus: unreachable,
  register: unreachable,
  searchAgents: unreachable,
  searchConversations: unreachable,
  readConversation: unreachable,
  send: unreachable,
  readEvent: unreachable,
  readInbox: () => Effect.sync(() => ({ items: [...inbox.unread] })),
  readInboxSummary: () =>
    Effect.sync(() => ({
      pendingCount: inbox.unread.length,
      newestSequence: inbox.sequence,
    })),
  acknowledgeDelivery: (deliveryToken) =>
    Effect.sync(() => {
      const index = inbox.unread.findIndex(
        (entry) => entry.deliveryToken === deliveryToken,
      );
      if (index >= 0) {
        inbox.unread.splice(index, 1);
      }
    }),
});

/**
 * The production MCP handler for a registered daemon over an in-memory inbox,
 * served on loopback HTTP.
 */
const acquireEventsServer = Effect.gen(function* () {
  const inbox: MemoryInbox = { unread: [], sequence: 0 };
  const attached = yield* Deferred.make<undefined>();
  const detached = yield* Deferred.make<undefined>();
  const handler = yield* makeHarnessMcpHttpHandler({
    implementation,
    operations: inboxOperations(inbox),
    onSubscriptionActiveChange: (active) => {
      Effect.runFork(Deferred.succeed(active ? attached : detached, undefined));
    },
  });
  const endpoint = yield* loopbackMcpEndpoint(handler);
  return {
    endpoint,
    attached,
    detached,
    add: (item: HarnessMessageReadyEvent) => {
      inbox.unread.push(item);
      inbox.sequence += 1;
      handler.notifyPending();
    },
  };
});

/**
 * A hand-built server over the production events runtime whose gate places
 * one arrival inside subscription activation. The production handler owns
 * its gate, so this race needs its own server and inbox tools.
 */
const acquireRacingEventsServer = Effect.gen(function* () {
  const unread: HarnessMessageReadyEvent[] = [];
  const acknowledged: string[] = [];
  let sequence = 0;
  const gate = yield* Effect.makeSemaphore(1);
  const events: HarnessEvents = yield* makeHarnessEvents({
    gate: yieldAfterReservation(gate, () => events),
    protocolActive: () => true,
    summary: () =>
      Effect.sync(() => ({
        pendingCount: unread.length,
        newestSequence: sequence,
      })),
  });
  const handler = createMcpHandler(
    () => {
      const capabilities = {
        tools: {},
        events: {},
      };
      const server = new McpServer(implementation, { capabilities });
      events.install(server.server);
      registerInboxTools(server, unread, acknowledged);
      return server;
    },
    { legacy: "reject", responseMode: "auto" },
  );
  yield* Effect.addFinalizer(() => events.close);
  const endpoint = yield* loopbackMcpEndpoint(handler);
  return {
    endpoint,
    events,
    acknowledged,
    add: (item: HarnessMessageReadyEvent) => {
      unread.push(item);
      sequence += 1;
      events.notifyPending();
    },
  };
});

const rawRequest = (
  endpoint: URL,
  method: string,
  params: Readonly<Record<string, unknown>> = {},
) =>
  HttpClient.execute(
    HttpClientRequest.post(endpoint).pipe(
      HttpClientRequest.setHeaders({
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-method": method,
      }),
      HttpClientRequest.bodyUnsafeJson({
        jsonrpc: "2.0",
        id: 1,
        method,
        params: {
          ...params,
          _meta: {
            [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
            [CLIENT_INFO_META_KEY]: implementation,
            [CLIENT_CAPABILITIES_META_KEY]: {},
          },
        },
      }),
    ),
  ).pipe(
    Effect.flatMap((response) => response.json),
    Effect.provide(NodeHttpClient.layer),
  );

const discoversDraftEvents = () =>
  Effect.gen(function* () {
    const { endpoint } = yield* acquireEventsServer;
    const discovery = yield* rawRequest(endpoint, "server/discover");
    expect(discovery).toMatchObject({
      result: { capabilities: { events: {} } },
    });
    const catalog = yield* rawRequest(endpoint, "events/list");
    const pushDelivery: unknown = expect.arrayContaining(["push"]);
    expect(catalog).toHaveProperty(
      "result.events",
      expect.arrayContaining([
        expect.objectContaining({
          name: INBOX_PENDING_EVENT,
          delivery: pushDelivery,
        }),
      ]),
    );
    const missing = yield* rawRequest(endpoint, "events/stream", {
      name: "missing",
      arguments: {},
    });
    expect(missing).toMatchObject({
      error: { code: -32011, data: { kind: "event" } },
    });
    const replay = yield* rawRequest(endpoint, "events/stream", {
      name: INBOX_PENDING_EVENT,
      arguments: {},
      cursor: "stale",
    });
    expect(replay).toMatchObject({ error: { code: -32014 } });
  });

const acceptsOmittedSubscribeCursor = () =>
  Effect.gen(function* () {
    const { endpoint } = yield* acquireEventsServer;
    const omittedCursor = yield* rawRequest(endpoint, "events/subscribe", {
      name: "org.social-harness/inbox.item",
      arguments: {},
      delivery: {
        mode: "webhook",
        url: "https://callback.example/events",
        secret: "unavailable",
      },
    });
    expect(omittedCursor).toMatchObject({
      error: { code: -32014, data: { feature: "deliveryMode" } },
    });
  });

const catchesUpAndDrainsNewArrivals = () =>
  Effect.gen(function* () {
    const harness = yield* acquireRacingEventsServer;
    const guidance = localGuidance(1);
    harness.add({ ...delivery(1), guidance });
    const endpoint = yield* acquireHarnessEndpoint(harness.endpoint);
    const firstAccepted = yield* Deferred.make<undefined>();
    const received = yield* endpoint.messages.pipe(
      Stream.tap((item) =>
        item.acknowledge.pipe(
          Effect.zipRight(Deferred.succeed(firstAccepted, undefined)),
        ),
      ),
      Stream.take(2),
      Stream.runCollect,
      Effect.forkScoped,
    );
    yield* Deferred.await(firstAccepted);
    harness.add(delivery(2));
    harness.events.notifyPending();
    harness.events.notifyPending();
    const items = yield* Fiber.join(received);
    expect(Chunk.toReadonlyArray(items).map((item) => item.guidance)).toEqual([
      guidance,
      undefined,
    ]);
    expect(Chunk.toReadonlyArray(items).map((item) => item.item)).toEqual([
      delivery(1).item,
      delivery(2).item,
    ]);
    expect(harness.acknowledged).toEqual([
      delivery(1).deliveryToken,
      delivery(2).deliveryToken,
    ]);
  });

const preservesExclusiveOwnership = () =>
  Effect.gen(function* () {
    const harness = yield* acquireEventsServer;
    const first = yield* acquireHarnessEndpoint(harness.endpoint);
    const second = yield* acquireHarnessEndpoint(harness.endpoint);
    const running = yield* first.messages.pipe(
      Stream.runDrain,
      Effect.forkScoped,
    );
    yield* Deferred.await(harness.attached);
    const refused = yield* second.messages.pipe(Stream.runHead, Effect.flip);
    expect(refused.reason).toBe("already-listening");
    yield* Fiber.interrupt(running);
    yield* Deferred.await(harness.detached);
    harness.add(delivery(3));
    const replay = yield* second.messages.pipe(
      Stream.take(1),
      Stream.runCollect,
    );
    expect(Chunk.toReadonlyArray(replay).map((item) => item.item)).toEqual([
      delivery(3).item,
    ]);
  });

// @agent-code-guard/regression-only: these finite protocol transcripts pin interoperability with the official SDK and real loopback HTTP.
describe("MCP Events draft interoperability", () => {
  it(
    "accepts an omitted subscription cursor before applying delivery policy",
    acceptsOmittedSubscribeCursor,
  );
  it(
    "advertises discovery and preserves draft errors for unknown events and replay",
    discoversDraftEvents,
  );
  it(
    "catches up an item whose wakeup arrives during activation and coalesces later wakeups without implicit acknowledgment",
    catchesUpAndDrainsNewArrivals,
  );
  it(
    "refuses a competing consumer and releases ownership on cancellation",
    preservesExclusiveOwnership,
  );
});

/* eslint-enable agent-code-guard/no-hardcoded-assertion-literals -- Restore repository defaults. */
