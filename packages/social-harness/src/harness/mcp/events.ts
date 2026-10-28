/** @file Pinned MCP Events discovery and exclusive push, poll or webhook delivery. */

import {
  type McpServer,
  ProtocolError,
  type ServerContext,
  SUBSCRIPTION_ID_META_KEY,
} from "@modelcontextprotocol/server";
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Option,
  Queue,
  Runtime,
  Scope,
} from "effect";
import { randomUUID } from "node:crypto";
import type { InboxSummary } from "../protocol/operations.js";
import {
  decodeConsumerMetadata,
  eventListInput,
  eventPollInput,
  type EventPollInput,
  type EventStreamInput,
  eventStreamInput,
  type EventSubscribeInput,
  eventSubscribeInput,
  type EventUnsubscribeInput,
  eventUnsubscribeInput,
  type HarnessWebhookEvents,
  itemEventDataJsonSchema,
  type WebhookStatus,
} from "../protocol/index.js";
import { INBOX_ITEM_EVENT, INBOX_PENDING_EVENT } from "../protocol/names.js";
import {
  consumerConflict,
  consumerLost,
  type HarnessPollEvents,
  invalidMetadata,
} from "./poll.js";
/** Durable callback delivery shares this consumer boundary. */
export { makeWebhookEvents } from "./webhook.js";
/** Ephemeral polling shares the same consumer boundary and ownership gate. */
export { makeHarnessPollEvents } from "./poll.js";
/** Effect HTTP connection policy for callback delivery. */
export { webhookHttpClientLayer } from "./event-signing.js";

interface ActivePush {
  readonly context: ServerContext;
  readonly stop: Deferred.Deferred<undefined>;
  readonly closed: Deferred.Deferred<undefined>;
  ready: boolean;
  previousSequence: number;
}

interface EventsOptions {
  readonly summary: () => Effect.Effect<
    InboxSummary,
    { readonly reason: string }
  >;
  /** Whether the daemon's protocol is up; a subscription needs it. */
  readonly protocolActive: () => boolean;
  readonly gate: Effect.Semaphore;
  readonly webhook?: HarnessWebhookEvents;
  readonly poll?: HarnessPollEvents;
  readonly keepAliveMillis?: number;
  readonly onActiveChange?: (active: boolean) => void;
}

/** Official SDK request handlers and the daemon's content-free wakeup edge. */
export interface HarnessEvents {
  readonly install: (server: McpServer["server"], principal?: string) => void;
  readonly hasActiveSubscription: () => boolean;
  readonly notifyPending: () => boolean;
  readonly close: Effect.Effect<void>;
  readonly status: Effect.Effect<WebhookStatus, ProtocolError>;
  readonly revoke: Effect.Effect<void, ProtocolError>;
  readonly resume: Effect.Effect<void, ProtocolError>;
  readonly nativeOperation: <A, E>(
    metadata: unknown,
    operation: Effect.Effect<A, E>,
    required: boolean,
  ) => Effect.Effect<A, E | ProtocolError>;
}

/**
 * Validate the event name separately from its argument grammar for draft errors.
 * @param name Event type supplied by the caller.
 */
const requireInboxEvent = (name: string): void => {
  if (name !== INBOX_PENDING_EVENT) {
    throw new ProtocolError(-32011, "Event not found", { kind: "event" });
  }
};

const requireNoReplay = (cursor?: string | null): void => {
  if (cursor != null) {
    throw new ProtocolError(
      -32014,
      "Event replay is unavailable; read the pending inbox",
      { feature: "cursor" },
    );
  }
};

const requireProtocolActive = (options: EventsOptions): void => {
  if (!options.protocolActive()) {
    throw new ProtocolError(-32012, "Endpoint is not registered");
  }
};

const requireAvailable = (occupied: boolean): void => {
  if (occupied) {
    throw consumerConflict();
  }
};

const notify = (
  push: ActivePush,
  method: string,
  params: Readonly<Record<string, unknown>>,
) =>
  Effect.tryPromise({
    try: () =>
      push.context.mcpReq.notify({
        method,
        params: {
          ...params,
          _meta: { [SUBSCRIPTION_ID_META_KEY]: push.context.mcpReq.id },
        },
      }),
    catch: () => new ProtocolError(-32603, "Event transport failed"),
  });

/* eslint-disable agent-code-guard/async-keyword -- Official SDK callbacks consume a Promise at this boundary. */
/**
 * SDK transport closure can finish before request promises settle. The handler
 * scope owns each operation until its finalizers finish, including after the
 * request aborts. The captured runtime preserves composition services across the
 * SDK Promise boundary, among them the tracer an opt-in span export installs.
 * Explicit interruptibility survives uninterruptible acquisition.
 */
export const runRequest = <Value, Failure>(
  operation: Effect.Effect<Value, Failure>,
  signal: AbortSignal,
  scope: Scope.CloseableScope,
  services: Runtime.Runtime<never>,
) =>
  Runtime.runPromiseExit(services)(
    Effect.acquireUseRelease(
      Effect.forkIn(Effect.interruptible(operation), scope),
      Fiber.join,
      Fiber.interrupt,
    ),
    { signal },
  );

/**
 * Preserve the draft's protocol errors across the Effect and SDK boundary.
 * @param operation Validated Events operation.
 * @param signal Cancellation owned by the MCP request.
 * @param requestScope The lifetime that joins request finalizers before closing.
 * @param services The trusted daemon services captured when the handler is acquired.
 * @returns The SDK result or a sanitized protocol exception.
 */
export const runEventOperation = async <A, E>(
  operation: Effect.Effect<A, E>,
  signal: AbortSignal,
  requestScope: Scope.CloseableScope,
  services: Runtime.Runtime<never>,
) => {
  const outcome = await runRequest(operation, signal, requestScope, services);
  if (Exit.isSuccess(outcome)) {
    return outcome.value;
  }
  const failure = Option.getOrElse(Cause.failureOption(outcome.cause), () =>
    Option.getOrUndefined(Cause.dieOption(outcome.cause)),
  );
  throw ProtocolError.isInstance(failure)
    ? failure
    : new ProtocolError(-32603, "Event operation failed");
};

/* eslint-enable agent-code-guard/async-keyword -- Remaining operations use Effect. */

interface EventsRuntime {
  readonly services: Runtime.Runtime<never>;
  readonly options: EventsOptions;
  readonly lifetime: Scope.CloseableScope;
  readonly wakeups: Queue.Queue<boolean>;
  active?: ActivePush;
  closed: boolean;
  revocations: number;
  reportedActive: boolean;
}
const hasPollingConsumer = (runtime: EventsRuntime) =>
  runtime.options.poll?.hasActiveSubscription() ?? false;
const hasWebhookConsumer = (runtime: EventsRuntime) =>
  runtime.options.webhook?.hasActiveSubscription() ?? false;
const admissionClosed = (runtime: EventsRuntime) =>
  runtime.closed || runtime.revocations > 0;
const hasConsumer = (runtime: EventsRuntime) =>
  runtime.active !== undefined ||
  hasPollingConsumer(runtime) ||
  hasWebhookConsumer(runtime);
const reportOwnership = (runtime: EventsRuntime) => {
  const active = hasConsumer(runtime);
  if (active !== runtime.reportedActive) {
    runtime.reportedActive = active;
    runtime.options.onActiveChange?.(active);
  }
};
const publishPush = (push: ActivePush, summary: InboxSummary) => {
  if (
    !push.ready ||
    summary.pendingCount === 0 ||
    push.previousSequence === summary.newestSequence
  ) {
    return Effect.void;
  }
  return notify(push, "notifications/events/event", {
    eventId: `wake_${randomUUID()}`,
    name: INBOX_PENDING_EVENT,
    timestamp: new Date().toISOString(),
    data: { pendingCount: summary.pendingCount },
    cursor: null,
  }).pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        push.previousSequence = summary.newestSequence;
      }),
    ),
  );
};
const dispatch = (runtime: EventsRuntime, summary: InboxSummary) => {
  const push = runtime.active;
  return push === undefined
    ? (runtime.options.webhook?.observe() ?? Effect.void)
    : publishPush(push, summary).pipe(
        Effect.catchAll(() =>
          Deferred.succeed(push.stop, undefined).pipe(Effect.asVoid),
        ),
      );
};
const publish = (runtime: EventsRuntime) =>
  runtime.options.gate
    .withPermits(1)(
      runtime.options
        .summary()
        .pipe(Effect.map((summary) => dispatch(runtime, summary))),
    )
    .pipe(
      Effect.flatten,
      Effect.tap(() =>
        Effect.sync(() => {
          reportOwnership(runtime);
        }),
      ),
      Effect.catchAll(() =>
        Effect.logWarning(
          "MCP Events delivery deferred after a persistence failure",
        ),
      ),
    );
const releasePush = (runtime: EventsRuntime, push: ActivePush) =>
  Effect.sync(() => {
    if (runtime.active === push) {
      delete runtime.active;
      reportOwnership(runtime);
    }
  }).pipe(Effect.zipRight(Deferred.succeed(push.closed, undefined)));
const keepAlive = (runtime: EventsRuntime, push: ActivePush) =>
  Effect.sleep(runtime.options.keepAliveMillis ?? 20_000).pipe(
    Effect.zipRight(
      notify(push, "notifications/events/heartbeat", { cursor: null }),
    ),
    Effect.forever,
    Effect.catchAll(() => Deferred.succeed(push.stop, undefined)),
    Effect.forkScoped,
  );
const stream = (
  runtime: EventsRuntime,
  input: EventStreamInput,
  context: ServerContext,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* Effect.sync(() => {
        requireProtocolActive(runtime.options);
        requireInboxEvent(input.name);
        requireNoReplay(input.cursor);
      });
      const stop = yield* Deferred.make<undefined>();
      const closed = yield* Deferred.make<undefined>();
      const push: ActivePush = {
        context,
        stop,
        closed,
        ready: false,
        previousSequence: -1,
      };
      yield* Effect.addFinalizer(() => releasePush(runtime, push));
      yield* runtime.options.gate.withPermits(1)(
        Effect.sync(() => {
          requireAvailable(admissionClosed(runtime) || hasConsumer(runtime));
          runtime.active = push;
        }),
      );
      yield* notify(push, "notifications/events/active", {
        cursor: null,
        truncated: false,
      });
      yield* Effect.sync(() => {
        push.ready = true;
        reportOwnership(runtime);
        runtime.wakeups.unsafeOffer(true);
      });
      yield* keepAlive(runtime, push);
      yield* Deferred.await(stop);
      return {};
    }),
  );

const descriptor = () => ({
  name: INBOX_PENDING_EVENT,
  description:
    "Runtime wakeup for pending Social Harness items. Read pending items with read_inbox.",
  delivery: ["push"],
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  payloadSchema: {
    type: "object",
    properties: { pendingCount: { type: "integer", minimum: 0 } },
    required: ["pendingCount"],
    additionalProperties: false,
  },
});
const streamForPrincipal = (
  runtime: EventsRuntime,
  input: EventStreamInput,
  context: ServerContext,
  principal: string,
) =>
  principal === "runtime"
    ? Effect.fail(
        new ProtocolError(-32014, "Native inbox streaming is unavailable", {
          feature: "stream",
        }),
      )
    : stream(runtime, input, context);

const itemDescriptors = (runtime: EventsRuntime) => {
  const delivery = [
    ...(runtime.options.poll === undefined ? [] : ["poll"]),
    ...(runtime.options.webhook === undefined ? [] : ["webhook"]),
  ];
  return delivery.length === 0
    ? []
    : [
        {
          name: INBOX_ITEM_EVENT,
          description:
            "A Social Harness message, collective request, result, or failure. Large events reference their full content through read_event. Processing and notifications follow the user's task configuration.",
          delivery,
          inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
          payloadSchema: itemEventDataJsonSchema,
        },
      ];
};

/** SDK validation exceptions become typed refusals for consumer-lifetime handling. */
const authorizePoll = (runtime: EventsRuntime) =>
  Effect.sync(() => {
    requireProtocolActive(runtime.options);
    requireAvailable(
      admissionClosed(runtime) ||
        runtime.active !== undefined ||
        hasWebhookConsumer(runtime),
    );
  }).pipe(
    Effect.catchAllDefect((cause) =>
      ProtocolError.isInstance(cause) ? Effect.fail(cause) : Effect.die(cause),
    ),
  );

const poll = (
  runtime: EventsRuntime,
  input: EventPollInput,
  metadata: unknown,
) =>
  (
    runtime.options.poll?.poll(input, metadata, authorizePoll(runtime)) ??
    Effect.fail(
      new ProtocolError(
        -32014,
        "Polling requires an authenticated daemon with an admitted inbox. Docs: https://github.com/social-harness/moltzap/blob/main/docs/spec/harness/ingress.md#polling-consumer",
        { feature: "poll" },
      ),
    )
  ).pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        reportOwnership(runtime);
      }),
    ),
  );

const installReadHandlers = (
  runtime: EventsRuntime,
  server: McpServer["server"],
  principal = "local",
) => {
  server.setRequestHandler(
    "events/list",
    { params: eventListInput },
    (input) => {
      if (input.cursor !== undefined) {
        throw new ProtocolError(-32602, "Invalid event catalog cursor");
      }
      return {
        events: [
          ...(principal === "runtime" ? [] : [descriptor()]),
          ...itemDescriptors(runtime),
        ],
      };
    },
  );
  server.setRequestHandler(
    "events/poll",
    { params: eventPollInput },
    (input, context) =>
      runEventOperation(
        poll(runtime, input, context.mcpReq._meta),
        context.mcpReq.signal,
        runtime.lifetime,
        runtime.services,
      ),
  );
  server.setRequestHandler(
    "events/stream",
    { params: eventStreamInput },
    (input, context) =>
      runEventOperation(
        streamForPrincipal(runtime, input, context, principal),
        context.mcpReq.signal,
        runtime.lifetime,
        runtime.services,
      ),
  );
};
const subscribe = (
  runtime: EventsRuntime,
  input: EventSubscribeInput,
  principal?: string,
) => {
  requireProtocolActive(runtime.options);
  if (input.name !== INBOX_ITEM_EVENT) {
    throw new ProtocolError(-32011, "Event not found", { kind: "event" });
  }
  requireNoReplay(input.cursor);
  const webhook = runtime.options.webhook;
  if (
    webhook === undefined ||
    principal === undefined ||
    input.delivery.mode !== "webhook"
  ) {
    throw new ProtocolError(-32014, "Webhook delivery is unavailable", {
      feature: "deliveryMode",
      value: input.delivery.mode,
    });
  }
  return webhook
    .subscribe(
      input,
      principal,
      Effect.sync(() => {
        requireAvailable(
          admissionClosed(runtime) ||
            runtime.active !== undefined ||
            hasPollingConsumer(runtime),
        );
      }),
    )
    .pipe(
      Effect.map((grant) => ({ ...grant })),
      Effect.tap(() =>
        Effect.sync(() => {
          reportOwnership(runtime);
          runtime.wakeups.unsafeOffer(true);
        }),
      ),
    );
};
const unsubscribe = (
  runtime: EventsRuntime,
  input: EventUnsubscribeInput,
  principal?: string,
) => {
  if (input.name !== INBOX_ITEM_EVENT) {
    throw new ProtocolError(-32011, "Event not found", { kind: "event" });
  }
  const webhook = runtime.options.webhook;
  if (webhook === undefined || principal === undefined) {
    throw new ProtocolError(-32011, "Subscription not found", {
      kind: "subscription",
    });
  }
  return webhook.unsubscribe(input, principal).pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        reportOwnership(runtime);
      }),
    ),
    Effect.as({}),
  );
};
const install = (
  runtime: EventsRuntime,
  server: McpServer["server"],
  principal = "local",
) => {
  installReadHandlers(runtime, server, principal);
  server.setRequestHandler(
    "events/subscribe",
    { params: eventSubscribeInput },
    (input, context) =>
      runEventOperation(
        subscribe(runtime, input, principal),
        context.mcpReq.signal,
        runtime.lifetime,
        runtime.services,
      ),
  );
  server.setRequestHandler(
    "events/unsubscribe",
    { params: eventUnsubscribeInput },
    (input, context) =>
      runEventOperation(
        unsubscribe(runtime, input, principal),
        context.mcpReq.signal,
        runtime.lifetime,
        runtime.services,
      ),
  );
};
/** Cancel requests before waiting for the ownership gate they may hold. */
const close = (runtime: EventsRuntime) =>
  Effect.gen(function* () {
    runtime.closed = true;
    yield* Scope.close(runtime.lifetime, Exit.void);
    yield* runtime.options.poll?.revoke ?? Effect.void;
  });
const status = (
  runtime: EventsRuntime,
): Effect.Effect<WebhookStatus, ProtocolError> =>
  Effect.suspend(() => {
    if (runtime.active !== undefined) {
      return Effect.succeed({ mode: "push" });
    }
    if (runtime.options.poll?.hasActiveSubscription()) {
      return runtime.options.poll.status;
    }
    return runtime.options.webhook?.status ?? Effect.succeed({ mode: "none" });
  });
const revoke = (runtime: EventsRuntime) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      runtime.revocations += 1;
      return runtime.active;
    }),
    (push) =>
      Effect.gen(function* () {
        if (push !== undefined) {
          yield* Deferred.succeed(push.stop, undefined);
          yield* Deferred.await(push.closed);
        }
        yield* runtime.options.poll?.revoke ?? Effect.void;
        yield* runtime.options.webhook?.revoke ?? Effect.void;
      }),
    () =>
      Effect.sync(() => {
        runtime.revocations -= 1;
        reportOwnership(runtime);
      }),
  );

/** Owner diagnostics remain usable without a poll consumer; native receipts are fenced. */
const nativeOperation = <A, E>(
  runtime: EventsRuntime,
  metadata: unknown,
  operation: Effect.Effect<A, E>,
  required: boolean,
) =>
  runtime.options.poll?.nativeOperation(metadata, operation, required) ??
  decodeConsumerMetadata(metadata).pipe(
    Effect.catchTag("ParseError", () => Effect.fail(invalidMetadata())),
    Effect.flatMap(
      (binding): Effect.Effect<A, E | ProtocolError> =>
        required || binding !== undefined
          ? Effect.fail(consumerLost())
          : operation,
    ),
  );
const assembled = (runtime: EventsRuntime): HarnessEvents => ({
  install: (server, principal) => {
    install(runtime, server, principal);
  },
  hasActiveSubscription: () => hasConsumer(runtime),
  notifyPending: () => {
    if (runtime.closed) {
      return false;
    }
    runtime.wakeups.unsafeOffer(true);
    return true;
  },
  close: close(runtime),
  status: status(runtime),
  revoke: revoke(runtime),
  nativeOperation: (metadata, operation, required) =>
    nativeOperation(runtime, metadata, operation, required),
  resume: (runtime.options.webhook?.resume ?? Effect.void).pipe(
    Effect.tap(() => Effect.sync(() => runtime.wakeups.unsafeOffer(true))),
  ),
});

/**
 * Own one consumer while the official SDK handles request validation and framing.
 * @param options Classified inbox counters, callback edge and lifecycle.
 * @returns SDK installers and an explicit close for retained event resources.
 */
export const makeHarnessEvents = (
  options: EventsOptions,
): Effect.Effect<HarnessEvents> =>
  Effect.gen(function* () {
    const lifetime = yield* Scope.make();
    const wakeups = yield* Queue.sliding<boolean>(1);
    const runtime: EventsRuntime = {
      services: yield* Effect.runtime(),
      options,
      lifetime,
      wakeups,
      closed: false,
      revocations: 0,
      reportedActive: false,
    };
    yield* Scope.addFinalizer(lifetime, Queue.shutdown(wakeups));
    yield* Queue.take(wakeups).pipe(
      Effect.zipRight(publish(runtime)),
      Effect.forever,
      Effect.forkIn(lifetime),
    );
    if (options.webhook !== undefined || options.poll !== undefined) {
      yield* Effect.sleep(1000).pipe(
        Effect.tap(() => Effect.sync(() => wakeups.unsafeOffer(true))),
        Effect.forever,
        Effect.forkIn(lifetime),
      );
      wakeups.unsafeOffer(true);
    }
    return assembled(runtime);
  }).pipe(Effect.withSpan("makeHarnessEvents"));
