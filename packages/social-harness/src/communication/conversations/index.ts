/**
 * @file Private addressed-message engine: its contract with daemon
 * composition, and the assembly that binds the phases into one engine.
 */

import { Data, Deferred, Duration, Effect, Schema, type Scope } from "effect";
import type {
  RouterDiscontinuityReason,
  RouterIngressDisposition,
  RouterWorkerIngress,
  RouterWorkerPersistenceError,
  RouterWorkerRecovery,
  RouterWorkerRecoveryError,
  RouterWorkerSendError,
} from "../router/index.js";
import type { DeliveryToken, EndpointStoreError } from "../store/index.js";
import type {
  EndpointEngineInput,
  EnginePhases,
  EngineRuntime,
} from "./engine-context.js";
import {
  type ClientRepresentationError,
  decodeCanonical,
  encodeCanonical,
} from "../../encoding/canonical-json.js";
import { AgentCard } from "../../identity/cards.js";
import { AgentSigningAuthority } from "../../identity/keys.js";
import { wireVersions } from "../../identity/wire-version.js";
import {
  type DecodedOuterBody,
  type MessageAddressInput,
  MessageIntent,
  type MsgId,
  RecordHash,
} from "../records/index.js";
import { type RecipientResolutionError, resolutionFailure } from "./address.js";
import {
  acceptEngineIngress,
  acceptEngineRecoveryIngress,
  resumeDisseminationObligations,
  resumeEngineFolds,
} from "./certification/index.js";
import { DeliveryAcknowledgeError, ListenError, SendError } from "./errors.js";
import { InboundMessage } from "./message.js";
import { makeOutbox } from "./outbox.js";
import { recoverEngineState } from "./restore.js";
import {
  acceptEngineIngressWithRecovery,
  installRecoveryBarrier,
  isRecovering,
  rearmPausedCatchUp,
  recoverCertifiedHistory,
  recoveryHeadAdvanced,
} from "./router-recovery/index.js";
import {
  acceptSend,
  type BindHold,
  type EngineSendInput,
  type EngineSentMessage,
  type PreparedSend,
  prepareSend,
  proposeIntent,
  resolveAddress,
  resolveConversation,
  type ResolvedConversation,
} from "./send.js";

/** Private engine dependencies retained behind the daemon boundary. */
export type { EndpointEngineInput } from "./engine-context.js";
/** The send input and result the collective layer exchanges with the engine. */
export type { EngineSendInput, EngineSentMessage } from "./send.js";
/** How a caller holds a protocol claim across durable binding. */
export { type BindHold, preparedSendData } from "./send.js";
/** Canonical message preparation and resolved conversation attribution. */
export type { PreparedSend } from "./send.js";
/** The marker spans that bracket daemon work in flight, shared with the layers above. */
export {
  exitOutcome,
  markRetries,
  retryPending,
  retrySettled,
} from "./retry-markers.js";
/**
 * The one verifier of a stored membership row, and the stored-history reader
 * the owner tools page through, shared with the daemon.
 */
export { readStoredHistory, verifyStoredMembership } from "./history/index.js";

/** Engine acquisition could not establish one coherent durable endpoint. */
export class EngineInitializationError extends Data.TaggedError(
  "EngineInitializationError",
)<{
  readonly reason:
    | "identity"
    | "persistence"
    | "representation"
    | "outbox-too-old";
}> {}

/** Sending queued protocol traffic could not complete safely. */
export class EngineOutboundError extends Data.TaggedError(
  "EngineOutboundError",
)<{
  readonly reason: "network" | "persistence" | "representation" | "version";
}> {}

/**
 * One durable delivery decoded for the daemon's sole subscriber. `message` is
 * the certified message with its complete content, collective part included; the
 * daemon's classifier turns it into the item the subscriber receives.
 * `recordHash` names the certified record the delivery derives from; it stays
 * inside the daemon and never reaches the MCP event.
 */
export interface EnginePendingMessage {
  readonly deliveryToken: DeliveryToken;
  readonly recordHash: RecordHash;
  readonly message: InboundMessage;
}

/** Stable private engine capability consumed by daemon composition. */
export interface EndpointEngine {
  /** Observe one durable local intent without rechecking, rebinding, or sending a replacement. */
  readonly observeMessage: (
    msgId: MsgId,
  ) => Effect.Effect<EngineSentMessage, SendError>;

  /** Capture canonical content, membership and identity before assessment or binding. */
  readonly prepare: (
    input: EngineSendInput,
  ) => Effect.Effect<PreparedSend, SendError | RecipientResolutionError>;
  /** Accept captured bytes without resolving names or minting another message identity. */
  readonly accept: <E>(
    prepared: PreparedSend,
    hold: BindHold<E>,
  ) => Effect.Effect<
    { readonly certified: Effect.Effect<EngineSentMessage, SendError> },
    SendError | E
  >;
  /** Completes once the minted message's certified record is stored locally. */
  readonly send: (
    input: EngineSendInput,
  ) => Effect.Effect<EngineSentMessage, SendError>;
  /**
   * Resolve an address through the Registry as a send would, without
   * sending; the collective layer uses it to name the unreachable members of
   * a refused group message.
   */
  readonly resolveAddress: (
    to: MessageAddressInput,
  ) => Effect.Effect<void, SendError>;
  /**
   * Resolve an address to the conversation a send uses, with its
   * members' verified cards, without sending; the firewall attributes a
   * gather's recipients and reads its evidence through it.
   */
  readonly resolveConversation: (
    to: MessageAddressInput,
  ) => Effect.Effect<ResolvedConversation, SendError>;
  readonly readPendingMessages: () => Effect.Effect<
    readonly EnginePendingMessage[],
    ListenError
  >;
  readonly acknowledgeMessage: (
    deliveryToken: DeliveryToken,
  ) => Effect.Effect<void, DeliveryAcknowledgeError>;
  readonly acceptRouterIngress: (
    ingress: RouterWorkerIngress<DecodedOuterBody>,
  ) => Effect.Effect<RouterIngressDisposition, RouterWorkerPersistenceError>;
  readonly recoverCertifiedHistory: (
    recovery: RouterWorkerRecovery,
  ) => Effect.Effect<void, RouterWorkerRecoveryError>;
  readonly drainOutbound: Effect.Effect<void, EngineOutboundError>;
  readonly runOutbound: Effect.Effect<never, EngineOutboundError>;
  readonly abandonVolatileFolds: (
    reason: RouterDiscontinuityReason,
  ) => Effect.Effect<void>;
  /**
   * Start catch-up again for every conversation recovery still holds whose
   * retries ran out; the Router worker calls it when it reattaches.
   */
  readonly rearmCatchUp: Effect.Effect<void>;
}

type RecoveredStateError = Effect.Effect.Error<
  ReturnType<typeof recoverEngineState>
>;

const initializationReasonByStoreReason = {
  closed: "persistence",
  conflict: "identity",
  corrupt: "persistence",
  incompatible: "persistence",
  "invalid-continuation": "persistence",
  "invalid-input": "persistence",
  "not-found": "persistence",
  persistence: "persistence",
} as const satisfies Readonly<
  Record<EndpointStoreError["reason"], EngineInitializationError["reason"]>
>;

const listenReasonByStoreReason = {
  closed: "transport-failed",
  conflict: "decode-failed",
  corrupt: "decode-failed",
  incompatible: "incompatible-daemon",
  "invalid-continuation": "decode-failed",
  "invalid-input": "decode-failed",
  "not-found": "decode-failed",
  persistence: "transport-failed",
} as const satisfies Readonly<
  Record<EndpointStoreError["reason"], ListenError["reason"]>
>;

const acknowledgeReasonByStoreReason = {
  closed: "persistence-failed",
  conflict: "delivery-conflict",
  corrupt: "persistence-failed",
  incompatible: "persistence-failed",
  "invalid-continuation": "persistence-failed",
  "invalid-input": "persistence-failed",
  "not-found": "unknown-delivery",
  persistence: "persistence-failed",
} as const satisfies Readonly<
  Record<EndpointStoreError["reason"], DeliveryAcknowledgeError["reason"]>
>;

type ResumeIntentDisposition =
  | "fail-persistence"
  | "fail-representation"
  | "ignore";

const resumeDispositionBySendReason = {
  "outcome-unknown": "fail-representation",
  "certification-unavailable": "ignore",
  "content-invalid": "fail-representation",
  "invalid-address": "fail-representation",
  "membership-invalid": "fail-representation",
  "network-unavailable": "ignore",
  "delivery-pending": "ignore",
  "not-registered": "fail-representation",
  "persistence-failed": "fail-persistence",
  "unknown-agent": "fail-representation",
  "version-mismatch": "fail-representation",
} as const satisfies Readonly<
  Record<SendError["reason"], ResumeIntentDisposition>
>;

const outboundReasonByTag = {
  RouterWorkerAuthenticationError: "representation",
  RouterWorkerDiscontinuityError: "network",
  RouterWorkerPersistenceError: "persistence",
  RouterWorkerProtocolError: "representation",
  RouterWorkerRecoveryError: "network",
  RouterWorkerTransportError: "network",
  RouterWorkerUnavailableError: "network",
} as const satisfies Readonly<
  Record<
    Exclude<RouterWorkerSendError["_tag"], "RouterWorkerRejectedError">,
    EngineOutboundError["reason"]
  >
>;

const outboundFailure = (error: RouterWorkerSendError): EngineOutboundError => {
  if (error._tag !== "RouterWorkerRejectedError") {
    return new EngineOutboundError({ reason: outboundReasonByTag[error._tag] });
  }
  return new EngineOutboundError({
    reason: error.reason === "version" ? "version" : "representation",
  });
};

function listenStoreFailure(error: EndpointStoreError): ListenError {
  return new ListenError({ reason: listenReasonByStoreReason[error.reason] });
}

function listenRepresentationFailure(): ListenError {
  return new ListenError({ reason: "decode-failed" });
}

function acknowledgeStoreFailure(
  error: EndpointStoreError,
): DeliveryAcknowledgeError {
  return new DeliveryAcknowledgeError({
    reason: acknowledgeReasonByStoreReason[error.reason],
  });
}

function bindIdentityFailure(
  error: ClientRepresentationError | EndpointStoreError,
): EngineInitializationError {
  switch (error._tag) {
    case "ClientRepresentationError":
      return representationInitializationFailure();
    case "EndpointStoreError":
      return initializationStoreFailure(error);
    default: {
      const exhaustive: never = error;
      return exhaustive;
    }
  }
}

function recoveryInitializationFailure(
  error: RecoveredStateError,
): EngineInitializationError {
  switch (error._tag) {
    case "ClientRepresentationError":
    case "ParseError":
      return representationInitializationFailure();
    case "OutboxTooOldError":
      return new EngineInitializationError({ reason: "outbox-too-old" });
    case "RouterWorkerPersistenceError":
      return new EngineInitializationError({ reason: "persistence" });
    default: {
      const exhaustive: never = error;
      return exhaustive;
    }
  }
}

function resumeIntentFailure(
  error: SendError,
): Effect.Effect<void, EngineInitializationError> {
  const disposition = resumeDispositionBySendReason[error.reason];
  switch (disposition) {
    case "fail-persistence":
      return Effect.fail(
        new EngineInitializationError({ reason: "persistence" }),
      );
    case "fail-representation":
      return Effect.fail(representationInitializationFailure());
    case "ignore":
      return Effect.void;
    default: {
      const exhaustive: never = disposition;
      return exhaustive;
    }
  }
}

function initializationStoreFailure(
  error: EndpointStoreError,
): EngineInitializationError {
  return new EngineInitializationError({
    reason: initializationReasonByStoreReason[error.reason],
  });
}

function representationInitializationFailure(): EngineInitializationError {
  return new EngineInitializationError({ reason: "representation" });
}

function resumeFoldFailure(): EngineInitializationError {
  return new EngineInitializationError({ reason: "persistence" });
}

/**
 * How long a local send's own drain may run before the send fails as
 * `delivery-pending`. With `ROUTER_ATTACH_TIMEOUT` it stays under the MCP
 * SDK's `DEFAULT_REQUEST_TIMEOUT_MSEC`.
 */
const LOCAL_DRAIN_TIMEOUT = Duration.seconds(10);

/**
 * Bind, queue and certify one message. Once `prepareSend` returns, the message is
 * durably queued, so a drain that fails or outlasts `LOCAL_DRAIN_TIMEOUT`
 * fails the send as `delivery-pending` whatever the cause: a worker failure
 * that ends once the Router answers leaves the background drain to deliver
 * the message, and any other stops the daemon, whose recovery resumes the message
 * when it restarts. A completion already settled, such as an activation that
 * failed, returns at once rather than waiting on other messages' drain.
 * @param runtime The engine that sends.
 * @param prepared The durable message identity and its certified completion.
 * @returns The message's id and certified record hash.
 */
const finishPreparedSend = (
  runtime: EngineRuntime,
  prepared: Effect.Effect.Success<ReturnType<typeof acceptSend>>,
) =>
  Effect.gen(function* () {
    if (!(yield* Deferred.isDone(prepared.completion))) {
      yield* runtime.outbox.drain.pipe(
        Effect.timeout(LOCAL_DRAIN_TIMEOUT),
        // eslint-disable-next-line agent-code-guard/no-effect-error-coalescing -- Every drain failure, the timeout included, leaves the message queued and still delivered, as this function's JSDoc explains.
        Effect.mapError(() => new SendError({ reason: "delivery-pending" })),
      );
    }
    const recordHash = yield* Deferred.await(prepared.completion);
    return { msgId: prepared.msgId, recordHash };
  });

const send = (
  runtime: EngineRuntime,
  input: EngineSendInput,
): Effect.Effect<EngineSentMessage, SendError> =>
  Effect.gen(function* () {
    const prepared = yield* prepareSend(runtime, input).pipe(
      Effect.catchTag("RecipientResolutionError", (error) =>
        Effect.fail(resolutionFailure(error)),
      ),
    );
    const accepted = yield* acceptSend(runtime, prepared);
    return yield* finishPreparedSend(runtime, accepted);
  }).pipe(Effect.withSpan("EndpointEngine.send"));

const readPendingMessages = (
  runtime: EngineRuntime,
): Effect.Effect<readonly EnginePendingMessage[], ListenError> =>
  runtime.input.store.readPendingDeliveries().pipe(
    Effect.mapError(listenStoreFailure),
    Effect.flatMap((deliveries) =>
      Effect.forEach(
        deliveries,
        (delivery) =>
          Effect.all({
            message: decodeCanonical(InboundMessage, delivery.canonicalMessage),
            recordHash: Schema.decodeUnknown(RecordHash)(delivery.recordHash),
          }).pipe(
            Effect.mapError(listenRepresentationFailure),
            Effect.map(({ message, recordHash }) => ({
              deliveryToken: delivery.deliveryToken,
              recordHash,
              message,
            })),
          ),
        { concurrency: 1 },
      ),
    ),
  );

const acknowledgeMessage = (
  runtime: EngineRuntime,
  deliveryToken: DeliveryToken,
): Effect.Effect<void, DeliveryAcknowledgeError> =>
  runtime.input.store
    .acknowledgeDelivery(deliveryToken)
    .pipe(Effect.mapError(acknowledgeStoreFailure), Effect.asVoid);

const validateLocalIdentity = (
  input: EndpointEngineInput,
): Effect.Effect<void, EngineInitializationError> =>
  AgentSigningAuthority.publicKey(input.signingAuthority).x ===
  input.localAgentCard.publicKey.x
    ? Effect.void
    : Effect.fail(new EngineInitializationError({ reason: "identity" }));

const bindLocalIdentity = (
  input: EndpointEngineInput,
): Effect.Effect<void, EngineInitializationError> =>
  encodeCanonical(AgentCard, input.localAgentCard).pipe(
    Effect.flatMap((canonicalAgentCard) =>
      input.store.bindIdentity({
        agentId: input.localAgentCard.agentId,
        canonicalAgentCard,
      }),
    ),
    Effect.mapError(bindIdentityFailure),
  );

/** Each engine phase that another phase starts, bound once for every runtime. */
const enginePhases: EnginePhases = {
  proposeIntent,
  acceptIngress: acceptEngineIngress,
  acceptRecoveryIngress: acceptEngineRecoveryIngress,
  resumeFolds: resumeEngineFolds,
  resumeDissemination: resumeDisseminationObligations,
  rearmCatchUp: rearmPausedCatchUp,
  headAdvanced: recoveryHeadAdvanced,
  isRecovering,
};

const makeRuntime = (
  input: EndpointEngineInput,
  recovered: Effect.Effect.Success<ReturnType<typeof recoverEngineState>>,
  scope: Scope.Scope,
): Effect.Effect<EngineRuntime> =>
  Effect.gen(function* () {
    return {
      input,
      wireVersion: yield* wireVersions.emitted,
      conversations: recovered.conversations,
      intents: new Map(),
      completedMessages: recovered.completedMessages,
      actionFolds: recovered.actionFolds,
      recordFolds: recovered.recordFolds,
      gate: yield* Effect.makeSemaphore(1),
      outbox: yield* makeOutbox(
        input,
        recovered.outboundMessages.map((message) => message.envelopeId),
      ),
      phases: enginePhases,
      scope,
    };
  });

const hydrateMessageIntents = (
  runtime: EngineRuntime,
  messageIntents: Effect.Effect.Success<
    ReturnType<typeof recoverEngineState>
  >["messageIntents"],
): Effect.Effect<void, EngineInitializationError> =>
  Effect.forEach(
    messageIntents,
    (stored) =>
      Effect.gen(function* () {
        const intent = yield* decodeCanonical(
          MessageIntent,
          stored.canonicalIntent,
        ).pipe(Effect.mapError(representationInitializationFailure));
        const completion = yield* Deferred.make<RecordHash, SendError>();
        yield* Effect.sync(() => {
          runtime.intents.set(intent.msgId, {
            intent,
            canonicalIntent: stored.canonicalIntent,
            completion,
          });
        });
        const completedRecordHash = runtime.completedMessages.get(intent.msgId);
        if (completedRecordHash !== undefined) {
          yield* Deferred.succeed(completion, completedRecordHash);
        }
      }),
    { concurrency: 1, discard: true },
  );

const initializeRuntime = (
  input: EndpointEngineInput,
): Effect.Effect<EngineRuntime, EngineInitializationError, Scope.Scope> =>
  Effect.gen(function* () {
    yield* validateLocalIdentity(input);
    yield* bindLocalIdentity(input);
    const recovery = yield* input.store
      .recover()
      .pipe(Effect.mapError(initializationStoreFailure));
    const recovered = yield* recoverEngineState(input, recovery).pipe(
      Effect.mapError(recoveryInitializationFailure),
    );
    const runtime = yield* makeRuntime(input, recovered, yield* Effect.scope);
    yield* hydrateMessageIntents(runtime, recovered.messageIntents);
    return runtime;
  });

const resumeRuntime = (runtime: EngineRuntime) =>
  Effect.gen(function* () {
    yield* resumeDisseminationObligations(runtime).pipe(
      Effect.mapError(resumeFoldFailure),
    );
    yield* resumeEngineFolds(runtime).pipe(Effect.mapError(resumeFoldFailure));
    yield* Effect.forEach(
      runtime.intents.values(),
      (intent) =>
        runtime.completedMessages.has(intent.intent.msgId)
          ? Effect.void
          : proposeIntent(runtime, intent).pipe(
              Effect.asVoid,
              Effect.catchTag("SendError", resumeIntentFailure),
            ),
      { concurrency: 1, discard: true },
    );
  });

const abandonVolatileFolds = (
  runtime: EngineRuntime,
  reason: RouterDiscontinuityReason,
): Effect.Effect<void> =>
  runtime.gate
    .withPermits(1)(
      Effect.gen(function* () {
        yield* installRecoveryBarrier(runtime);
        yield* Effect.sync(() => {
          runtime.outbox.clear();
          if (reason !== "router_restarted") {
            return;
          }
          for (const fold of runtime.actionFolds.values()) {
            fold.localActionEvidenceQueued = false;
            fold.localDurabilityEvidenceQueued = false;
          }
        });
      }),
    )
    .pipe(Effect.withSpan("abandonVolatileFolds", { attributes: { reason } }));

const endpointEngine = (runtime: EngineRuntime): EndpointEngine =>
  Object.freeze({
    prepare: (input: EngineSendInput) => prepareSend(runtime, input),
    accept: <E>(prepared: PreparedSend, hold: BindHold<E>) =>
      acceptSend(runtime, prepared, hold).pipe(
        Effect.map((accepted) => ({
          certified: finishPreparedSend(runtime, accepted),
        })),
      ),
    observeMessage: (msgId: MsgId) => observeMessage(runtime, msgId),
    send: (sendInput: Parameters<EndpointEngine["send"]>[0]) =>
      send(runtime, sendInput),
    resolveAddress: (to: Parameters<EndpointEngine["resolveAddress"]>[0]) =>
      resolveAddress(runtime, to),
    resolveConversation: (
      to: Parameters<EndpointEngine["resolveConversation"]>[0],
    ) => resolveConversation(runtime, to),
    readPendingMessages: () => readPendingMessages(runtime),
    acknowledgeMessage: (
      deliveryToken: Parameters<EndpointEngine["acknowledgeMessage"]>[0],
    ) => acknowledgeMessage(runtime, deliveryToken),
    acceptRouterIngress: (
      ingress: Parameters<EndpointEngine["acceptRouterIngress"]>[0],
    ) => acceptEngineIngressWithRecovery(runtime, ingress),
    recoverCertifiedHistory: (
      recovery: Parameters<EndpointEngine["recoverCertifiedHistory"]>[0],
    ) => recoverCertifiedHistory(runtime, recovery),
    drainOutbound: runtime.outbox.drain.pipe(Effect.mapError(outboundFailure)),
    runOutbound: runtime.outbox.run.pipe(Effect.mapError(outboundFailure)),
    abandonVolatileFolds: (
      reason: Parameters<EndpointEngine["abandonVolatileFolds"]>[0],
    ) => abandonVolatileFolds(runtime, reason),
    rearmCatchUp: rearmPausedCatchUp(runtime),
  });

/**
 * Build one coherent private engine over registered identity and durable state.
 * @param input Verified identity, storage, Registry, and Router dependencies.
 * @returns A scoped engine whose recovered state is ready for protocol work.
 */
export const makeEndpointEngine = (
  input: EndpointEngineInput,
): Effect.Effect<EndpointEngine, EngineInitializationError, Scope.Scope> =>
  Effect.gen(function* () {
    const runtime = yield* initializeRuntime(input);
    yield* resumeRuntime(runtime);
    return endpointEngine(runtime);
  }).pipe(Effect.withSpan("makeEndpointEngine"));

/**
 * Observe the retained local intent without preparing or binding a replacement.
 * @param runtime The active engine whose completion latches retain local ownership.
 * @param msgId The already-bound local message to observe.
 * @returns The original message and its certificate, or its retained send failure.
 */
function observeMessage(runtime: EngineRuntime, msgId: MsgId) {
  return Effect.suspend(() => {
    const complete = runtime.completedMessages.get(msgId);
    if (complete !== undefined) {
      return Effect.succeed({ msgId, recordHash: complete });
    }
    const retained = runtime.intents.get(msgId);
    return retained === undefined
      ? Effect.fail(new SendError({ reason: "certification-unavailable" }))
      : Deferred.await(retained.completion).pipe(
          Effect.map((recordHash) => ({ msgId, recordHash })),
        );
  });
}

/** Named resolution failures remain private to authored-message preparation. */
export { RecipientResolutionError, resolutionFailure } from "./address.js";
