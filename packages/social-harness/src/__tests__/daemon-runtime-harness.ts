/** @file A daemon runtime harness over fake engine, worker, store and Registry and Router services, for lifecycle tests. */

import { NodeFileSystem } from "@effect/platform-node";
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import { type Context, Deferred, Duration, Effect } from "effect";
import type { EventStore } from "../host-protocol/operations.js";
import type { Fixture } from "./daemon-runtime-fixtures.js";
import {
  DeliveryAcknowledgeError,
  ListenError,
} from "../communication/conversations/errors.js";
import {
  type EndpointEngine,
  EngineOutboundError,
  type EnginePendingMessage,
} from "../communication/conversations/index.js";
import { Router } from "../communication/router/api/client.js";
import {
  type RouterWorker,
  RouterWorkerPersistenceError,
} from "../communication/router/index.js";
import {
  type DeliveryToken,
  type EndpointRecovery,
  type EndpointStore,
  EndpointStoreError,
  type IdentityBinding,
} from "../communication/store/index.js";
import {
  type DaemonRuntimeDependencies,
  DaemonRuntimeError,
  runDaemonRuntime,
} from "../daemon/lifecycle.js";
import { readDaemonRegistrationState } from "../daemon/registration/index.js";
import { sameBytes } from "../encoding/canonical-json.js";
import { makeHistoryExport } from "../daemon/inbox/host-traffic-log.js";
import {
  type HarnessMcpEventHandler,
  type HarnessMcpOperations,
  makeHarnessMcpHttpHandler,
} from "../daemon/mcp/tools.js";
import { INBOX_PENDING_EVENT } from "../host-protocol/names.js";
import { Registry } from "../identity/registry/index.js";
import { AuthenticationFailedError } from "../identity/signing/http-errors.js";
import { collectiveStorageStub } from "./collective-storage-stub.js";
import { unusedEndpointStore } from "./unused-endpoint-store.js";

/** The MCP handler the daemon installed; throws before installation. */
export function requireHandler(
  harness: RuntimeHarness,
): HarnessMcpEventHandler {
  const handler = harness.getHandler();
  if (handler === undefined) {
    throw new Error("missing composed MCP handler");
  }
  return handler;
}

/** The event store the daemon gave its MCP handler; throws before installation. */
export function requireEventStore(harness: RuntimeHarness): EventStore {
  const eventStore = harness.getEventStore();
  if (eventStore === undefined) {
    throw new Error("missing composed event store");
  }
  return eventStore;
}

/** The MCP operations the daemon installed; throws before installation. */
export function requireOperations(
  harness: RuntimeHarness,
): HarnessMcpOperations {
  const operations = harness.getOperations();
  if (operations === undefined) {
    throw new Error("missing composed MCP operations");
  }
  return operations;
}

const SUBSCRIPTIONS_LISTEN_METHOD = "events/stream";
/** The notification acknowledging an MCP Events subscription. */
export const SUBSCRIPTIONS_ACKNOWLEDGED_NOTIFICATION =
  "notifications/events/active";
const MODERN_PROTOCOL_VERSION = "2026-07-28";
/** The failure a supervised background fiber's exit raises in the daemon. */
export const EXPECTED_LISTENER_FAILURE = new DaemonRuntimeError({
  phase: "listener",
});

/**
 * The fake engine retains its pending delivery until acknowledgment. Inbox
 * acknowledgment retires that delivery, matching the store transaction.
 */
interface DeliveryState {
  readonly pending: EnginePendingMessage;
  acknowledged: boolean;
  readBarrier?: ReadBarrier;
  failReads?: boolean;
}

/** Holds the harness engine's next pending read until released. */
export interface ReadBarrier {
  readonly entered: Deferred.Deferred<undefined>;
  readonly release: Deferred.Deferred<undefined>;
}

interface HarnessSignals {
  readonly engineEntered: Deferred.Deferred<undefined>;
  readonly engineRelease: Deferred.Deferred<undefined>;
  readonly failure: Deferred.Deferred<undefined>;
  readonly listenerReady: Deferred.Deferred<undefined>;
}

interface HarnessObservations {
  handler?: HarnessMcpEventHandler;
  eventStore?: EventStore;
  operations?: HarnessMcpOperations;
}

interface RuntimeDependenciesInput {
  readonly background: BackgroundFailure;
  readonly blockEngine: boolean;
  readonly delivery: DeliveryState;
  readonly observations: HarnessObservations;
  readonly signals: HarnessSignals;
}

/** The harness's dependencies, signals, observations and captured edges. */
export interface RuntimeHarness {
  readonly dependencies: DaemonRuntimeDependencies;
  readonly delivery: DeliveryState;
  readonly engineEntered: Deferred.Deferred<undefined>;
  readonly engineRelease: Deferred.Deferred<undefined>;
  readonly failure: Deferred.Deferred<undefined>;
  readonly listenerReady: Deferred.Deferred<undefined>;
  readonly getEventStore: () => EventStore | undefined;
  readonly getHandler: () => HarnessMcpEventHandler | undefined;
  readonly getOperations: () => HarnessMcpOperations | undefined;
}

type BackgroundFailure = "none" | "outbound" | "worker";

const emptyRecovery = (identity?: IdentityBinding): EndpointRecovery => ({
  identity,
  postIntents: [],
  memberships: [],
  anchors: [],
  positions: [],
  proposalLocks: [],
  stagedRecords: [],
  evidence: [],
  certifiedRecords: [],
  stagedReanchors: [],
  pendingDeliveries: [],
  disseminationObligations: [],
  outboundMessages: [],
});

const makeInboxStore = (onAcknowledge: () => void) => {
  const inbox = new Map<DeliveryToken, Uint8Array>();
  const acknowledged = new Set<DeliveryToken>();
  return {
    readInbox: () =>
      Effect.succeed({
        items: [...inbox]
          .filter(([token]) => !acknowledged.has(token))
          .map(([deliveryToken, canonicalItem], index) => ({
            sequence: index + 1,
            deliveryToken,
            canonicalItem,
          })),
        through: inbox.size,
      }),
    readInboxSummary: () =>
      Effect.succeed({
        pendingCount: [...inbox.keys()].filter(
          (token) => !acknowledged.has(token),
        ).length,
        newestSequence: inbox.size,
      }),
    putInboxItem: (item) =>
      Effect.sync(() => {
        inbox.set(item.deliveryToken, item.canonicalItem);
        return "inserted" as const;
      }),
    acknowledgeInboxItem: (token) =>
      Effect.sync(() => {
        acknowledged.add(token);
        onAcknowledge();
      }),
  } satisfies Pick<
    EndpointStore,
    "readInbox" | "readInboxSummary" | "putInboxItem" | "acknowledgeInboxItem"
  >;
};

/**
 * A store over the fixture's identity, bound when `active`, whose inbox lives
 * in memory and whose acknowledgments retire the harness delivery.
 */
export function makeStore(
  fixture: Fixture,
  active: boolean,
  delivery?: DeliveryState,
): EndpointStore {
  const onAcknowledge = () => {
    if (delivery !== undefined) {
      delivery.acknowledged = true;
    }
  };
  let identity: IdentityBinding | undefined = active
    ? {
        agentId: fixture.localCard.agentId,
        canonicalAgentCard: fixture.canonicalLocalCard,
      }
    : undefined;
  return {
    ...unusedEndpointStore("daemon runtime test"),
    ...collectiveStorageStub(),
    readInboxItem: () => Effect.succeed(undefined),
    completeWebhookDelivery: () => Effect.void,
    ...makeInboxStore(onAcknowledge),
    readPendingDeliveries: () => Effect.succeed([]),
    readIdentity: () => Effect.succeed(identity),
    bindIdentity: (candidate) =>
      Effect.suspend(() => {
        if (identity === undefined) {
          identity = candidate;
          return Effect.succeed("inserted" as const);
        }
        if (
          identity.agentId !== candidate.agentId ||
          !sameBytes(identity.canonicalAgentCard, candidate.canonicalAgentCard)
        ) {
          return Effect.fail(new EndpointStoreError({ reason: "conflict" }));
        }
        return Effect.succeed("existing" as const);
      }),
    recover: () => Effect.succeed(emptyRecovery(identity)),
  };
}

type Registration = "registered" | "name_taken" | "admission-refused";

/** The Registry's answer to this daemon's registration in one fixture run. */
function registration(
  fixture: Fixture,
  result: Registration,
): ReturnType<Context.Tag.Service<typeof Registry>["register"]> {
  switch (result) {
    case "registered":
      return Effect.succeed({
        kind: "registered",
        agentCard: fixture.localCard,
      });
    case "name_taken":
      return Effect.succeed({ kind: "name_taken" });
    case "admission-refused":
      return Effect.fail(new AuthenticationFailedError());
    default:
      return result satisfies never;
  }
}

function makeServices(fixture: Fixture, result: Registration) {
  const registry: Context.Tag.Service<typeof Registry> = {
    register: () => registration(fixture, result),
    lookup: () => Effect.succeed({ kind: "not_found" }),
  };
  const router: Context.Tag.Service<typeof Router> = {
    send: () => outsideRuntimeTest(),
    poll: () => outsideRuntimeTest(),
  };
  return { registry, router };
}

const makeHarnessSignals: Effect.Effect<HarnessSignals> = Effect.gen(
  function* () {
    return {
      engineEntered: yield* Deferred.make<undefined>(),
      engineRelease: yield* Deferred.make<undefined>(),
      failure: yield* Deferred.make<undefined>(),
      listenerReady: yield* Deferred.make<undefined>(),
    };
  },
);

const closeHandler = (handler: HarnessMcpEventHandler) =>
  Effect.tryPromise({
    try: () => handler.close(),
    catch: () => new Error("failed to close test MCP handler"),
  }).pipe(Effect.ignore);

function makeRuntimeDependencies(
  input: RuntimeDependenciesInput,
): DaemonRuntimeDependencies {
  const worker = makeWorker(input.background, input.signals);
  const engine = makeEngine(input.background, input.signals, input.delivery);
  return {
    makeWorker: () => Effect.succeed(worker),
    makeEngine: () =>
      Effect.gen(function* () {
        yield* Deferred.succeed(input.signals.engineEntered, undefined);
        if (input.blockEngine) {
          yield* Deferred.await(input.signals.engineRelease);
        }
        return engine;
      }),
    makeHandler: (options) =>
      Effect.sync(() => {
        input.observations.operations = options.operations;
        input.observations.eventStore = options.eventStore;
      }).pipe(Effect.zipRight(makeHarnessMcpHttpHandler(options))),
    acquireListener: ({ handler }) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          input.observations.handler = handler;
        }).pipe(
          Effect.zipRight(
            Deferred.succeed(input.signals.listenerReady, undefined),
          ),
        ),
        () => closeHandler(handler),
      ).pipe(Effect.asVoid),
    makeHistoryExport: (path) =>
      makeHistoryExport(path).pipe(Effect.provide(NodeFileSystem.layer)),
  };
}

function makeWorker(
  background: BackgroundFailure,
  signals: HarnessSignals,
): RouterWorker {
  const failure = Deferred.await(signals.failure).pipe(
    Effect.zipRight(Effect.fail(new RouterWorkerPersistenceError())),
  );
  return {
    awaitAnchor: outsideRuntimeTest(),
    currentAnchor: outsideRuntimeTest(),
    pollOnce: outsideRuntimeTest(),
    run: background === "worker" ? failure : Effect.never,
    send: () => outsideRuntimeTest(),
  };
}

function outsideRuntimeTest<Value>(): Effect.Effect<Value> {
  return Effect.dieMessage("outside daemon runtime test");
}

/** The harness engine's pending read: fails, waits at a barrier, or returns. */
const readPending = (delivery: DeliveryState) =>
  Effect.gen(function* () {
    if (delivery.failReads === true) {
      return yield* Effect.fail(
        new ListenError({ reason: "transport-failed" }),
      );
    }
    const messages = delivery.acknowledged ? [] : [delivery.pending];
    const barrier = delivery.readBarrier;
    delivery.readBarrier = undefined;
    if (barrier !== undefined) {
      yield* Deferred.succeed(barrier.entered, undefined);
      yield* Deferred.await(barrier.release);
    }
    return messages;
  });

function makeEngine(
  background: BackgroundFailure,
  signals: HarnessSignals,
  delivery: DeliveryState,
): EndpointEngine {
  const failure = Deferred.await(signals.failure).pipe(
    Effect.zipRight(
      Effect.fail(new EngineOutboundError({ reason: "persistence" })),
    ),
  );
  return {
    observePost: () =>
      Effect.dieMessage(
        "no retained post is observed in this lifecycle fixture",
      ),
    send: () =>
      Effect.succeed({
        postId: delivery.pending.message.postId,
        recordHash: delivery.pending.recordHash,
      }),
    bindChecked: () =>
      Effect.dieMessage("this lifecycle fixture installs no firewall"),
    sendAdmitted: () =>
      Effect.dieMessage("this lifecycle fixture installs no firewall"),
    resolveAddress: () => Effect.void,
    resolveConversation: () =>
      Effect.dieMessage("this lifecycle fixture installs no firewall"),
    readPendingMessages: () => readPending(delivery),
    acknowledgeMessage: (deliveryToken) =>
      deliveryToken !== delivery.pending.deliveryToken
        ? Effect.fail(
            new DeliveryAcknowledgeError({ reason: "unknown-delivery" }),
          )
        : Effect.sync(() => {
            delivery.acknowledged = true;
          }),
    acceptRouterIngress: () => Effect.succeed("ignored"),
    recoverCertifiedHistory: () => Effect.void,
    drainOutbound: Effect.void,
    runOutbound: background === "outbound" ? failure : Effect.never,
    abandonVolatileFolds: () => Effect.void,
    rearmCatchUp: Effect.void,
  };
}

/** A harness whose fake engine and worker fail in the named background. */
export const makeHarness = (
  fixture: Fixture,
  background: BackgroundFailure,
  blockEngine = false,
): Effect.Effect<RuntimeHarness> =>
  Effect.gen(function* () {
    const signals = yield* makeHarnessSignals;
    const observations: HarnessObservations = {};
    const delivery: DeliveryState = {
      pending: fixture.pending,
      acknowledged: false,
    };
    const dependencies = makeRuntimeDependencies({
      background,
      blockEngine,
      delivery,
      observations,
      signals,
    });
    return {
      dependencies,
      delivery,
      ...signals,
      getEventStore: () => observations.eventStore,
      getHandler: () => observations.handler,
      getOperations: () => observations.operations,
    };
  }).pipe(Effect.withSpan("makeHarness"));

/**
 * Run the daemon over the harness and the fixture's Registry and Router,
 * from the registration state the store holds, read once as startup does.
 */
export const run = (
  fixture: Fixture,
  store: EndpointStore,
  harness: RuntimeHarness,
  refusal?: Exclude<Registration, "registered">,
) => {
  const services = makeServices(fixture, refusal ?? "registered");
  return readDaemonRegistrationState({
    store,
    bootstrap: fixture.bootstrap,
  }).pipe(
    Effect.orDie,
    Effect.flatMap((registration) =>
      runDaemonRuntime(
        {
          store,
          bootstrap: fixture.bootstrap,
          registration,
        },
        harness.dependencies,
      ),
    ),
    Effect.provideService(Registry, services.registry),
    Effect.provideService(Router, services.router),
    Effect.scoped,
  );
};

interface McpRequestInput {
  readonly id: string;
  readonly method: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

/** One modern MCP request to the daemon's loopback handler. */
const makeMcpRequest = (input: McpRequestInput): Request =>
  new Request("http://127.0.0.1/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-method": input.method,
      ...input.headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: input.id,
      method: input.method,
      params: {
        ...input.params,
        _meta: {
          [PROTOCOL_VERSION_META_KEY]: MODERN_PROTOCOL_VERSION,
          [CLIENT_INFO_META_KEY]: {
            name: "daemon-runtime-test-client",
            version: "1.0.0",
          },
          [CLIENT_CAPABILITIES_META_KEY]: {},
        },
      },
    }),
    signal: input.signal,
  });

/** An MCP Events subscription request with the given id. */
export const makeListenRequest = (id: string): Request =>
  makeMcpRequest({
    id,
    method: SUBSCRIPTIONS_LISTEN_METHOD,
    params: { name: INBOX_PENDING_EVENT, arguments: {}, cursor: null },
  });

/**
 * A `subscriptions/listen` request with the given id for tool list changes,
 * the stream a host keeps open to hear that the catalog changed.
 */
export const makeToolListChangesRequest = (id: string): Request =>
  makeMcpRequest({
    id,
    method: "subscriptions/listen",
    params: { notifications: { toolsListChanged: true } },
  });

/** A `tools/list` request with the given id. */
export const makeToolListRequest = (id: string): Request =>
  makeMcpRequest({ id, method: "tools/list", params: {} });

/**
 * A `tools/call` request with the given id. Aborting `signal` cancels it, as
 * a client that drops the request does.
 */
export const makeToolCallRequest = (
  input: Pick<McpRequestInput, "id" | "signal"> & {
    readonly name: string;
    readonly toolArguments: Readonly<Record<string, unknown>>;
    readonly metadata?: Readonly<Record<string, unknown>>;
  },
): Request =>
  makeMcpRequest({
    id: input.id,
    method: "tools/call",
    params: {
      name: input.name,
      arguments: input.toolArguments,
      ...(input.metadata === undefined ? {} : { _meta: input.metadata }),
    },
    headers: { "mcp-name": input.name },
    signal: input.signal,
  });

/**
 * Hold the harness engine's next pending read until the barrier is released.
 * @param harness The daemon's harness.
 * @returns The installed barrier; `entered` resolves once a read reaches it.
 */
export const holdNextRead = (harness: RuntimeHarness) =>
  Effect.gen(function* () {
    const barrier: ReadBarrier = {
      entered: yield* Deferred.make<undefined>(),
      release: yield* Deferred.make<undefined>(),
    };
    harness.delivery.readBarrier = barrier;
    return barrier;
  }).pipe(Effect.withSpan("holdNextRead"));

/**
 * Open a streamed MCP response whose reader the enclosing scope cancels.
 * @param handler The daemon's MCP handler.
 * @param request The request whose response streams.
 * @returns A reader over the response body.
 */
export const openStream = (handler: HarnessMcpEventHandler, request: Request) =>
  Effect.acquireRelease(
    Effect.tryPromise(() => handler.fetch(request)).pipe(
      Effect.flatMap((response) =>
        Effect.fromNullable(response.body).pipe(
          Effect.orElseFail(
            () => new Error("expected a streamed response body"),
          ),
        ),
      ),
      Effect.map((body) => body.getReader()),
    ),
    (reader) => Effect.tryPromise(() => reader.cancel()).pipe(Effect.ignore),
  ).pipe(Effect.withSpan("openStream"));

const frameBuffers = new WeakMap<
  ReadableStreamDefaultReader<Uint8Array>,
  string
>();
const frameData = (frame: string): string =>
  frame
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");

/**
 * The next chunk of a streamed body, as text.
 * @param reader The streamed response's reader.
 * @param stage Names the awaited frame in a failure.
 * @returns The chunk's text; the trace dies when the stream has ended.
 */
const readChunk = (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  stage: string,
) =>
  Effect.tryPromise({
    try: () => reader.read(),
    catch: () => new Error(`failed to read ${stage}`),
  }).pipe(
    Effect.flatMap((chunk) =>
      chunk.done
        ? Effect.dieMessage(
            `${stage}: the stream ended before an SSE data frame`,
          )
        : Effect.succeed(new TextDecoder().decode(chunk.value)),
    ),
  );

/**
 * The next server-sent frame's data, parsed. Bytes past that frame stay
 * buffered for the reader's next read.
 * @param reader The streamed response's reader.
 * @param stage Names the frame in a failure.
 * @returns The frame's parsed data.
 */
const readFrame = (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  stage: string,
) =>
  Effect.gen(function* () {
    let buffered = frameBuffers.get(reader) ?? "";
    while (true) {
      const end = buffered.indexOf("\n\n");
      if (end >= 0) {
        const frame = buffered.slice(0, end);
        buffered = buffered.slice(end + 2);
        frameBuffers.set(reader, buffered);
        const data = frameData(frame);
        if (data !== "") {
          const parsed: unknown = JSON.parse(data);
          return parsed;
        }
      } else {
        buffered += yield* readChunk(reader, stage);
      }
    }
  });

/**
 * How long one stage may wait for its signal. It only bounds a hang, and it
 * is well under the test timeout of each file that awaits stages, so a hung
 * stage fails with its name and the test still reaches its cleanup.
 */
const STAGE_HANG_BOUND = Duration.seconds(20);

/**
 * Await an effect for one named stage. Each stage completes on a signal the
 * runtime raises; one still waiting after `STAGE_HANG_BOUND` fails with
 * `timed out awaiting` and the stage's name, which also names its span.
 */
export const awaitStage = <Value, Failure>(
  effect: Effect.Effect<Value, Failure>,
  stage: string,
): Effect.Effect<Value, Failure | Error> =>
  effect.pipe(
    Effect.timeoutFail({
      duration: STAGE_HANG_BOUND,
      onTimeout: () => new Error(`timed out awaiting ${stage}`),
    }),
    Effect.withSpan(stage),
  );

/** Await the next server-sent frame for one named stage. */
export const awaitFrame = (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  stage: string,
): Effect.Effect<unknown, Error> => awaitStage(readFrame(reader, stage), stage);
