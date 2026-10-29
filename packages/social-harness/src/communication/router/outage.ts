/**
 * @file Router outage handling: classifying Router client failures as outages
 * or rejections, and the worker's detachment, reattachment, and warnings.
 */

import { Clock, Effect, Option, Ref, Schedule, Stream } from "effect";
import {
  isTransientRouterWorkerError,
  routerWorkerBlipSchedule,
  routerWorkerDetachedReportInterval,
  type RouterWorkerDetachedState,
  type RouterWorkerPollError,
  type RouterWorkerRecoveringState,
  RouterWorkerRejectedError,
  type RouterWorkerRuntime,
  type RouterWorkerSendError,
  type RouterWorkerServices,
  type RouterWorkerState,
  RouterWorkerTransportError,
} from "./worker-contracts.js";

/** Every failure the Router client raises; poll and send share one union. */
type RouterCallError = Effect.Effect.Error<
  ReturnType<RouterWorkerServices["router"]["poll"]>
>;

/** Any tagged worker failure. */
type TaggedFailure = Readonly<{ _tag: string }>;

/** Worker failure a Router call maps to. */
export type RouterCallFailure =
  | RouterWorkerTransportError
  | RouterWorkerRejectedError;

const transportFailure = () => new RouterWorkerTransportError();
const rejectedFailure = (reason: RouterWorkerRejectedError["reason"]) => () =>
  new RouterWorkerRejectedError({ reason });

/**
 * Outage-shaped Router failures (unreachable, timed out, 429, 5xx) are
 * transport failures the worker waits out. A refusal of the request itself
 * (401, 412 version mismatch, other 4xx, an undecodable answer, or a local
 * signing failure) cannot succeed on retry and is a rejection.
 */
const routerFailureByTag = {
  AgentSigningError: rejectedFailure("signing"),
  AuthenticationFailedError: rejectedFailure("authentication"),
  InternalServerError: transportFailure,
  MalformedRequestError: rejectedFailure("request"),
  MethodNotAllowedError: rejectedFailure("request"),
  OverloadedError: transportFailure,
  PayloadTooLargeError: rejectedFailure("request"),
  RouteNotFoundError: rejectedFailure("request"),
  RouterConnectionError: transportFailure,
  RouterInvalidResponseError: rejectedFailure("response"),
  RouterRequestTimeoutError: transportFailure,
  UnavailableError: transportFailure,
  UnsupportedMediaTypeError: rejectedFailure("request"),
  VersionMismatchError: rejectedFailure("version"),
} as const satisfies Readonly<
  Record<RouterCallError["_tag"], () => RouterCallFailure>
>;

/**
 * Classify one Router client failure as an outage or a rejection.
 * @param error Failure the Router client raised.
 * @returns The worker failure it maps to.
 */
export const mapRouterFailure = (error: RouterCallError): RouterCallFailure =>
  routerFailureByTag[error._tag]();

/**
 * Whether a worker failure is a Router outage rather than a rejection.
 * @param error Any tagged worker failure.
 * @returns True for `RouterWorkerTransportError`.
 */
export const isTransportFailure = (error: TaggedFailure): boolean =>
  error._tag === "RouterWorkerTransportError";

/** Quick retries of one Router poll, for transport failures only. */
export const pollBlipRetry = routerWorkerBlipSchedule.pipe(
  Schedule.whileInput(isTransportFailure),
);

const secondsSince = (since: number): Effect.Effect<number> =>
  Clock.currentTimeMillis.pipe(
    Effect.map((now) => Math.round((now - since) / 1000)),
  );

const logDetached = (state: RouterWorkerDetachedState): Effect.Effect<void> =>
  Effect.logWarning(
    "Router unreachable: worker detached; sends wait until it answers",
  ).pipe(
    Effect.annotateLogs({
      generation: state.generation,
      routerInstanceId: state.anchor.routerInstanceId,
    }),
  );

const logReattached = (state: RouterWorkerDetachedState): Effect.Effect<void> =>
  secondsSince(state.detachedAt).pipe(
    Effect.flatMap((seconds) =>
      Effect.logInfo(
        `Router answered: worker reattached after ${String(seconds)} s`,
      ).pipe(
        Effect.annotateLogs({
          generation: state.generation,
          routerInstanceId: state.anchor.routerInstanceId,
          detachedSeconds: seconds,
        }),
      ),
    ),
  );

/**
 * Mark the worker detached after a poll issued at `generation` lost the
 * Router through its quick retries, so sends and the outbound drain wait for
 * the next answered poll instead of transmitting. A generation that recovery
 * has since replaced stays as it is.
 * @param runtime Worker whose poll lost the Router.
 * @param generation Generation the failed poll was issued from.
 * @returns Completion once a matching active state is detached.
 */
export const detach = <Payload>(
  runtime: RouterWorkerRuntime<Payload>,
  generation: number,
): Effect.Effect<void> =>
  Clock.currentTimeMillis.pipe(
    Effect.flatMap((detachedAt) =>
      runtime.stateGate.withPermits(1)(
        Ref.modify(
          runtime.state,
          (
            state,
          ): readonly [
            Option.Option<RouterWorkerDetachedState>,
            RouterWorkerState,
          ] => {
            if (state.kind !== "active" || state.generation !== generation) {
              return [Option.none(), state];
            }
            const detached: RouterWorkerDetachedState = {
              ...state,
              kind: "detached",
              detachedAt,
            };
            return [Option.some(detached), detached];
          },
        ),
      ),
    ),
    Effect.flatMap(
      Option.match({ onNone: () => Effect.void, onSome: logDetached }),
    ),
  );

/** A worker waiting on an unreachable Router, detached or recovering. */
interface Stall {
  readonly kind: "detached" | "recovering";
  readonly generation: number;
  readonly since: number;
}

const stallOf = (state: RouterWorkerState): Option.Option<Stall> => {
  switch (state.kind) {
    case "active":
      return Option.none();
    case "detached":
      return Option.some({
        kind: "detached",
        generation: state.generation,
        since: state.detachedAt,
      });
    case "recovering":
      return Option.map(state.unreachableSince, (since) => ({
        kind: "recovering",
        generation: state.generation,
        since,
      }));
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
};

const sameStall = Option.getEquivalence(
  (left: Stall, right: Stall) =>
    left.kind === right.kind &&
    left.generation === right.generation &&
    left.since === right.since,
);

const stallText = {
  detached: "worker detached",
  recovering: "recovery waiting",
} as const satisfies Readonly<Record<Stall["kind"], string>>;

const logStillStalled = (stall: Stall): Effect.Effect<void> =>
  secondsSince(stall.since).pipe(
    Effect.flatMap((seconds) =>
      Effect.logWarning(
        `Router still unreachable: ${stallText[stall.kind]} for ${String(seconds)} s`,
      ).pipe(
        Effect.annotateLogs({
          generation: stall.generation,
          unreachableSeconds: seconds,
        }),
      ),
    ),
  );

/**
 * Repeat a warning every `routerWorkerDetachedReportInterval` for as long as
 * the worker waits on an unreachable Router, detached or recovering, so an
 * outage is never silent however long it lasts.
 * @param runtime Worker whose state is watched.
 * @returns A watcher that runs for the worker's lifetime.
 */
export const reportUnreachable = <Payload>(
  runtime: RouterWorkerRuntime<Payload>,
): Effect.Effect<void> =>
  runtime.state.changes.pipe(
    Stream.map(stallOf),
    Stream.changesWith(sameStall),
    Stream.flatMap(
      Option.match({
        onNone: () => Stream.empty,
        onSome: (stall) =>
          Stream.tick(routerWorkerDetachedReportInterval).pipe(
            Stream.drop(1),
            Stream.mapEffect(() => logStillStalled(stall)),
          ),
      }),
      { switch: true },
    ),
    Stream.runDrain,
  );

/**
 * One line naming why the worker or the outbound drain failed; a Router
 * rejection names what the Router refused.
 * @param error Poll or send failure.
 * @returns Human-readable reason for the log.
 */
export const describeRouterWorkerFailure = (
  error: RouterWorkerPollError | RouterWorkerSendError,
): string =>
  error._tag === "RouterWorkerRejectedError"
    ? `the Router rejected this endpoint's ${error.reason}`
    : error._tag;

const markUnreachable = (
  state: RouterWorkerState,
  error: RouterWorkerPollError,
  now: number,
): RouterWorkerState =>
  state.kind === "recovering" &&
  isTransportFailure(error) &&
  Option.isNone(state.unreachableSince)
    ? { ...state, unreachableSince: Option.some(now) }
    : state;

const logRecoveryAttemptFailed = (
  state: RouterWorkerState,
  error: RouterWorkerPollError,
): Effect.Effect<void> =>
  state.kind === "recovering"
    ? Effect.logWarning(
        `Router recovery attempt failed, retrying: ${describeRouterWorkerFailure(error)}`,
      ).pipe(
        Effect.annotateLogs({
          generation: state.generation,
          reason: state.reason,
        }),
      )
    : Effect.void;

/**
 * Report a failed poll-loop step before the loop retries or ends: a fatal
 * failure logs why the daemon exits, and a failed recovery attempt warns and
 * marks when the Router was first unreachable.
 * @param runtime Worker whose step failed.
 * @param error The step's failure.
 * @returns Completion once the failure is logged and recorded.
 */
export const noteRunFailure = <Payload>(
  runtime: RouterWorkerRuntime<Payload>,
  error: RouterWorkerPollError,
): Effect.Effect<void> =>
  isTransientRouterWorkerError(error)
    ? Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) =>
          runtime.stateGate.withPermits(1)(
            Ref.updateAndGet(runtime.state, (state) =>
              markUnreachable(state, error, now),
            ),
          ),
        ),
        Effect.flatMap((state) => logRecoveryAttemptFailed(state, error)),
      )
    : Effect.logError(
        `Router worker stopping, daemon exits: ${describeRouterWorkerFailure(error)}`,
      );

/**
 * Warn that a worker that had lost the Router now recovers from a
 * discontinuity its first answered probe revealed.
 * @param state The new recovering state.
 * @returns Completion once logged.
 */
export const logRecoveryAfterLoss = (
  state: RouterWorkerRecoveringState,
): Effect.Effect<void> =>
  Effect.logWarning(
    `Router answered after a loss with ${state.reason}: recovering`,
  ).pipe(Effect.annotateLogs({ generation: state.generation }));

/**
 * Note that certified-history recovery finished and the worker is active.
 * @param state The recovering state recovery completed.
 * @returns Completion once logged.
 */
export const logRecoveryComplete = (
  state: RouterWorkerRecoveringState,
): Effect.Effect<void> =>
  Effect.logInfo(`Router recovery complete after ${state.reason}`).pipe(
    Effect.annotateLogs({ generation: state.generation }),
  );

/**
 * Mark a detached worker active again at its retained anchor, unless another
 * generation replaced it meanwhile, and then tell the engine through
 * `callbacks.reattached`, so work the outage paused can start again.
 * @param runtime Worker whose probe the Router answered.
 * @param snapshot Detached state the probe was issued from.
 * @returns Completion once the worker is active or left as it was.
 */
export const reattach = <Payload>(
  runtime: RouterWorkerRuntime<Payload>,
  snapshot: RouterWorkerDetachedState,
): Effect.Effect<void> =>
  runtime.stateGate
    .withPermits(1)(
      Ref.get(runtime.state).pipe(
        Effect.flatMap((current) =>
          current.kind === "detached" &&
          current.generation === snapshot.generation
            ? Ref.set(runtime.state, {
                kind: "active",
                generation: current.generation,
                anchor: current.anchor,
              }).pipe(Effect.zipRight(logReattached(current)), Effect.as(true))
            : Effect.succeed(false),
        ),
      ),
    )
    .pipe(
      Effect.flatMap((reattached) =>
        reattached ? runtime.input.callbacks.reattached() : Effect.void,
      ),
    );
