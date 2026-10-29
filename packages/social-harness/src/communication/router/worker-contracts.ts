/** @file Defines the endpoint's Router connection interfaces, state and retry rules. */

import {
  type Context,
  Data,
  type Effect,
  type Option,
  Schedule,
  type SubscriptionRef,
} from "effect";
import type { VerifiedAgentCard } from "../../identity/cards.js";
import type {
  LiveSignedMessage,
  VerifiedSignedMessage,
} from "../../identity/envelope/signed-message.js";
import type { AgentId } from "../../identity/identifiers.js";
import type { Registry } from "../../identity/index.js";
import type { AgentSigningAuthority } from "../../identity/keys.js";
import type { EndpointStore } from "../store/index.js";
import type { Router } from "./api/client.js";
import type { PollCursor, RouterInstanceId } from "./api/contract.js";

/** An outer sender card could not be resolved, pinned, or authenticated. */
export class RouterWorkerAuthenticationError extends Data.TaggedError(
  "RouterWorkerAuthenticationError",
) {}

/** Endpoint state needed for cursor advancement could not be persisted. */
export class RouterWorkerPersistenceError extends Data.TaggedError(
  "RouterWorkerPersistenceError",
) {}

/** An authenticated outer body is not one closed Client protocol value. */
export class RouterWorkerPayloadInvalidError extends Data.TaggedError(
  "RouterWorkerPayloadInvalidError",
) {}

/**
 * The Router could not be reached, timed out, or answered overloaded,
 * unavailable, or internal error through a bounded run of quick retries, or a
 * send spent its attempts while Router kept losing its retry identity. Either
 * way the work waits for the next attempt rather than failing closed.
 */
export class RouterWorkerTransportError extends Data.TaggedError(
  "RouterWorkerTransportError",
) {}

/** A Router outcome or local envelope violated the private worker contract. */
export class RouterWorkerProtocolError extends Data.TaggedError(
  "RouterWorkerProtocolError",
) {}

/** Certified-history recovery did not complete for the current Router tail. */
export class RouterWorkerRecoveryError extends Data.TaggedError(
  "RouterWorkerRecoveryError",
) {}

/** A caller must resume protocol work from the recovered certified position. */
export class RouterWorkerDiscontinuityError extends Data.TaggedError(
  "RouterWorkerDiscontinuityError",
) {}

/**
 * The Router refused this endpoint's request itself: its authentication, its
 * Social Harness version, its representation, or its local signature. Retrying
 * cannot succeed, so the failure is fatal rather than an outage.
 */
export class RouterWorkerRejectedError extends Data.TaggedError(
  "RouterWorkerRejectedError",
)<{
  readonly reason:
    | "authentication"
    | "version"
    | "request"
    | "response"
    | "signing";
}> {}

/** A normal send was attempted while the worker is detached or recovering. */
export class RouterWorkerUnavailableError extends Data.TaggedError(
  "RouterWorkerUnavailableError",
) {}

/** Closed reason for abandoning process-local protocol folds. */
export type RouterDiscontinuityReason =
  | "feed_gap"
  | "cursor_invalid"
  | "router_restarted";

/** Empty-tail Router position learned from an omitted-cursor poll. */
export interface RouterTailAnchor {
  readonly routerInstanceId: RouterInstanceId;
  readonly pollCursor: PollCursor;
}

/** A verified protocol input either changed durable state or was conclusively irrelevant. */
export type RouterIngressDisposition = "accepted" | "ignored";

/** Closed failures returned by a send. */
export type RouterWorkerSendError =
  | RouterWorkerAuthenticationError
  | RouterWorkerPersistenceError
  | RouterWorkerRejectedError
  | RouterWorkerTransportError
  | RouterWorkerProtocolError
  | RouterWorkerRecoveryError
  | RouterWorkerDiscontinuityError
  | RouterWorkerUnavailableError;

/** Closed failures returned by one poll/recovery transition. */
export type RouterWorkerPollError =
  | RouterWorkerAuthenticationError
  | RouterWorkerPersistenceError
  | RouterWorkerRejectedError
  | RouterWorkerTransportError
  | RouterWorkerProtocolError
  | RouterWorkerRecoveryError
  | RouterWorkerDiscontinuityError
  | RouterWorkerUnavailableError;

/** Verified outer message and its decoded private Client payload. */
export interface RouterWorkerIngress<Payload> {
  readonly routerInstanceId: RouterInstanceId;
  readonly message: LiveSignedMessage & VerifiedSignedMessage;
  readonly senderCard: VerifiedAgentCard;
  readonly payload: Payload;
}

/** Discontinuity recovery input after learning the new empty tail. */
export interface RouterWorkerRecovery {
  readonly reason: RouterDiscontinuityReason;
  readonly anchor: RouterTailAnchor;
}

/** Durable operations required by the Router transport and no other worker path. */
type RouterWorkerOutbox = Pick<
  EndpointStore,
  "enqueueOutbound" | "beginOutbound" | "completeOutbound"
>;

/** Private endpoint callbacks around the Router worker's ordering boundary. */
export interface RouterWorkerCallbacks<Payload> {
  readonly pinSenderCard: (
    card: VerifiedAgentCard,
  ) => Effect.Effect<void, RouterWorkerPersistenceError>;
  readonly decodePayload: (
    message: LiveSignedMessage & VerifiedSignedMessage,
  ) => Effect.Effect<Payload, RouterWorkerPayloadInvalidError>;
  readonly acceptPayload: (
    input: RouterWorkerIngress<Payload>,
  ) => Effect.Effect<RouterIngressDisposition, RouterWorkerPersistenceError>;
  readonly abandonVolatileFolds: (
    reason: RouterDiscontinuityReason,
  ) => Effect.Effect<void>;
  readonly recoverCertifiedHistory: (
    input: RouterWorkerRecovery,
  ) => Effect.Effect<void, RouterWorkerRecoveryError>;
  /** The worker reattached to the same Router instance after an outage. */
  readonly reattached: () => Effect.Effect<void>;
}

/** Complete private construction input for one registered endpoint. */
export interface RouterWorkerInput<Payload> {
  readonly callerAgentId: AgentId;
  readonly callerAgentCard: VerifiedAgentCard;
  /** Durable membership cards available before Registry connectivity. */
  readonly pinnedSenderCards: readonly VerifiedAgentCard[];
  readonly signingAuthority: AgentSigningAuthority;
  readonly outbox: RouterWorkerOutbox;
  readonly callbacks: RouterWorkerCallbacks<Payload>;
}

/** One endpoint-wide Router worker. */
export interface RouterWorker {
  readonly currentAnchor: Effect.Effect<
    RouterTailAnchor,
    RouterWorkerUnavailableError
  >;
  /**
   * The active anchor as soon as one exists: the current anchor while the
   * worker is active, otherwise the anchor the next answered poll or
   * completed recovery publishes. Callers bound the wait; the worker itself
   * never gives up.
   */
  readonly awaitAnchor: Effect.Effect<RouterTailAnchor>;
  readonly pollOnce: Effect.Effect<void, RouterWorkerPollError>;
  /**
   * Polls for the endpoint's lifetime. A transient failure detaches the
   * worker and backs off until the Router answers; only a non-transient
   * failure ends the loop.
   */
  readonly run: Effect.Effect<never, RouterWorkerPollError>;
  readonly send: (
    messageId: string,
  ) => Effect.Effect<void, RouterWorkerSendError>;
}

/** Volatile cursor state for an active Router instance. */
export interface RouterWorkerActiveState {
  readonly kind: "active";
  readonly generation: number;
  readonly anchor: RouterTailAnchor;
}

/** Volatile discontinuity state while certified history is reconciled. */
export interface RouterWorkerRecoveringState {
  readonly kind: "recovering";
  readonly generation: number;
  readonly reason: RouterDiscontinuityReason;
  readonly priorRouterInstanceId?: RouterInstanceId;
  readonly volatileFoldsAbandoned: boolean;
  readonly anchor?: RouterTailAnchor;
  /**
   * Clock epoch milliseconds when a recovery attempt first lost the Router;
   * none once the Router answers the recovery's tail poll.
   */
  readonly unreachableSince: Option.Option<number>;
}

/**
 * Volatile cursor state while the Router stops answering an active worker.
 * The next answered poll either reattaches at the same anchor or starts
 * recovery, so no send runs until the Router's instance is known again.
 */
export interface RouterWorkerDetachedState {
  readonly kind: "detached";
  readonly generation: number;
  readonly anchor: RouterTailAnchor;
  /** Epoch milliseconds of the Clock when the worker detached. */
  readonly detachedAt: number;
}

/** Closed volatile lifecycle of the Router worker. */
export type RouterWorkerState =
  | RouterWorkerActiveState
  | RouterWorkerDetachedState
  | RouterWorkerRecoveringState;

/** Resolved public capabilities consumed by private worker mechanics. */
export interface RouterWorkerServices {
  readonly router: Context.Tag.Service<typeof Router>;
  readonly registry: Context.Tag.Service<typeof Registry>;
}

/** Shared mutable worker runtime, guarded by its three semaphores. */
export interface RouterWorkerRuntime<Payload> extends RouterWorkerServices {
  readonly input: RouterWorkerInput<Payload>;
  readonly cards: Map<AgentId, VerifiedAgentCard>;
  readonly state: SubscriptionRef.SubscriptionRef<RouterWorkerState>;
  readonly pollGate: Effect.Semaphore;
  readonly stateGate: Effect.Semaphore;
  readonly recoveryGate: Effect.Semaphore;
}

/** Outer message with both sender card and signature verified. */
export interface RouterWorkerVerifiedIngress {
  readonly message: LiveSignedMessage & VerifiedSignedMessage;
  readonly senderCard: VerifiedAgentCard;
}

/** Router send outcome relevant above transport representation. */
export type RouterWorkerSendOutcome =
  | Readonly<{ kind: "accepted" }>
  | Readonly<{ kind: "restarted" }>;

/** Attempts one send spends on transport retries and identity-loss resends. */
export const routerWorkerRetryAttempts = 3;
/** Fixed interruptible spacing between bounded attempts. */
export const routerWorkerRetryDelay = "25 millis";

/**
 * Quick retries of one poll before a transport failure detaches the worker,
 * spanning about 350 ms, so a connection reset or a single overloaded answer
 * does not block sends.
 */
export const routerWorkerBlipSchedule = Schedule.exponential("50 millis").pipe(
  Schedule.intersect(Schedule.recurs(3)),
);

/**
 * Backoff for work that waits out an unreachable or re-anchoring Router: the
 * poll loop and the outbound drain. Delays grow from 100 ms to a 5 s cap and
 * are jittered so endpoints do not return in lockstep after a Router restart.
 * It never ends, because a Router outage halts progress rather than failing
 * the endpoint.
 */
export const routerWorkerReconnectSchedule = Schedule.exponential(
  "100 millis",
).pipe(Schedule.union(Schedule.spaced("5 seconds")), Schedule.jittered);

/**
 * How often a worker that cannot reach the Router, detached or recovering,
 * repeats its warning.
 */
export const routerWorkerDetachedReportInterval = "60 seconds";

const transientByTag = {
  RouterWorkerAuthenticationError: false,
  RouterWorkerDiscontinuityError: true,
  RouterWorkerPersistenceError: false,
  RouterWorkerProtocolError: false,
  RouterWorkerRecoveryError: false,
  RouterWorkerRejectedError: false,
  RouterWorkerTransportError: true,
  RouterWorkerUnavailableError: true,
} as const satisfies Readonly<Record<RouterWorkerPollError["_tag"], boolean>>;

/**
 * Whether a worker failure ends once the Router answers and the worker
 * re-anchors. Every other failure is a protocol, persistence, recovery, or
 * Router-rejection fault that stays fatal.
 * @param error Poll or send failure; both unions share these tags.
 * @returns True for transport loss, a pending recovery, or a discontinuity.
 */
export const isTransientRouterWorkerError = (
  error: RouterWorkerPollError | RouterWorkerSendError,
): boolean => transientByTag[error._tag];
