/** @file Address resolution, immutable intent binding, and proposal creation. */

import type * as SqlClient from "@effect/sql/SqlClient";
import { Deferred, Duration, Effect, Exit, Schedule, Schema } from "effect";
import type { MessageAddressInput } from "../records/values.js";
import type { RouterWorkerUnavailableError } from "../router/index.js";
import type {
  CollectiveMessageBinding,
  ConversationFoundation,
  EndpointStoreError,
  MessageIntent as StoredMessageIntent,
} from "../store/index.js";
import type {
  EngineConversation,
  EngineMessageIntent,
  EngineOutboxError,
  EngineRuntime,
} from "./engine-context.js";
import {
  decodeCanonical,
  encodeCanonical,
} from "../../encoding/canonical-json.js";
import { AgentCard, type VerifiedAgentCard } from "../../identity/cards.js";
import {
  type ActionCore,
  type ActionHash,
  Content,
  deriveConversationId,
  hashAction,
  hashAnchor,
  hashMessageIntent,
  InitialAnchorBody,
  MembershipDescriptor as MembershipDescriptorSchema,
  type MessageIntent,
  MessageIntent as MessageIntentSchema,
  mintMsgId,
  type MsgId,
  type RecordHash,
  type VerifiedMembership,
  verifyMembershipDescriptor,
} from "../records/index.js";
import * as Store from "../store/index.js";
import {
  prepareMessageAddress,
  type RecipientResolutionError,
  resolveMessageAddress,
} from "./address.js";
import { SendError } from "./errors.js";
import { anchorHashAtHead } from "./history/index.js";
import { markRetries, type RetryOutcome } from "./retry-markers.js";
import {
  catchUpRetrySchedule,
  pendingRecoveryFence,
} from "./router-recovery/index.js";

// safer-arch-ignore no-fat-orchestrator: Prepared sends and durable acceptance form one operation whose dependencies come from the conversation engine.

/**
 * One message the engine certifies: its address and its complete content. The
 * collective layer above the engine builds the content, so the engine never
 * reads the collective part.
 */
export interface EngineSendInput {
  readonly to: MessageAddressInput;
  readonly content: Content;
  readonly collective?: CollectiveMessageBinding;
}

/** A locally certified message: its minted identity and its stored record's hash. */
export interface EngineSentMessage {
  readonly msgId: MsgId;
  readonly recordHash: RecordHash;
}

/**
 * Fail a send whose intent bind did not complete. A store refusal is raised
 * before the bind commits and rolls it back, so nothing was queued. A raw
 * persistence failure leaves durability unknown and is reported as a storage
 * fault, since a durable intent outside `runtime.intents` waits for a restart.
 * @param runtime The engine whose daemon hears of the fault.
 * @param error The store's failure.
 * @returns The send's failure.
 */
function failBind(
  runtime: EngineRuntime,
  error: EndpointStoreError,
): Effect.Effect<never, SendError> {
  return error.reason === "persistence"
    ? runtime.input
        .reportStorageFault(error)
        .pipe(
          Effect.zipRight(
            Effect.fail(new SendError({ reason: "outcome-unknown" })),
          ),
        )
    : Effect.fail(storeFailure(error));
}

const sendReasonByStoreReason = {
  closed: "persistence-failed",
  conflict: "persistence-failed",
  corrupt: "persistence-failed",
  incompatible: "persistence-failed",
  "invalid-continuation": "persistence-failed",
  "invalid-input": "persistence-failed",
  "not-found": "persistence-failed",
  persistence: "persistence-failed",
} as const satisfies Readonly<
  Record<EndpointStoreError["reason"], SendError["reason"]>
>;

function storeFailure(error: EndpointStoreError): SendError {
  return new SendError({ reason: sendReasonByStoreReason[error.reason] });
}

const representationFailure = (): SendError =>
  new SendError({ reason: "certification-unavailable" });

/**
 * How long a send waits for the Router worker to attach before failing as
 * `network-unavailable`.
 *
 * A cold-start attach can span a Router tail hold, `HOLD_DURATION` in
 * `@moltzap/router`, and the daemon's own `ROUTER_POLL_TIMEOUT`, so a bound
 * near either one fails sends that are merely early. It stays under the MCP
 * SDK's `DEFAULT_REQUEST_TIMEOUT_MSEC`, the deadline a host client applies to
 * the tool call, so the host receives this closed failure rather than a
 * transport timeout it cannot classify, and the remaining margin covers the
 * send itself.
 */
const ROUTER_ATTACH_TIMEOUT = Duration.seconds(45);

type ResolvedAddress = Effect.Effect.Success<
  ReturnType<typeof resolveMessageAddress>
>;

/** The conversation id a resolved address's members derive, in AgentId order. */
const conversationIdOf = (resolved: ResolvedAddress) => {
  const [first, second, ...rest] = resolved.memberCards;
  return deriveConversationId([
    first.agentId,
    second.agentId,
    ...rest.map((card) => card.agentId),
  ]).pipe(Effect.mapError(representationFailure));
};

/** The first canonical member’s signed card fixes the foundation version for every peer. */
const membershipFor = (runtime: EngineRuntime, resolved: ResolvedAddress) =>
  Effect.gen(function* () {
    const conversationId = yield* conversationIdOf(resolved);
    const stored = runtime.conversations.get(conversationId);
    if (stored !== undefined) {
      return stored.membership;
    }
    const [firstMember] = resolved.memberCards;
    const encodedCards = yield* Effect.forEach(
      resolved.memberCards,
      (card) => Schema.encode(AgentCard)(card),
      { concurrency: 1 },
    ).pipe(Effect.mapError(representationFailure));
    const descriptor = yield* Schema.decodeUnknown(MembershipDescriptorSchema)({
      sharnessVersion: AgentCard.wireVersion(firstMember),
      kind: "membership_descriptor",
      conversationId,
      members: encodedCards,
    }).pipe(Effect.mapError(representationFailure));
    const membership = yield* verifyMembershipDescriptor(
      descriptor,
      runtime.input.registrySignerPublicKey,
    ).pipe(Effect.mapError(representationFailure));
    return membership;
  });

const resolveCards = (runtime: EngineRuntime, to: MessageAddressInput) =>
  resolveMessageAddress({
    localAgentCard: runtime.input.localAgentCard,
    registry: runtime.input.registry,
    to,
  });

/**
 * Resolve an address to its members' Registry cards without sending, failing
 * with the `SendError` a send to the same address would fail with.
 */
export const resolveAddress = (
  runtime: EngineRuntime,
  to: MessageAddressInput,
): Effect.Effect<void, SendError> =>
  resolveCards(runtime, to).pipe(Effect.asVoid);

/**
 * An address resolved without sending: its canonical spelling, its members'
 * verified cards in AgentId order, and the conversation a send uses
 * in, which need not exist yet.
 */
export interface ResolvedConversation {
  readonly address: MessageAddressInput;
  readonly conversationId: string;
  readonly memberCards: readonly VerifiedAgentCard[];
}

/**
 * Resolve an address to the conversation a send uses, failing as
 * that send would fail.
 */
export const resolveConversation = (
  runtime: EngineRuntime,
  to: MessageAddressInput,
): Effect.Effect<ResolvedConversation, SendError> =>
  Effect.gen(function* () {
    const resolved = yield* resolveCards(runtime, to);
    return {
      address: resolved.address,
      conversationId: yield* conversationIdOf(resolved),
      memberCards: resolved.memberCards,
    };
  }).pipe(Effect.withSpan("resolveConversation"));

const resolveMembership = (runtime: EngineRuntime, input: EngineSendInput) =>
  prepareMessageAddress({
    localAgentCard: runtime.input.localAgentCard,
    registry: runtime.input.registry,
    to: input.to,
  }).pipe(Effect.flatMap((resolved) => membershipFor(runtime, resolved)));

const proposalAction = (
  conversation: EngineConversation,
  intent: MessageIntent,
): Effect.Effect<ActionCore, SendError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const messageIntentHash = yield* hashMessageIntent(intent).pipe(
      Effect.mapError(representationFailure),
    );
    const head = conversation.head;
    if (head === undefined) {
      const anchor = conversation.currentAnchor;
      if (anchor.kind !== "initial_anchor_body") {
        return yield* Effect.fail(representationFailure());
      }
      const action: ActionCore = {
        sharnessVersion: intent.sharnessVersion,
        kind: "FIRST_MESSAGE",
        conversationId: conversation.conversationId,
        membership: conversation.membership.descriptor,
        anchor,
        previousRecordHash: null,
        messageIntent: intent,
        messageIntentHash,
      };
      return action;
    }
    const action: ActionCore = {
      sharnessVersion: intent.sharnessVersion,
      kind: "MESSAGE",
      conversationId: conversation.conversationId,
      membershipHash: conversation.membership.hash,
      anchorHash: anchorHashAtHead(conversation, head),
      previousRecordHash: head.recordHash,
      messageIntent: intent,
      messageIntentHash,
    };
    return action;
  });

/**
 * Rebase one unchanged local intent against the conversation's current head.
 * @param runtime Current engine state and protocol dependencies.
 * @param localIntent Durable immutable message intent awaiting certification.
 * @returns The predecessor-bound action hash proposed for this attempt.
 */
export const proposeIntent = (
  runtime: EngineRuntime,
  localIntent: EngineMessageIntent,
): Effect.Effect<ActionHash, SendError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const conversation = runtime.conversations.get(
      localIntent.intent.conversationId,
    );
    if (conversation === undefined) {
      return yield* Effect.fail(representationFailure());
    }
    const action = yield* proposalAction(conversation, localIntent.intent);
    const actionHash = yield* hashAction(action).pipe(
      Effect.mapError(representationFailure),
    );
    if (localIntent.proposedActionHash === actionHash) {
      return actionHash;
    }
    yield* queueLocalProposal(runtime, {
      conversation,
      localIntent,
      action,
      actionHash,
    });
    return actionHash;
  }).pipe(Effect.withSpan("proposeIntent"));

interface LocalProposal {
  readonly conversation: EngineConversation;
  readonly localIntent: EngineMessageIntent;
  readonly action: ActionCore;
  readonly actionHash: ActionHash;
}

/**
 * A proposal's resends: the catch-up retry delays, until a resend finds none
 * due.
 */
const proposalResendSchedule = catchUpRetrySchedule.pipe(
  Schedule.whileInput((due: boolean) => due),
);

/**
 * Queue a proposal behind the certified record it extends, then resend both
 * while its action certificate is incomplete. A store failure while
 * queueing is reported as a storage fault: the intent stays bound but not
 * proposed until recovery after a restart proposes it. Activation proposes
 * inside an uninterruptible region and a forked fiber inherits it, so the
 * resends run interruptibly and end with the engine.
 * @param runtime Engine that sends the proposal.
 * @param proposal The local proposal and the intent it proposes.
 * @returns Completion once both envelopes are queued, the intent records the
 *     proposed action, and its resends are scheduled.
 */
function queueLocalProposal(
  runtime: EngineRuntime,
  proposal: LocalProposal,
): Effect.Effect<void, SendError, SqlClient.SqlClient> {
  return Effect.gen(function* () {
    yield* Effect.uninterruptible(
      queueProposal(runtime, proposal).pipe(
        Effect.catchTags({
          EndpointStoreError: (error) =>
            runtime.input
              .reportStorageFault(error)
              .pipe(Effect.zipRight(Effect.fail(storeFailure(error)))),
          ClientRepresentationError: () => Effect.fail(representationFailure()),
        }),
        Effect.zipRight(
          Effect.sync(() => {
            proposal.localIntent.proposedActionHash = proposal.actionHash;
          }),
        ),
      ),
    );
    yield* Effect.scheduleFrom(
      resendProposal(runtime, proposal),
      true,
      proposalResendSchedule,
    ).pipe(
      markRetries("proposal", proposal.action.messageIntent.msgId, (exit) =>
        resendOutcome(runtime, proposal, exit),
      ),
      Effect.interruptible,
      Effect.forkIn(runtime.scope),
    );
  });
}

/**
 * How a proposal's resends ended: the engine ended them; a defect did; they
 * ran out while the proposal still awaited its action certificate; its message
 * was certified; or a later proposal of the intent, or a moved head,
 * replaced it.
 */
function resendOutcome(
  runtime: EngineRuntime,
  proposal: LocalProposal,
  exit: Exit.Exit<unknown>,
): RetryOutcome {
  const { action, actionHash } = proposal;
  if (Exit.isFailure(exit)) {
    return Exit.isInterrupted(exit) ? "interrupted" : "failed";
  }
  if (
    runtime.completedMessages.has(action.messageIntent.msgId) ||
    runtime.actionFolds.get(actionHash)?.recordHash !== undefined
  ) {
    return "certified";
  }
  const conversation = runtime.conversations.get(action.conversationId);
  return conversation !== undefined &&
    proposalIsOpen(runtime, proposal, conversation)
    ? "gave-up"
    : "superseded";
}

/**
 * Queue a proposal and, for a MESSAGE, the certified record of the head it
 * extends ahead of it. A faulty member can seal its durability vote so that
 * only some members open it, so a member may not have certified the head the
 * proposer certified when the proposal arrives, and it would drop the
 * proposal as not gap-free. The proposer's own copy of that record, which
 * every member can open, reaches each member first.
 * @param runtime Engine that sends the proposal.
 * @param proposal The proposal and the conversation it extends.
 * @returns Completion once both envelopes are queued.
 */
function queueProposal(
  runtime: EngineRuntime,
  proposal: LocalProposal,
): Effect.Effect<void, EngineOutboxError, SqlClient.SqlClient> {
  const head = proposal.conversation.head;
  const queueHead =
    head === undefined
      ? Effect.void
      : runtime.outbox.queuePacket(proposal.conversation, head.record);
  return queueHead.pipe(
    Effect.zipRight(
      runtime.outbox.queuePacket(proposal.conversation, {
        sharnessVersion: proposal.action.sharnessVersion,
        kind: "action_proposal",
        action: proposal.action,
      }),
    ),
  );
}

/**
 * Send a proposal again, with its head, while it is still the intent's
 * proposal at the conversation's head and its action certificate is
 * incomplete. Members that dropped it, such as one still catching up while
 * fenced, sign the new copy; members that signed already deduplicate it by
 * `ActionHash`. A fenced conversation sends nothing, and its resends wait for
 * it to recover without consuming attempts. The wait releases the engine
 * gate so recovery can complete. A store failure ends the resends and
 * reports a storage fault.
 * @param runtime Engine that sends the proposal.
 * @param proposal The proposal, the conversation it extends, and its intent.
 * @returns Whether a later resend is still due.
 */
function resendProposal(
  runtime: EngineRuntime,
  proposal: LocalProposal,
): Effect.Effect<boolean, never, SqlClient.SqlClient> {
  const { action } = proposal;
  return runtime.gate
    .withPermits(1)(
      Effect.suspend(
        (): Effect.Effect<
          boolean | Deferred.Deferred<undefined>,
          never,
          SqlClient.SqlClient
        > => {
          const conversation = runtime.conversations.get(action.conversationId);
          if (
            conversation === undefined ||
            !proposalIsOpen(runtime, proposal, conversation)
          ) {
            return Effect.succeed(false);
          }
          const barrier = pendingRecoveryFence(runtime, action.conversationId);
          if (barrier !== undefined) {
            return Effect.succeed(barrier);
          }
          return Effect.uninterruptible(
            queueProposal(runtime, { ...proposal, conversation }),
          ).pipe(
            Effect.as(true),
            Effect.catchTags({
              EndpointStoreError: (error) =>
                runtime.input.reportStorageFault(error).pipe(Effect.as(false)),
              ClientRepresentationError: () => Effect.succeed(false),
            }),
          );
        },
      ),
    )
    .pipe(
      Effect.flatMap((due) =>
        typeof due === "boolean"
          ? Effect.succeed(due)
          : Deferred.await(due).pipe(
              Effect.zipRight(resendProposal(runtime, proposal)),
            ),
      ),
    );
}

/**
 * Whether a proposal still awaits its action certificate: it is still its
 * intent's proposal, its message has not completed, no record certifies it, and
 * the conversation's head is still the one it extends.
 * @param runtime Engine that sent the proposal.
 * @param proposal The proposal and the intent it proposes.
 * @param conversation The conversation's current state.
 * @returns Whether a resend of the proposal is still useful.
 */
function proposalIsOpen(
  runtime: EngineRuntime,
  proposal: LocalProposal,
  conversation: EngineConversation,
): boolean {
  const { action, actionHash, localIntent } = proposal;
  const head = conversation.head?.recordHash ?? null;
  return (
    localIntent.proposedActionHash === actionHash &&
    !runtime.completedMessages.has(action.messageIntent.msgId) &&
    runtime.actionFolds.get(actionHash)?.recordHash === undefined &&
    head === action.previousRecordHash
  );
}

const createConversation = (
  runtime: EngineRuntime,
  membership: VerifiedMembership,
): Effect.Effect<
  Readonly<{
    conversation: EngineConversation;
    foundation: ConversationFoundation;
  }>,
  SendError
> =>
  Effect.gen(function* () {
    const routerAnchor = yield* runtime.input.routerWorker.currentAnchor.pipe(
      Effect.mapError(currentAnchorFailure),
    );
    const anchor = yield* Schema.decodeUnknown(InitialAnchorBody)({
      sharnessVersion: membership.descriptor.sharnessVersion,
      kind: "initial_anchor_body",
      conversationId: membership.descriptor.conversationId,
      membershipHash: membership.hash,
      routerInstanceId: routerAnchor.routerInstanceId,
    }).pipe(Effect.mapError(representationFailure));
    const anchorHash = yield* hashAnchor(anchor).pipe(
      Effect.mapError(representationFailure),
    );
    const foundation: ConversationFoundation = {
      conversationId: membership.descriptor.conversationId,
      membershipHash: membership.hash,
      canonicalMembership: yield* encodeCanonical(
        MembershipDescriptorSchema,
        membership.descriptor,
      ).pipe(Effect.mapError(representationFailure)),
      anchorHash,
      canonicalAnchor: yield* encodeCanonical(InitialAnchorBody, anchor).pipe(
        Effect.mapError(representationFailure),
      ),
    };
    return {
      foundation,
      conversation: {
        conversationId: membership.descriptor.conversationId,
        membership,
        currentAnchor: anchor,
      },
    };
  });

function currentAnchorFailure(error: RouterWorkerUnavailableError): SendError {
  const reasonByTag = {
    RouterWorkerUnavailableError: "network-unavailable",
  } as const satisfies Readonly<
    Record<RouterWorkerUnavailableError["_tag"], SendError["reason"]>
  >;
  return new SendError({ reason: reasonByTag[error._tag] });
}

/**
 * Wait before taking the engine gate: worker recovery needs that same gate
 * before attachment can finish, including immediately after registration.
 */
const awaitRouterAttachment = (
  runtime: EngineRuntime,
): Effect.Effect<void, SendError> =>
  runtime.input.routerWorker.currentAnchor.pipe(
    Effect.catchTag("RouterWorkerUnavailableError", () =>
      runtime.input.routerWorker.awaitAnchor.pipe(
        Effect.timeoutFail({
          duration: ROUTER_ATTACH_TIMEOUT,
          onTimeout: () => new SendError({ reason: "network-unavailable" }),
        }),
      ),
    ),
    Effect.asVoid,
  );

/**
 * One durably bound send: its minted identity and its completion latch, which
 * yields the hash of the message's locally stored certified record.
 */
export interface PreparedSendHandle {
  readonly msgId: MsgId;
  readonly completion: Deferred.Deferred<RecordHash, SendError>;
}

const noBindHold = Effect.succeed(Effect.void);

/** Canonical strings preserve prepared bytes without exposing mutable buffers or caller values. */
export interface PreparedSend {
  readonly canonicalMembership: string;
  readonly canonicalIntent: string;
  readonly collective?: CollectiveMessageBinding;
}

/** Request claims are acquired at binding and released only when no intent binds. */
export type BindHold<E> = Effect.Effect<
  Effect.Effect<void, never, SqlClient.SqlClient>,
  E,
  SqlClient.SqlClient
>;

interface PreparedIntent {
  readonly membership: VerifiedMembership;
  readonly intent: MessageIntent;
  readonly canonicalIntent: Uint8Array;
  readonly collective?: CollectiveMessageBinding;
}

/** Decode only retained preparation data; resolving names or minting another identity is forbidden here. */
export const preparedSendData = (prepared: PreparedSend) =>
  Effect.all({
    descriptor: decodeCanonical(
      MembershipDescriptorSchema,
      new TextEncoder().encode(prepared.canonicalMembership),
    ),
    intent: decodeCanonical(
      MessageIntentSchema,
      new TextEncoder().encode(prepared.canonicalIntent),
    ),
  }).pipe(Effect.mapError(representationFailure));

/** Resolve and capture one exact message without creating outgoing ownership. */
export const prepareSend = (
  runtime: EngineRuntime,
  input: EngineSendInput,
): Effect.Effect<
  PreparedSend,
  SendError | RecipientResolutionError,
  SqlClient.SqlClient
> =>
  Effect.gen(function* () {
    yield* awaitRouterAttachment(runtime);
    const canonicalContent = yield* encodeCanonical(
      Content,
      input.content,
    ).pipe(Effect.mapError(representationFailure));
    const content = yield* decodeCanonical(Content, canonicalContent).pipe(
      Effect.mapError(representationFailure),
    );
    const membership = yield* resolveMembership(runtime, input);
    const msgId = yield* mintMsgId().pipe(
      Effect.mapError(representationFailure),
    );
    const intent = yield* Schema.decodeUnknown(MessageIntentSchema)({
      sharnessVersion: runtime.wireVersion,
      kind: "message_intent",
      conversationId: membership.descriptor.conversationId,
      membershipHash: membership.hash,
      authorAgentId: runtime.input.localAgentCard.agentId,
      msgId,
      content,
    }).pipe(Effect.mapError(representationFailure));
    const canonicalIntent = yield* encodeCanonical(
      MessageIntentSchema,
      intent,
    ).pipe(Effect.mapError(representationFailure));
    const canonicalMembership = yield* encodeCanonical(
      MembershipDescriptorSchema,
      membership.descriptor,
    ).pipe(Effect.mapError(representationFailure));
    return Object.freeze({
      canonicalIntent: new TextDecoder().decode(canonicalIntent),
      canonicalMembership: new TextDecoder().decode(canonicalMembership),
      ...(input.collective === undefined
        ? {}
        : { collective: Object.freeze({ ...input.collective }) }),
    });
  }).pipe(Effect.withSpan("prepareSend"));

/** Bind the exact captured identity after the caller's protocol claim succeeds. */
export const acceptSend = <E = never>(
  runtime: EngineRuntime,
  prepared: PreparedSend,
  hold: BindHold<E> = noBindHold,
): Effect.Effect<PreparedSendHandle, SendError | E, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const { descriptor, intent } = yield* preparedSendData(prepared);
    const membership = yield* verifyMembershipDescriptor(
      descriptor,
      runtime.input.registrySignerPublicKey,
    ).pipe(Effect.mapError(representationFailure));
    if (
      intent.conversationId !== descriptor.conversationId ||
      intent.membershipHash !== membership.hash ||
      intent.authorAgentId !== runtime.input.localAgentCard.agentId
    ) {
      return yield* representationFailure();
    }
    const value: PreparedIntent = {
      membership,
      intent,
      canonicalIntent: new TextEncoder().encode(prepared.canonicalIntent),
      ...(prepared.collective === undefined
        ? {}
        : { collective: prepared.collective }),
    };
    const activation = yield* activateHeld(runtime, value, hold);
    return { msgId: intent.msgId, completion: activation.completion };
  }).pipe(Effect.withSpan("acceptSend"));

/** The release survives interruption and preserves custody when an intent was durably accepted. */
function activateHeld<E>(
  runtime: EngineRuntime,
  prepared: PreparedIntent,
  hold: BindHold<E>,
): Effect.Effect<
  Exclude<IntentActivation, { kind: "waiting" }>,
  SendError | E,
  SqlClient.SqlClient
> {
  return Effect.uninterruptibleMask((restore) => {
    let release: Effect.Effect<void, never, SqlClient.SqlClient> = Effect.void;
    const acquire = hold.pipe(
      Effect.tap((held) =>
        Effect.sync(() => {
          release = held;
        }),
      ),
      Effect.asVoid,
    );
    return restore(activateIntent(runtime, prepared, acquire)).pipe(
      Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : release)),
    );
  });
}

function storedIntent(prepared: PreparedIntent): StoredMessageIntent {
  return {
    conversationId: prepared.intent.conversationId,
    membershipHash: prepared.intent.membershipHash,
    authorAgentId: prepared.intent.authorAgentId,
    msgId: prepared.intent.msgId,
    canonicalIntent: prepared.canonicalIntent,
  };
}

function bindPreparedIntent<E>(
  runtime: EngineRuntime,
  prepared: PreparedIntent,
  acquire: Effect.Effect<void, E, SqlClient.SqlClient>,
): Effect.Effect<void, SendError | E, SqlClient.SqlClient> {
  return Effect.gen(function* () {
    const message = {
      intent: storedIntent(prepared),
      ...(prepared.collective === undefined
        ? {}
        : { collective: prepared.collective }),
    };
    const retained = runtime.conversations.get(prepared.intent.conversationId);
    if (retained !== undefined) {
      if (retained.membership.hash !== prepared.membership.hash) {
        return yield* new SendError({ reason: "certification-unavailable" });
      }
      yield* acquire;
      return yield* Store.bindMessageIntent({
        kind: "existing-conversation",
        ...message,
      }).pipe(
        Effect.catchTag("EndpointStoreError", (error) =>
          failBind(runtime, error),
        ),
        Effect.asVoid,
      );
    }
    const created = yield* createConversation(runtime, prepared.membership);
    yield* acquire;
    yield* Store.bindMessageIntent({
      kind: "new-conversation",
      foundation: created.foundation,
      ...message,
    }).pipe(
      Effect.catchTag("EndpointStoreError", (error) =>
        failBind(runtime, error),
      ),
    );
    runtime.conversations.set(
      created.conversation.conversationId,
      created.conversation,
    );
  });
}

type IntentActivation =
  | Readonly<{
      kind: "ready";
      completion: Deferred.Deferred<RecordHash, SendError>;
    }>
  | Readonly<{ kind: "waiting"; barrier: Deferred.Deferred<undefined> }>;

function activateIntent<E>(
  runtime: EngineRuntime,
  prepared: PreparedIntent,
  acquire: Effect.Effect<void, E, SqlClient.SqlClient>,
): Effect.Effect<
  Exclude<IntentActivation, { kind: "waiting" }>,
  SendError | E,
  SqlClient.SqlClient
> {
  return runtime.gate
    .withPermits(1)(
      Effect.uninterruptible(activateIntentOnce(runtime, prepared, acquire)),
    )
    .pipe(
      Effect.flatMap((activation) => {
        switch (activation.kind) {
          case "ready":
            return Effect.succeed(activation);
          case "waiting":
            return runtime.phases
              .rearmCatchUp(runtime, prepared.intent.conversationId)
              .pipe(
                Effect.zipRight(Deferred.await(activation.barrier)),
                Effect.zipRight(activateIntent(runtime, prepared, acquire)),
              );
          default: {
            const exhaustive: never = activation;
            return exhaustive;
          }
        }
      }),
    );
}

function activateIntentOnce<E>(
  runtime: EngineRuntime,
  prepared: PreparedIntent,
  acquire: Effect.Effect<void, E, SqlClient.SqlClient>,
): Effect.Effect<IntentActivation, SendError | E, SqlClient.SqlClient> {
  const { intent } = prepared;
  return Effect.gen(function* () {
    const barrier = pendingRecoveryFence(runtime, intent.conversationId);
    if (barrier !== undefined) {
      return { kind: "waiting", barrier } satisfies IntentActivation;
    }
    yield* bindPreparedIntent(runtime, prepared, acquire);
    return yield* activateBoundIntent(runtime, prepared);
  });
}

/**
 * Propose a message whose intent `bindPreparedIntent` durably stored, or complete
 * it when it already certified. The intent is in the store and
 * `runtime.intents` before any proposal, so a failure here does not mean the
 * message was not sent: `rebasePendingIntents` proposes it again when the
 * conversation's head moves, and recovery proposes it after a restart. So
 * the activation stays ready after any failure here, and its completion
 * latch fails the send as `delivery-pending`.
 * @param runtime Engine whose conversation and outbox take the proposal.
 * @param prepared The stored intent with its canonical bytes.
 * @returns The ready activation and its completion latch.
 */
function activateBoundIntent(
  runtime: EngineRuntime,
  prepared: PreparedIntent,
): Effect.Effect<IntentActivation, SendError, SqlClient.SqlClient> {
  const { canonicalIntent, intent } = prepared;
  return Effect.gen(function* () {
    const retained = runtime.intents.get(intent.msgId);
    if (retained !== undefined) {
      const completedRecordHash = runtime.completedMessages.get(intent.msgId);
      if (completedRecordHash !== undefined) {
        yield* Deferred.succeed(retained.completion, completedRecordHash);
      } else {
        yield* proposeIntent(runtime, retained);
      }
      return {
        kind: "ready",
        completion: retained.completion,
      } satisfies IntentActivation;
    }
    const completion = yield* Deferred.make<RecordHash, SendError>();
    const localIntent: EngineMessageIntent = {
      intent,
      canonicalIntent,
      completion,
    };
    const completedRecordHash = runtime.completedMessages.get(intent.msgId);
    yield* Effect.sync(() => {
      runtime.intents.set(intent.msgId, localIntent);
    });
    if (completedRecordHash !== undefined) {
      yield* Deferred.succeed(completion, completedRecordHash);
    } else {
      yield* proposeIntent(runtime, localIntent);
    }
    return { kind: "ready", completion } satisfies IntentActivation;
  }).pipe(Effect.catchAll(() => pendingActivation()));
}

/**
 * A bound intent's activation after its proposal failed: still ready, with a
 * latch that fails as `delivery-pending`.
 */
function pendingActivation(): Effect.Effect<IntentActivation> {
  return Deferred.make<RecordHash, SendError>().pipe(
    Effect.tap((completion) =>
      Deferred.fail(completion, new SendError({ reason: "delivery-pending" })),
    ),
    Effect.map(
      (completion): IntentActivation => ({ kind: "ready", completion }),
    ),
  );
}
