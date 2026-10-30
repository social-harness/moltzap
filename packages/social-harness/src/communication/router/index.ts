/** @file Private Router polling, authenticated ingress, and retry coordination. */

import * as SqlClient from "@effect/sql/SqlClient";
import * as Store from "../store/index.js";
import {
  Effect,
  Encoding,
  Option,
  Ref,
  Schedule,
  Schema,
  Stream,
  SubscriptionRef,
} from "effect";
import { createHash } from "node:crypto";
import type { AgentId } from "../../identity/identifiers.js";
import type { StoredOutboundMessage } from "../store/index.js";
import { decodeCanonical } from "../../encoding/canonical-json.js";
import { AgentCard, type VerifiedAgentCard } from "../../identity/cards.js";
import {
  type LiveSignedMessage,
  SignedMessage,
} from "../../identity/envelope/signed-message.js";
import { Registry } from "../../identity/registry/index.js";
import { Router } from "./api/client.js";
import {
  type RouterInstanceId,
  type RouterPollResult,
  type RouterSendResult,
  SignedMessageDigest,
} from "./api/contract.js";
import {
  detach,
  isTransportFailure,
  logRecoveryAfterLoss,
  logRecoveryComplete,
  mapRouterFailure,
  noteRunFailure,
  pollBlipRetry,
  reattach,
  reportUnreachable,
  type RouterCallFailure,
} from "./outage.js";
import {
  isTransientRouterWorkerError,
  type RouterDiscontinuityReason,
  type RouterTailAnchor,
  type RouterWorker,
  type RouterWorkerActiveState,
  RouterWorkerAuthenticationError,
  type RouterWorkerDetachedState,
  RouterWorkerDiscontinuityError,
  type RouterWorkerInput,
  RouterWorkerPersistenceError,
  type RouterWorkerPollError,
  RouterWorkerProtocolError,
  routerWorkerReconnectSchedule,
  type RouterWorkerRecoveringState,
  routerWorkerRetryAttempts,
  routerWorkerRetryDelay,
  type RouterWorkerRuntime,
  type RouterWorkerSendError,
  type RouterWorkerSendOutcome,
  type RouterWorkerServices,
  type RouterWorkerState,
  RouterWorkerTransportError,
  RouterWorkerUnavailableError,
  type RouterWorkerVerifiedIngress,
} from "./worker-contracts.js";

/** Router-worker errors used by endpoint composition. */
export {
  RouterWorkerAuthenticationError,
  RouterWorkerDiscontinuityError,
  RouterWorkerPayloadInvalidError,
  RouterWorkerPersistenceError,
  RouterWorkerProtocolError,
  RouterWorkerRecoveryError,
  RouterWorkerRejectedError,
  RouterWorkerTransportError,
  RouterWorkerUnavailableError,
} from "./worker-contracts.js";
/** Why the worker or the outbound drain failed, for logs. */
export { describeRouterWorkerFailure } from "./outage.js";
/** Transient-failure policy shared with the endpoint's outbound drain. */
export {
  isTransientRouterWorkerError,
  routerWorkerReconnectSchedule,
} from "./worker-contracts.js";
/** Router-worker protocol and capability types used by endpoint composition. */
export type {
  RouterDiscontinuityReason,
  RouterIngressDisposition,
  RouterTailAnchor,
  RouterWorker,
  RouterWorkerCallbacks,
  RouterWorkerIngress,
  RouterWorkerInput,
  RouterWorkerRecovery,
  RouterWorkerSendError,
} from "./worker-contracts.js";

const mapAuthenticationError = () => new RouterWorkerAuthenticationError();
const mapProtocolError = () => new RouterWorkerProtocolError();
const mapPersistenceError = () => new RouterWorkerPersistenceError();

const anchorFromOmittedResult = (
  result: RouterPollResult,
): Effect.Effect<RouterTailAnchor, RouterWorkerProtocolError> =>
  result.kind === "batch" && result.signedMessages.length === 0
    ? Effect.succeed({
        routerInstanceId: result.routerInstanceId,
        pollCursor: result.pollCursor,
      })
    : Effect.fail(new RouterWorkerProtocolError());

/**
 * Learn one Router instance and empty-tail cursor without replay.
 * @param services Resolved Router and Registry capabilities.
 * @param caller Authenticated local endpoint identity.
 * @returns The immediate empty-tail Router position.
 */
const pollRouterTail = (
  services: RouterWorkerServices,
  caller: Pick<
    RouterWorkerInput<unknown>,
    "callerAgentId" | "signingAuthority"
  >,
): Effect.Effect<
  RouterTailAnchor,
  RouterCallFailure | RouterWorkerProtocolError
> =>
  services.router
    .poll({
      request: {},
      callerAgentId: caller.callerAgentId,
      signingAuthority: caller.signingAuthority,
    })
    .pipe(
      Effect.mapError(mapRouterFailure),
      Effect.retry(pollBlipRetry),
      Effect.flatMap(anchorFromOmittedResult),
      Effect.interruptible,
    );

interface TransmitInput {
  readonly outbound: StoredOutboundMessage;
  readonly message: LiveSignedMessage;
  readonly instance: RouterInstanceId;
  readonly mode: "initial" | "retry";
  readonly attemptsRemaining: number;
}

type OutboundTransportError =
  | RouterWorkerPersistenceError
  | RouterCallFailure
  | RouterWorkerProtocolError;

/**
 * Sends the same stored envelope again under the other Router mode.
 *
 * Router forgets a retry identity at eviction and refuses an `initial` for
 * any retained identity, even with identical bytes. So a `retry` that finds no
 * retained identity goes out again as `initial`, and an `initial` that
 * conflicts asks again as `retry`, which Router accepts only for
 * byte-identical bytes. Any other pairing of mode and result fails closed.
 *
 * The conflict path spends no attempt, so an `initial` that conflicts with a
 * slower copy of itself still gets its answer on the last attempt. The
 * unknown-identity path spends one, so a Router alternating the two results
 * still exhausts the bound. Running out is a transport failure, as for lost
 * connections, so the envelope waits for the next drain.
 *
 * @param runtime Worker capabilities and endpoint identity.
 * @param input The attempt whose Router result named the other mode.
 * @param mode The mode the resend uses.
 * @param spent Attempts the resend costs.
 * @returns Whether Router accepted the stored bytes or reported a restart.
 */
function resendInMode<Payload>(
  runtime: RouterWorkerRuntime<Payload>,
  input: TransmitInput,
  mode: TransmitInput["mode"],
  spent: 0 | 1,
): Effect.Effect<
  RouterWorkerSendOutcome,
  OutboundTransportError,
  SqlClient.SqlClient
> {
  const attemptsRemaining = input.attemptsRemaining - spent;
  if (input.mode === mode) {
    return Effect.fail(new RouterWorkerProtocolError());
  }
  return attemptsRemaining < 1
    ? Effect.logWarning(
        "Router kept losing the retry identity; the envelope waits for the next drain",
      ).pipe(Effect.zipRight(Effect.fail(new RouterWorkerTransportError())))
    : transmitOuter(runtime, { ...input, mode, attemptsRemaining });
}

function digestCanonicalSignedMessage(
  canonicalSignedMessage: Uint8Array,
): Effect.Effect<typeof SignedMessageDigest.Type, RouterWorkerProtocolError> {
  return Effect.try({
    try: () => createHash("sha256").update(canonicalSignedMessage).digest(),
    catch: mapProtocolError,
  }).pipe(
    Effect.map((digest) => `smd_${Encoding.encodeBase64Url(digest)}`),
    Effect.flatMap(Schema.decodeUnknown(SignedMessageDigest)),
    Effect.mapError(mapProtocolError),
  );
}

function completeAcceptedOutbound(
  input: TransmitInput,
  result: Extract<RouterSendResult, { readonly kind: "accepted" }>,
): Effect.Effect<
  RouterWorkerSendOutcome,
  OutboundTransportError,
  SqlClient.SqlClient
> {
  return Effect.gen(function* () {
    if (result.routerInstanceId !== input.instance) {
      return yield* Effect.fail(new RouterWorkerProtocolError());
    }
    const expectedDigest = yield* digestCanonicalSignedMessage(
      input.outbound.canonicalSignedMessage,
    );
    if (result.signedMessageDigest !== expectedDigest) {
      return yield* Effect.fail(new RouterWorkerProtocolError());
    }
    yield* Store.completeOutbound(input.outbound).pipe(
      Effect.mapError(mapPersistenceError),
    );
    return { kind: "accepted" };
  });
}

const interpretSendResult = <Payload>(
  runtime: RouterWorkerRuntime<Payload>,
  input: TransmitInput,
  result: RouterSendResult,
): Effect.Effect<
  RouterWorkerSendOutcome,
  OutboundTransportError,
  SqlClient.SqlClient
> => {
  switch (result.kind) {
    case "accepted":
      return completeAcceptedOutbound(input, result);
    case "router_restarted":
      return Effect.succeed({ kind: "restarted" });
    case "retry_identity_unknown":
      return resendInMode(runtime, input, "initial", 1);
    case "idempotency_conflict":
      return resendInMode(runtime, input, "retry", 0);
    case "message_invalid":
      return Effect.fail(new RouterWorkerProtocolError());
    default: {
      const exhaustive: never = result;
      return exhaustive;
    }
  }
};

/**
 * Send one stored envelope, resending its exact bytes and EnvelopeId on every
 * ambiguous outcome.
 * @param runtime Worker capabilities and endpoint identity.
 * @param input Exact envelope, Router fence, mode, and remaining attempts.
 * @returns Whether Router accepted the envelope or reported a restart.
 */
function transmitOuter<Payload>(
  runtime: RouterWorkerRuntime<Payload>,
  input: TransmitInput,
): Effect.Effect<
  RouterWorkerSendOutcome,
  OutboundTransportError,
  SqlClient.SqlClient
> {
  return runtime.router
    .send({
      request: {
        expectedRouterInstanceId: input.instance,
        mode: input.mode,
        signedMessage: input.message,
      },
      callerAgentId: runtime.input.callerAgentId,
      signingAuthority: runtime.input.signingAuthority,
    })
    .pipe(
      Effect.mapError(mapRouterFailure),
      Effect.matchEffect({
        onFailure: (error) =>
          !isTransportFailure(error) || input.attemptsRemaining <= 1
            ? Effect.fail(error)
            : Effect.sleep(routerWorkerRetryDelay).pipe(
                Effect.zipRight(
                  transmitOuter(runtime, {
                    ...input,
                    mode: "retry",
                    attemptsRemaining: input.attemptsRemaining - 1,
                  }),
                ),
              ),
        onSuccess: (result) => interpretSendResult(runtime, input, result),
      }),
      Effect.interruptible,
    );
}

function decodeStoredOutbound(
  outbound: StoredOutboundMessage,
): Effect.Effect<LiveSignedMessage, RouterWorkerProtocolError> {
  return decodeCanonical(
    SignedMessage.live,
    outbound.canonicalSignedMessage,
  ).pipe(
    Effect.mapError(mapProtocolError),
    Effect.flatMap((message) =>
      message.envelopeId === outbound.envelopeId
        ? Effect.succeed(message)
        : Effect.fail(new RouterWorkerProtocolError()),
    ),
  );
}

/**
 * Sends one durable current envelope selected by its stable outbox identity.
 *
 * @param runtime Worker capabilities and durable outbox.
 * @param envelopeId Stable identity of the signed envelope.
 * @param instance Router instance fence for this attempt.
 * @returns Whether the stored envelope completed or observed a Router restart.
 */
function transmitOutbound<Payload>(
  runtime: RouterWorkerRuntime<Payload>,
  envelopeId: string,
  instance: RouterInstanceId,
): Effect.Effect<
  RouterWorkerSendOutcome,
  OutboundTransportError,
  SqlClient.SqlClient
> {
  return Store.beginOutbound(envelopeId).pipe(
    Effect.mapError(mapPersistenceError),
    Effect.flatMap((attempt) => {
      switch (attempt.kind) {
        case "inactive":
          return Effect.succeed({ kind: "accepted" } as const);
        case "pending":
          return decodeStoredOutbound(attempt.outbound).pipe(
            Effect.flatMap((message) =>
              message.senderAgentId === runtime.input.callerAgentId
                ? transmitOuter(runtime, {
                    outbound: attempt.outbound,
                    message,
                    instance,
                    mode: attempt.mode,
                    attemptsRemaining: routerWorkerRetryAttempts,
                  })
                : Effect.fail(new RouterWorkerProtocolError()),
            ),
          );
        default: {
          const exhaustive: never = attempt;
          return exhaustive;
        }
      }
    }),
  );
}

type AnchoredRecoveringState = RouterWorkerRecoveringState & {
  readonly anchor: NonNullable<RouterWorkerRecoveringState["anchor"]>;
};

const matchesRecovery = (
  state: RouterWorkerState,
  generation: number,
  routerInstanceId: RouterInstanceId,
): state is AnchoredRecoveringState =>
  state.kind === "recovering" &&
  state.generation === generation &&
  state.anchor?.routerInstanceId === routerInstanceId;

/**
 * Anchor a restarted or rejoined Router and reconcile certified history, then
 * go active. Recovery fences each conversation and asks for catch-up without
 * waiting for answers, so the worker polls nothing until it is active, and
 * every message the Router holds meanwhile reaches the active path.
 * @param runtime Worker runtime whose generation is being recovered.
 * @param recovering Generation-scoped state to reconcile.
 * @returns An effect that completes after the worker becomes active.
 */
const finishRouterRecovery = <Payload>(
  runtime: RouterWorkerRuntime<Payload>,
  recovering: RouterWorkerRecoveringState,
): Effect.Effect<void, RouterWorkerPollError> =>
  Effect.gen(function* () {
    const anchor = yield* pollRouterTail(runtime, runtime.input);
    const anchored = yield* anchorRecovery(runtime, recovering, anchor);
    const prepared = yield* prepareRecovery(runtime, anchored);
    yield* runtime.input.callbacks.recoverCertifiedHistory({
      reason: prepared.reason,
      anchor: prepared.anchor,
    });
    yield* runtime.stateGate.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* Ref.get(runtime.state);
        if (
          !matchesRecovery(
            current,
            prepared.generation,
            prepared.anchor.routerInstanceId,
          )
        ) {
          return yield* Effect.fail(new RouterWorkerDiscontinuityError());
        }
        yield* Ref.set(runtime.state, {
          kind: "active",
          generation: prepared.generation,
          anchor: current.anchor,
        });
        yield* logRecoveryComplete(current);
      }),
    );
  }).pipe(Effect.withSpan("finishRouterRecovery"));

const seedPinnedCards = <Payload>(
  input: RouterWorkerInput<Payload>,
): Effect.Effect<Map<AgentId, VerifiedAgentCard>, RouterWorkerProtocolError> =>
  Effect.gen(function* () {
    const cards = new Map<AgentId, VerifiedAgentCard>();
    const representations = new Map<AgentId, string>();
    for (const card of input.pinnedSenderCards) {
      const representation = yield* Schema.encode(AgentCard)(card).pipe(
        Effect.map(JSON.stringify),
        Effect.catchTag("ParseError", () =>
          Effect.fail(new RouterWorkerProtocolError()),
        ),
      );
      const retained = representations.get(card.agentId);
      if (retained !== undefined && retained !== representation) {
        return yield* Effect.fail(new RouterWorkerProtocolError());
      }
      cards.set(card.agentId, card);
      representations.set(card.agentId, representation);
    }
    const local = representations.get(input.callerAgentId);
    const canonicalLocal = yield* Schema.encode(AgentCard)(
      input.callerAgentCard,
    ).pipe(
      Effect.map(JSON.stringify),
      Effect.catchTag("ParseError", () =>
        Effect.fail(new RouterWorkerProtocolError()),
      ),
    );
    if (local === undefined || local !== canonicalLocal) {
      return yield* Effect.fail(new RouterWorkerProtocolError());
    }
    return cards;
  });

const resolveSenderCard = <Payload>(
  runtime: RouterWorkerRuntime<Payload>,
  agentId: AgentId,
): Effect.Effect<
  VerifiedAgentCard,
  RouterWorkerAuthenticationError | RouterWorkerPersistenceError
> => {
  const cached = runtime.cards.get(agentId);
  if (cached !== undefined) {
    return Effect.succeed(cached);
  }
  return runtime.registry.lookup({ agentId }).pipe(
    Effect.mapError(mapAuthenticationError),
    Effect.flatMap((result) =>
      result.kind === "found" && result.agentCard.agentId === agentId
        ? Effect.succeed(result.agentCard)
        : Effect.fail(new RouterWorkerAuthenticationError()),
    ),
    Effect.tap(runtime.input.callbacks.pinSenderCard),
    Effect.tap((card) => Effect.sync(() => runtime.cards.set(agentId, card))),
    Effect.interruptible,
  );
};

const verifyOuter = <Payload>(
  runtime: RouterWorkerRuntime<Payload>,
  signedMessage: LiveSignedMessage,
): Effect.Effect<
  RouterWorkerVerifiedIngress,
  RouterWorkerAuthenticationError | RouterWorkerPersistenceError
> =>
  Effect.gen(function* () {
    const senderCard = yield* resolveSenderCard(
      runtime,
      signedMessage.senderAgentId,
    );
    const message = yield* SignedMessage.verify({
      signedMessage,
      agentCard: senderCard,
    }).pipe(Effect.mapError(mapAuthenticationError));
    return { message, senderCard };
  });

const verifyBatch = <Payload>(
  runtime: RouterWorkerRuntime<Payload>,
  messages: readonly LiveSignedMessage[],
): Effect.Effect<
  readonly RouterWorkerVerifiedIngress[],
  RouterWorkerAuthenticationError | RouterWorkerPersistenceError
> =>
  Effect.forEach(messages, (message) => verifyOuter(runtime, message), {
    concurrency: 1,
  });

const acceptVerified = <Payload>(
  runtime: RouterWorkerRuntime<Payload>,
  ingress: RouterWorkerVerifiedIngress,
  routerInstanceId: RouterInstanceId,
): Effect.Effect<void, RouterWorkerPersistenceError> =>
  runtime.input.callbacks.decodePayload(ingress.message).pipe(
    Effect.flatMap((payload) =>
      runtime.input.callbacks.acceptPayload({
        ...ingress,
        payload,
        routerInstanceId,
      }),
    ),
    Effect.asVoid,
    Effect.catchTag("RouterWorkerPayloadInvalidError", () => Effect.void),
  );

const stateMatches = (
  state: RouterWorkerState,
  generation: number,
  routerInstanceId: RouterInstanceId,
): state is RouterWorkerActiveState =>
  state.kind === "active" &&
  state.generation === generation &&
  state.anchor.routerInstanceId === routerInstanceId;

/**
 * Accept each verified input durably before advancing the cursor. Callbacks
 * queue network work for the worker; they do not transmit while this ordered
 * batch holds the state gate.
 * @param runtime The worker's state gate and durable acceptance callbacks.
 * @param snapshot The active generation when polling began.
 * @param result The batch whose cursor follows the verified inputs.
 * @param verified Authenticated inputs in batch order, with none left unchecked.
 * @returns Completion after acceptance and cursor advancement, or no change if
 * the generation became obsolete.
 */
const commitBatch = <Payload>(
  runtime: RouterWorkerRuntime<Payload>,
  snapshot: RouterWorkerActiveState,
  result: Extract<RouterPollResult, { readonly kind: "batch" }>,
  verified: readonly RouterWorkerVerifiedIngress[],
): Effect.Effect<void, RouterWorkerPersistenceError> =>
  runtime.stateGate.withPermits(1)(
    Effect.gen(function* () {
      const current = yield* Ref.get(runtime.state);
      if (
        !stateMatches(current, snapshot.generation, result.routerInstanceId)
      ) {
        return;
      }
      yield* Effect.forEach(
        verified,
        (ingress) => acceptVerified(runtime, ingress, result.routerInstanceId),
        { concurrency: 1 },
      );
      yield* Ref.set(runtime.state, {
        ...current,
        anchor: { ...current.anchor, pollCursor: result.pollCursor },
      });
    }),
  );

function prepareRecovery<Payload>(
  runtime: RouterWorkerRuntime<Payload>,
  recovering: AnchoredRecoveringState,
): Effect.Effect<AnchoredRecoveringState, RouterWorkerPollError> {
  if (recovering.volatileFoldsAbandoned) {
    return Effect.succeed(recovering);
  }
  return runtime.input.callbacks.abandonVolatileFolds(recovering.reason).pipe(
    Effect.zipRight(
      runtime.stateGate.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* Ref.get(runtime.state);
          if (
            current.kind !== "recovering" ||
            current.generation !== recovering.generation ||
            current.anchor === undefined
          ) {
            return yield* Effect.fail(new RouterWorkerDiscontinuityError());
          }
          const prepared: AnchoredRecoveringState = {
            ...current,
            anchor: current.anchor,
            volatileFoldsAbandoned: true,
          };
          yield* Ref.set(runtime.state, prepared);
          return prepared;
        }),
      ),
    ),
  );
}

function anchorRecovery<Payload>(
  runtime: RouterWorkerRuntime<Payload>,
  recovering: RouterWorkerRecoveringState,
  anchor: RouterTailAnchor,
): Effect.Effect<AnchoredRecoveringState, RouterWorkerPollError> {
  return runtime.stateGate.withPermits(1)(
    Effect.gen(function* () {
      const current = yield* Ref.get(runtime.state);
      if (
        current.kind !== "recovering" ||
        current.generation !== recovering.generation
      ) {
        return yield* Effect.fail(new RouterWorkerDiscontinuityError());
      }
      const reason =
        current.priorRouterInstanceId !== undefined &&
        current.priorRouterInstanceId !== anchor.routerInstanceId
          ? "router_restarted"
          : current.reason;
      const anchored: AnchoredRecoveringState = {
        ...current,
        reason,
        priorRouterInstanceId:
          current.priorRouterInstanceId ?? anchor.routerInstanceId,
        volatileFoldsAbandoned:
          current.reason === reason && current.volatileFoldsAbandoned,
        anchor,
        unreachableSince: Option.none(),
      };
      yield* Ref.set(runtime.state, anchored);
      return anchored;
    }),
  );
}

const triggerDiscontinuity = <Payload>(
  runtime: RouterWorkerRuntime<Payload>,
  reason: RouterDiscontinuityReason,
  observedGeneration: number,
): Effect.Effect<void, RouterWorkerPollError> =>
  runtime.recoveryGate.withPermits(1)(
    Effect.gen(function* () {
      const current = yield* Ref.get(runtime.state);
      if (
        current.kind !== "recovering" &&
        current.generation !== observedGeneration
      ) {
        return;
      }
      if (current.kind === "recovering") {
        return yield* finishRouterRecovery(runtime, current);
      }
      const recovering: RouterWorkerRecoveringState = {
        kind: "recovering",
        generation: current.generation + 1,
        reason,
        priorRouterInstanceId: current.anchor.routerInstanceId,
        volatileFoldsAbandoned: false,
        unreachableSince: Option.none(),
      };
      yield* runtime.stateGate.withPermits(1)(
        Ref.set(runtime.state, recovering),
      );
      if (current.kind === "detached") {
        yield* logRecoveryAfterLoss(recovering);
      }
      return yield* finishRouterRecovery(runtime, recovering);
    }),
  );

const pollActiveOnce = <Payload>(
  runtime: RouterWorkerRuntime<Payload>,
  snapshot: RouterWorkerActiveState,
): Effect.Effect<void, RouterWorkerPollError> =>
  runtime.router
    .poll({
      request: { pollCursor: snapshot.anchor.pollCursor },
      callerAgentId: runtime.input.callerAgentId,
      signingAuthority: runtime.input.signingAuthority,
    })
    .pipe(
      Effect.mapError(mapRouterFailure),
      Effect.retry(pollBlipRetry),
      Effect.tapErrorTag("RouterWorkerTransportError", () =>
        detach(runtime, snapshot.generation),
      ),
      Effect.flatMap((result) => {
        switch (result.kind) {
          case "batch":
            if (result.routerInstanceId !== snapshot.anchor.routerInstanceId) {
              return triggerDiscontinuity(
                runtime,
                "router_restarted",
                snapshot.generation,
              );
            }
            return verifyBatch(runtime, result.signedMessages).pipe(
              Effect.flatMap((verified) =>
                commitBatch(runtime, snapshot, result, verified),
              ),
            );
          case "feed_gap":
            return triggerDiscontinuity(
              runtime,
              "feed_gap",
              snapshot.generation,
            );
          case "cursor_invalid":
            return triggerDiscontinuity(
              runtime,
              "cursor_invalid",
              snapshot.generation,
            );
          default:
            return Effect.fail(new RouterWorkerProtocolError());
        }
      }),
      Effect.interruptible,
    );

/**
 * Reattach a detached worker once the Router answers. The probe is an
 * omitted-cursor poll, which the Router answers at once, whereas a
 * continuation poll may be held for 25 s. The same instance reattaches at the
 * retained anchor and cursor; another instance starts restart recovery.
 * @param runtime Detached worker.
 * @param snapshot Detached state the probe was issued from.
 * @returns Completion once the worker is active again or recovering.
 */
const probeDetached = <Payload>(
  runtime: RouterWorkerRuntime<Payload>,
  snapshot: RouterWorkerDetachedState,
): Effect.Effect<void, RouterWorkerPollError> =>
  pollRouterTail(runtime, runtime.input).pipe(
    Effect.flatMap((tail) =>
      tail.routerInstanceId === snapshot.anchor.routerInstanceId
        ? reattach(runtime, snapshot)
        : triggerDiscontinuity(
            runtime,
            "router_restarted",
            snapshot.generation,
          ),
    ),
    Effect.interruptible,
  );

const makePollOnce = <Payload>(
  runtime: RouterWorkerRuntime<Payload>,
): Effect.Effect<void, RouterWorkerPollError> =>
  runtime.pollGate.withPermits(1)(
    Ref.get(runtime.state).pipe(
      Effect.flatMap((state) => {
        switch (state.kind) {
          case "active":
            return pollActiveOnce(runtime, state);
          case "detached":
            return probeDetached(runtime, state);
          case "recovering":
            return runtime.recoveryGate.withPermits(1)(
              finishRouterRecovery(runtime, state),
            );
          default: {
            const exhaustive: never = state;
            return exhaustive;
          }
        }
      }),
    ),
  );

const makeSend = <Payload>(
  runtime: RouterWorkerRuntime<Payload>,
  envelopeId: string,
): Effect.Effect<void, RouterWorkerSendError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const result = yield* runtime.recoveryGate.withPermits(1)(
      Effect.gen(function* () {
        const state = yield* Ref.get(runtime.state);
        if (state.kind !== "active") {
          return yield* Effect.fail(new RouterWorkerUnavailableError());
        }
        const outcome = yield* transmitOutbound(
          runtime,
          envelopeId,
          state.anchor.routerInstanceId,
        );
        return { outcome, generation: state.generation };
      }),
    );
    if (result.outcome.kind === "restarted") {
      yield* triggerDiscontinuity(
        runtime,
        "router_restarted",
        result.generation,
      );
      return yield* Effect.fail(new RouterWorkerDiscontinuityError());
    }
  });

const activeAnchor = (
  state: RouterWorkerState,
): Option.Option<RouterTailAnchor> =>
  state.kind === "active" ? Option.some(state.anchor) : Option.none();

const makeWorker = <Payload>(
  runtime: RouterWorkerRuntime<Payload>,
  sql: SqlClient.SqlClient,
): RouterWorker => {
  const provideSql = Effect.provideService(SqlClient.SqlClient, sql);
  const pollOnce = makePollOnce(runtime).pipe(provideSql);
  return Object.freeze({
    currentAnchor: Ref.get(runtime.state).pipe(
      Effect.flatMap((state) =>
        state.kind === "active"
          ? Effect.succeed(state.anchor)
          : Effect.fail(new RouterWorkerUnavailableError()),
      ),
    ),
    /**
     * State replay covers attachment between a caller's probe and this wait.
     * The stream never ends, so an empty head is a defect.
     */
    awaitAnchor: runtime.state.changes.pipe(
      Stream.filterMap(activeAnchor),
      Stream.runHead,
      Effect.flatMap(Effect.orDie),
    ),
    pollOnce,
    run: Effect.zipRight(
      reportUnreachable(runtime),
      pollOnce.pipe(
        Effect.tapError((error) => noteRunFailure(runtime, error)),
        Effect.retry(
          routerWorkerReconnectSchedule.pipe(
            Schedule.whileInput(isTransientRouterWorkerError),
          ),
        ),
        Effect.forever,
      ),
      { concurrent: true },
    ).pipe(Effect.interruptible),
    send: (envelopeId: string) =>
      makeSend(runtime, envelopeId).pipe(provideSql),
  });
};

/**
 * Build a recovering worker without starting its polling loop.
 * @param input Registered identity and durable endpoint callbacks.
 * @returns A worker that remains unavailable until certified recovery completes.
 */
export const makeRouterWorker = <Payload>(
  input: RouterWorkerInput<Payload>,
): Effect.Effect<
  RouterWorker,
  RouterWorkerTransportError | RouterWorkerProtocolError,
  Registry | Router | SqlClient.SqlClient
> =>
  Effect.gen(function* () {
    if (input.callerAgentCard.agentId !== input.callerAgentId) {
      return yield* Effect.fail(new RouterWorkerProtocolError());
    }
    const services = {
      router: yield* Router,
      registry: yield* Registry,
    };
    const cards = yield* seedPinnedCards(input);
    const runtime: RouterWorkerRuntime<Payload> = {
      ...services,
      input,
      cards,
      state: yield* SubscriptionRef.make<RouterWorkerState>({
        kind: "recovering",
        generation: 0,
        reason: "router_restarted",
        volatileFoldsAbandoned: false,
        unreachableSince: Option.none(),
      }),
      pollGate: yield* Effect.makeSemaphore(1),
      stateGate: yield* Effect.makeSemaphore(1),
      recoveryGate: yield* Effect.makeSemaphore(1),
    };
    return makeWorker(runtime, yield* SqlClient.SqlClient);
  }).pipe(Effect.withSpan("makeRouterWorker"));

/** Daemon composition installs the Router HTTP client behind the worker. */
export { Router } from "./api/client.js";
