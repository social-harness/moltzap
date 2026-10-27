/** @file Native Events handshake bounds and optional-cursor interoperability. */

import { scopedLive as it, scoped as itOnTestClock } from "@effect/vitest";
import {
  createMcpHandler,
  fromJsonSchema,
  McpServer,
  ProtocolError,
  type ServerContext,
  SUBSCRIPTION_ID_META_KEY,
} from "@modelcontextprotocol/server";
import { Deferred, Duration, Effect, Fiber, Stream, TestClock } from "effect";
import { describe, expect } from "vitest";
import { loopbackMcpEndpoint } from "../../__tests__/mcp-http-fixtures.js";
import { INBOX_PENDING_EVENT } from "../protocol/names.js";
import { inboxWakeups } from "./events.js";
import { acquireHarnessEndpoint } from "./index.js";

/* eslint-disable agent-code-guard/no-hardcoded-assertion-literals -- Closed transport errors and draft notification names are interoperability expectations. */

const frames: ReadonlyArray<
  readonly [string, Readonly<Record<string, unknown>>]
> = [
  ["notifications/events/active", { truncated: false }],
  ["notifications/message", { level: "info", data: "unrelated log" }],
  ["notifications/events/heartbeat", {}],
  [
    "notifications/events/error",
    { error: { code: -32603, message: "UpstreamError" } },
  ],
  [
    "notifications/events/event",
    {
      eventId: "evt_test",
      name: INBOX_PENDING_EVENT,
      timestamp: "2026-09-30T00:00:00Z",
      data: { pendingCount: 1 },
    },
  ],
  [
    "notifications/events/terminated",
    { error: { code: -32012, message: "Unavailable" } },
  ],
];

/**
 * A server whose `events/stream` handler records each request's params in
 * `requests`, for the test to assert, and then runs `operation`.
 */
const streamServer = (
  requests: unknown[],
  operation: (context: ServerContext) => Effect.Effect<never, unknown>,
) =>
  createMcpHandler(
    () => {
      const capabilities = { events: {}, logging: {} };
      const server = new McpServer(
        { name: "native-events-conformance", version: "1" },
        { capabilities },
      );
      server.server.setRequestHandler(
        "events/stream",
        { params: fromJsonSchema({ type: "object" }) },
        (input, context) => {
          requests.push(input);
          return Effect.runPromise(operation(context), {
            signal: context.mcpReq.signal,
          });
        },
      );
      return server;
    },
    { legacy: "reject", responseMode: "auto" },
  );

/**
 * Startup must fail within the transport's 60-second connection bound.
 */
const INITIAL_HEADERS_BOUND = Duration.seconds(60);

const boundsInitialHeaders = () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<undefined>();
    const requests: unknown[] = [];
    const handler = streamServer(requests, () =>
      Deferred.succeed(entered, undefined).pipe(Effect.zipRight(Effect.never)),
    );
    const endpoint = yield* loopbackMcpEndpoint(handler);
    const reader = yield* inboxWakeups(endpoint).pipe(
      Stream.runDrain,
      Effect.flip,
      Effect.forkScoped,
    );
    yield* Deferred.await(entered);
    yield* TestClock.adjust(
      Duration.sum(INITIAL_HEADERS_BOUND, Duration.seconds(1)),
    );
    expect((yield* Fiber.join(reader)).reason).toBe("transport-failed");
    expect(requests).toEqual([
      expect.objectContaining({ name: INBOX_PENDING_EVENT }),
    ]);
  });

/** A server whose `events/list` handler fails with the protocol error `code`. */
const failingCatalogServer = (code: number) =>
  createMcpHandler(
    () => {
      const capabilities = { events: {}, logging: {} };
      const server = new McpServer(
        { name: "catalog-failure", version: "1" },
        { capabilities },
      );
      server.server.setRequestHandler(
        "events/list",
        { params: fromJsonSchema({ type: "object" }) },
        () => {
          throw new ProtocolError(code, "Catalog unavailable");
        },
      );
      return server;
    },
    { legacy: "reject", responseMode: "auto" },
  );

const classifiesCatalogFailure = (code: number, reason: string) =>
  Effect.gen(function* () {
    const endpoint = yield* loopbackMcpEndpoint(failingCatalogServer(code));

    const error = yield* acquireHarnessEndpoint(endpoint).pipe(Effect.flip);

    expect(error.reason).toBe(reason);
  });

const sendFrames = (
  context: ServerContext,
  receipts: ReadonlyArray<Deferred.Deferred<undefined>>,
) =>
  Effect.gen(function* () {
    const receiptByMethod: Readonly<
      Record<string, Deferred.Deferred<undefined> | undefined>
    > = {
      "notifications/events/active": receipts[0],
      "notifications/events/event": receipts[1],
    };
    for (const [method, params] of frames) {
      yield* Effect.tryPromise({
        try: () =>
          context.mcpReq.notify({
            method,
            params: {
              ...params,
              _meta: { [SUBSCRIPTION_ID_META_KEY]: context.mcpReq.id },
            },
          }),
        catch: () => new Error("Failed to send test frame"),
      });
      const receipt = receiptByMethod[method];
      if (receipt !== undefined) {
        yield* Deferred.await(receipt);
      }
    }
    return yield* Effect.never;
  });

const continuesAfterRecoverableErrors = () =>
  Effect.gen(function* () {
    const receipts = [
      yield* Deferred.make<undefined>(),
      yield* Deferred.make<undefined>(),
    ];
    let received = 0;
    const requests: unknown[] = [];
    const handler = streamServer(requests, (context) =>
      sendFrames(context, receipts),
    );
    const endpoint = yield* loopbackMcpEndpoint(handler);
    const failure = yield* inboxWakeups(endpoint).pipe(
      Stream.tap(() => {
        const receipt = receipts[received++];
        return receipt === undefined
          ? Effect.void
          : Deferred.succeed(receipt, undefined);
      }),
      Stream.runDrain,
      Effect.flip,
    );
    expect(failure.reason).toBe("transport-failed");
    expect(received).toBe(2);
    expect(requests).toEqual([
      expect.objectContaining({ name: INBOX_PENDING_EVENT }),
    ]);
  });

const rejectsFrame = ({
  method,
  params,
  wrongId,
}: {
  readonly method: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly wrongId: boolean;
}) =>
  Effect.gen(function* () {
    const handler = streamServer([], (context) =>
      Effect.tryPromise(() =>
        context.mcpReq.notify({
          method,
          params: {
            ...params,
            _meta: {
              [SUBSCRIPTION_ID_META_KEY]: wrongId
                ? "foreign"
                : context.mcpReq.id,
            },
          },
        }),
      ).pipe(Effect.zipRight(Effect.never)),
    );
    const endpoint = yield* loopbackMcpEndpoint(handler);
    const failure = yield* inboxWakeups(endpoint).pipe(
      Stream.runDrain,
      Effect.flip,
    );
    expect(failure.reason).toBe("decode-failed");
  });

// @agent-code-guard/regression-only: Real HTTP transcripts cover external framing and bounded startup.
describe("native MCP Events reception", () => {
  it.each([
    {
      name: "a frame before activation",
      method: "notifications/events/heartbeat",
      params: {},
      wrongId: false,
    },
    {
      name: "a malformed activation",
      method: "notifications/events/active",
      params: { truncated: "invalid" },
      wrongId: false,
    },
    {
      name: "a foreign subscription",
      method: "notifications/events/active",
      params: { truncated: false },
      wrongId: true,
    },
    {
      name: "an unknown Events method",
      method: "notifications/events/unknown",
      params: { error: { code: -32603, message: "Unknown" } },
      wrongId: false,
    },
  ])("rejects $name", rejectsFrame);
  it.each([
    { failure: "an unsupported", code: -32601, reason: "incompatible-daemon" },
    { failure: "a transient", code: -32603, reason: "transport-failed" },
  ])("classifies $failure catalog failure as $reason", ({ code, reason }) =>
    classifiesCatalogFailure(code, reason),
  );
  itOnTestClock(
    "bounds a connection whose server withholds HTTP headers",
    boundsInitialHeaders,
  );
  it(
    "accepts absent cursors, continues after recoverable errors and closes on termination",
    continuesAfterRecoverableErrors,
  );
});

/* eslint-enable agent-code-guard/no-hardcoded-assertion-literals -- Restore repository defaults. */
