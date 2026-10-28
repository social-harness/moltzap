/**
 * @file The gateway log line each outbound send writes, naming the plugin
 * entry point that produced it.
 */

import type {
  ChannelLogSink,
  ChannelRuntimeSurface,
} from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { live as it } from "@effect/vitest";
import {
  CollectiveError,
  InboundItem,
  type SendInput,
  type SendResult,
} from "@moltzap/social-harness";
import { Data, Effect, Fiber, Schema, Stream } from "effect";
import {
  buildChannelInboundEventContext,
  runChannelInboundEvent,
} from "openclaw/plugin-sdk/channel-inbound";
import { describe, expect, vi } from "vitest";

import {
  endpointResult,
  OPERATION_ID,
  postId,
} from "./__tests__/send-results.js";
import { createChannelPlugin } from "./plugin.js";

const ACCOUNT_ID = "primary";
const CONFIG: OpenClawConfig = {
  channels: { sharness: { accounts: [{ id: ACCOUNT_ID }] } },
};
const GROUP = "group:alice,bob,carol";
const SLOT_SCHEMA = {
  type: "object",
  properties: { slot: { type: "string", enum: ["mon", "tue"] } },
  required: ["slot"],
};

type Plugin = ReturnType<typeof createChannelPlugin>;

class OutboundLogTestError extends Data.TaggedError("OutboundLogTestError")<{
  readonly operation: string;
  readonly detail: string;
}> {}

describe("OpenClaw outbound gateway log", () => {
  it(
    "logs a message tool send as message-action:send with its operation and id",
    messageToolSendLogsItsOrigin,
  );
  it(
    "logs a message tool reply as message-action:reply with op=answer",
    messageToolReplyLogsItsOrigin,
  );
  it(
    "logs an OpenClaw text delivery as send.text with op=plain",
    sendTextLogsItsOrigin,
  );
  it(
    "logs a send the Client refuses as a warning with the refusal",
    refusedSendLogsTheFailure,
  );
});

function messageToolSendLogsItsOrigin() {
  const message = JSON.stringify({
    gather: "Which day?",
    deadline: 300,
    requestedSchema: SLOT_SCHEMA,
  });
  return sendThroughConnectedAccount((plugin) =>
    runMessageAction(plugin, "send", GROUP, message),
  ).pipe(
    Effect.tap(({ logLines }) => {
      expect(logLines).toContain(
        `info: Social Harness: outbound via message-action:send to ${GROUP} op=gather operationId=${OPERATION_ID} postId=- chars=${message.length}: ${message.slice(0, 80)}`,
      );
    }),
  );
}

function messageToolReplyLogsItsOrigin() {
  const to = "agent:alice";
  const message = '{"action":"accept","content":{"slot":"mon"}}';
  return sendThroughConnectedAccount((plugin) =>
    runMessageAction(plugin, "reply", to, message),
  ).pipe(
    Effect.tap(({ logLines }) => {
      expect(logLines).toContain(
        `info: Social Harness: outbound via message-action:reply to ${to} op=answer operationId=${OPERATION_ID} postId=${postId(100)} chars=${message.length}: ${message}`,
      );
    }),
  );
}

function sendTextLogsItsOrigin() {
  const to = "agent:nova";
  const text = "Checking the calendar";
  return sendThroughConnectedAccount((plugin) =>
    runSendText(plugin, to, text),
  ).pipe(
    Effect.tap(({ logLines }) => {
      expect(logLines).toContain(
        `info: Social Harness: outbound via send.text to ${to} op=plain operationId=- postId=${postId(100)} chars=${text.length}: ${text}`,
      );
    }),
  );
}

function refusedSendLogsTheFailure() {
  const refusal = new CollectiveError({
    id: collectiveId(),
    failure: { kind: "schema-invalid", detail: "type must be object" },
  });
  const message = JSON.stringify({
    all_gather: "Which day?",
    deadline: 60,
    requestedSchema: SLOT_SCHEMA,
  });
  return sendThroughConnectedAccount(
    (plugin) =>
      runMessageAction(plugin, "send", GROUP, message).pipe(Effect.flip),
    () => Effect.fail(refusal),
  ).pipe(
    Effect.tap(({ logLines }) => {
      expect(logLines).toContain(
        `warn: Social Harness: outbound via message-action:send to ${GROUP} op=all_gather failed: ${refusal.message}`,
      );
    }),
  );
}

/**
 * Connects an account whose endpoint answers its one send with `respond`, by
 * default its own result, runs `send`, and returns its outcome with the
 * gateway log lines written so far.
 */
function sendThroughConnectedAccount<A, E>(
  send: (plugin: Plugin) => Effect.Effect<A, E | OutboundLogTestError>,
  respond: (
    input: SendInput,
    index: number,
  ) => Effect.Effect<SendResult, CollectiveError> = endpointResult,
) {
  const plugin = createChannelPlugin({
    harnessEndpointForAccount: () => ({
      send: (input) => respond(input, 0),
      messages: Stream.never,
    }),
  });
  const controller = new AbortController();
  const logLines: string[] = [];
  return Effect.gen(function* () {
    const fiber = yield* startAccount(plugin, controller.signal, logLines).pipe(
      Effect.fork,
    );
    yield* waitForConnected(logLines);
    const outcome = yield* send(plugin);
    controller.abort();
    yield* Effect.timeout(Fiber.join(fiber), "1 second");
    return { outcome, logLines };
  });
}

function startAccount(
  plugin: Plugin,
  abortSignal: AbortSignal,
  logLines: string[],
) {
  const start = plugin.gateway?.startAccount;
  if (start === undefined) {
    return Effect.fail(testError("startAccount", "missing gateway start"));
  }
  return Effect.tryPromise({
    try: () =>
      start({
        cfg: CONFIG,
        accountId: ACCOUNT_ID,
        account: { id: ACCOUNT_ID },
        abortSignal,
        log: recordingLogSink(logLines),
        runtime: {
          log: () => undefined,
          error: () => undefined,
          exit: () => undefined,
        },
        channelRuntime: idleAccountRuntime(),
        getStatus: () => ({ accountId: ACCOUNT_ID }),
        setStatus: () => undefined,
      }),
    catch: (cause) => testError("startAccount", cause),
  });
}

/** OpenClaw account services for an endpoint that delivers no inbound turn. */
function idleAccountRuntime(): ChannelRuntimeSurface {
  return {
    runtimeContexts: {
      register: () => ({ dispose: () => undefined }),
      get: () => undefined,
      watch: () => () => undefined,
    },
    inbound: {
      buildContext: buildChannelInboundEventContext,
      run: runChannelInboundEvent,
    },
    routing: {
      resolveAgentRoute: () => {
        throw new Error("an idle account resolves no route");
      },
    },
  };
}

/** A gateway log sink that records each line with its level. */
function recordingLogSink(lines: string[]): ChannelLogSink {
  return {
    info: (line) => {
      lines.push(`info: ${line}`);
    },
    warn: (line) => {
      lines.push(`warn: ${line}`);
    },
    error: (line) => {
      lines.push(`error: ${line}`);
    },
  };
}

function waitForConnected(logLines: readonly string[]) {
  return Effect.tryPromise({
    try: () =>
      vi.waitFor(() => {
        expect(logLines).toContain(
          `info: Social Harness: connected for account ${ACCOUNT_ID}`,
        );
      }),
    catch: (cause) => testError("waitForConnected", cause),
  });
}

function runMessageAction(
  plugin: Plugin,
  action: "send" | "reply",
  to: string,
  message: string,
) {
  const handleAction = plugin.actions?.handleAction;
  if (handleAction === undefined) {
    return Effect.fail(testError("handleAction", "missing action handler"));
  }
  return Effect.tryPromise({
    try: () =>
      handleAction({
        channel: "sharness",
        action,
        cfg: CONFIG,
        accountId: ACCOUNT_ID,
        params: { to, message },
      }),
    catch: (cause) => testError("handleAction", cause),
  });
}

function runSendText(plugin: Plugin, to: string, text: string) {
  const sendText = plugin.message?.send?.text;
  if (sendText === undefined) {
    return Effect.fail(testError("sendText", "missing OpenClaw text sender"));
  }
  return Effect.tryPromise({
    try: () => sendText({ cfg: CONFIG, accountId: ACCOUNT_ID, to, text }),
    catch: (cause) => testError("sendText", cause),
  });
}

/** A collective id as the Client brands it, read from an item that carries one. */
function collectiveId(): CollectiveError["id"] {
  const item = Schema.decodeUnknownSync(InboundItem)({
    kind: "operationFailed",
    id: OPERATION_ID,
    to: "agent:alice",
    error: "unused",
  });
  if (item.kind !== "operationFailed") {
    throw new Error("expected an operationFailed item");
  }
  return item.id;
}

function testError(operation: string, cause: unknown): OutboundLogTestError {
  return new OutboundLogTestError({ operation, detail: String(cause) });
}
