/** @file Address resolution, immutable intent binding, and proposal creation. */

import {
  Deferred,
  Duration,
  Effect,
  Exit,
  Option,
  Schedule,
  Schema,
} from "effect";
import type { FirewallSendError } from "../../firewall/outcome/index.js";
import type { MessageAddressInput } from "../records/values.js";
import type { RouterWorkerUnavailableError } from "../router/index.js";
import type {
  CollectivePostBinding,
  ConversationFoundation,
  EndpointStoreError,
  FirewallCompletion,
  PostIntentBinding,
  PostIntent as StoredPostIntent,
} from "../store/index.js";
import type {
  EngineConversation,
  EngineOutboxError,
  EnginePostIntent,
  EngineRuntime,
} from "./engine-context.js";
import { encodeCanonical } from "../../encoding/canonical-json.js";
import { AgentCard, type VerifiedAgentCard } from "../../identity/cards.js";
import {
  type ActionCore,
  type ActionHash,
  Content,
  deriveConversationId,
  GenesisAnchorBody,
  hashAction,
  hashAnchor,
  hashPostIntent,
  MembershipDescriptor as MembershipDescriptorSchema,
  mintPostId,
  type PostId,
  type PostIntent,
  PostIntent as PostIntentSchema,
  type RecordHash,
  type VerifiedMembership,
  verifyMembershipDescriptor,
} from "../records/index.js";
import { resolveMessageAddress } from "./address.js";
import { SendError } from "./errors.js";
import { anchorHashAtHead } from "./history/index.js";
import {
  catchUpRetrySchedule,
  pendingRecoveryFence,
} from "./recovery/index.js";
import { markRetries, type RetryOutcome } from "./retry-markers.js";

/**
 * One post the engine certifies: its address and its complete content. The
 * collective layer above the engine builds the content, so the engine never
 * reads the collective part.
 */
export interface EngineSendInput {
  readonly to: MessageAddressInput;
  readonly content: Content;
  readonly collective?: CollectivePostBinding;
}

/** A locally certified post: its minted identity and its stored record's hash. */
export interface EngineSentPost {
  readonly postId: PostId;
  readonly recordHash: RecordHash;
}

/**
 * Fail a send whose intent bind did not complete. A store refusal is raised
 * before the bind commits and rolls it back, so nothing was queued. A raw
 * persistence failure leaves durability unknown unless the store confirms
 * no commit. An uncertain failure is reported as a storage fault, since a durable
 * intent outside `runtime.intents` waits for a restart.
 * @param runtime The engine whose daemon hears of the fault.
 * @param error The store's failure.
 * @returns The send's failure.
 */
function failBind(
  runtime: EngineRuntime,
  error: EndpointStoreError,
): Effect.Effect<never, SendError> {
  if (
    error.reason === "persistence" &&
    error.commitOutcome === "not-committed"
  ) {
    return Effect.fail(storeFailure(error));
  }
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
  "newer-schema": "persistence-failed",
  "pre-reset": "persistence-failed",
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

/** A check's attempts: the first, one fresh recheck, and one terminal. */
const CHECK_ATTEMPTS = 3;

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
 * verified cards in AgentId order, and the conversation a send to it posts
 * in, which need not exist yet.
 */
export interface ResolvedConversation {
  readonly address: MessageAddressInput;
  readonly conversationId: string;
  readonly memberCards: readonly VerifiedAgentCard[];
}

/**
 * Resolve an address to the conversation a send to it posts in, failing as
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
  resolveCards(runtime, input.to).pipe(
    Effect.flatMap((resolved) => membershipFor(runtime, resolved)),
  );

const proposalAction = (
  conversation: EngineConversation,
  intent: PostIntent,
): Effect.Effect<ActionCore, SendError> =>
  Effect.gen(function* () {
    const postIntentHash = yield* hashPostIntent(intent).pipe(
      Effect.mapError(representationFailure),
    );
    const head = conversation.head;
    if (head === undefined) {
      const anchor = conversation.currentAnchor;
      if (anchor.kind !== "genesis_anchor_body") {
        return yield* Effect.fail(representationFailure());
      }
      const action: ActionCore = {
        sharnessVersion: intent.sharnessVersion,
        kind: "GENESIS",
        conversationId: conversation.conversationId,
        membership: conversation.membership.descriptor,
        anchor,
        previousRecordHash: null,
        postIntent: intent,
        postIntentHash,
      };
      return action;
    }
    const action: ActionCore = {
      sharnessVersion: intent.sharnessVersion,
      kind: "POST",
      conversationId: conversation.conversationId,
      membershipHash: conversation.membership.hash,
      anchorHash: anchorHashAtHead(conversation, head),
      previousRecordHash: head.recordHash,
      postIntent: intent,
      postIntentHash,
    };
    return action;
  });

/**
 * Rebase one unchanged local intent against the conversation's current head.
 * @param runtime Current engine state and protocol dependencies.
 * @param localIntent Durable immutable post intent awaiting certification.
 * @returns The predecessor-bound action hash proposed for this attempt.
 */
export const proposeIntent = (
  runtime: EngineRuntime,
  localIntent: EnginePostIntent,
): Effect.Effect<ActionHash, SendError> =>
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
  readonly localIntent: EnginePostIntent;
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
): Effect.Effect<void, SendError> {
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
      markRetries("proposal", proposal.action.postIntent.postId, (exit) =>
        resendOutcome(runtime, proposal, exit),
      ),
      Effect.interruptible,
      Effect.forkIn(runtime.scope),
    );
  });
}

/**
 * How a proposal's resends ended: the engine ended them; a defect did; they
 * ran out while the proposal still awaited its action certificate; its post
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
    runtime.completedPosts.has(action.postIntent.postId) ||
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
 * Queue a proposal and, for a POST, the certified record of the head it
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
): Effect.Effect<void, EngineOutboxError> {
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
): Effect.Effect<boolean> {
  const { action } = proposal;
  return runtime.gate
    .withPermits(1)(
      Effect.suspend(
        (): Effect.Effect<boolean | Deferred.Deferred<undefined>> => {
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
 * intent's proposal, its post has not completed, no record certifies it, and
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
    !runtime.completedPosts.has(action.postIntent.postId) &&
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
    const anchor = yield* Schema.decodeUnknown(GenesisAnchorBody)({
      sharnessVersion: membership.descriptor.sharnessVersion,
      kind: "genesis_anchor_body",
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
      canonicalAnchor: yield* encodeCanonical(GenesisAnchorBody, anchor).pipe(
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
 * yields the hash of the post's locally stored certified record.
 */
export interface PreparedSendHandle {
  readonly postId: PostId;
  readonly completion: Deferred.Deferred<RecordHash, SendError>;
}

/**
 * Persist an addressed intent and return its durable completion latch.
 * The latch completes when the minted post becomes locally certified.
 */
export const prepareSend = (
  runtime: EngineRuntime,
  input: EngineSendInput,
): Effect.Effect<PreparedSendHandle, SendError> =>
  prepareBoundSend(runtime, input, (binding) =>
    runtime.input.store
      .bindPostIntent(binding)
      .pipe(Effect.as("admitted" as const)),
  ).pipe(Effect.withSpan("prepareSend"));

/**
 * Persist a gather request post's intent only against its operation's
 * admitted check, whose candidate is the canonical request content this post
 * carries. A post whose content the check did not admit binds nothing and
 * fails as `certification-unavailable`.
 */
export const prepareAdmittedSend = (
  runtime: EngineRuntime,
  input: EngineSendInput,
  checkId: string,
): Effect.Effect<PreparedSendHandle, SendError> =>
  encodeCanonical(Content, input.content).pipe(
    Effect.mapError(representationFailure),
    Effect.flatMap((canonicalCandidate) =>
      prepareBoundSend(runtime, input, (binding) =>
        runtime.input.store.bindAdmittedPostIntent(binding, {
          checkId,
          canonicalCandidate,
        }),
      ),
    ),
    Effect.withSpan("prepareAdmittedSend"),
  );

/** Persist an addressed intent through `admission`, which decides whether it binds. */
function prepareBoundSend(
  runtime: EngineRuntime,
  input: EngineSendInput,
  admission: IntentAdmission,
): Effect.Effect<PreparedSendHandle, SendError> {
  return awaitRouterAttachment(runtime).pipe(
    Effect.zipRight(prepareIntent(runtime, input)),
    Effect.flatMap((prepared) =>
      activateIntent(runtime, prepared, admission).pipe(
        Effect.flatMap((activation) =>
          activation.kind === "refused"
            ? Effect.fail(representationFailure())
            : Effect.succeed({
                postId: prepared.intent.postId,
                completion: activation.completion,
              }),
        ),
      ),
    ),
  );
}

/** Prepared data has no execution authority until the atomic store transition succeeds. */
export interface PreparedSend {
  readonly membership: VerifiedMembership;
  readonly intent: PostIntent;
  readonly canonicalIntent: EnginePostIntent["canonicalIntent"];
  readonly collective?: CollectivePostBinding;
}

/**
 * The application boundary supplies checking without gaining engine
 * capabilities. `admitted` is opaque to the engine: the value of the check
 * that admits the post returns with it.
 */
export type PreparedSendCheck<A> = (
  prepared: PreparedSend,
  terminal: boolean,
) => Effect.Effect<
  {
    readonly completion: FirewallCompletion;
    readonly refusal: FirewallSendError;
    readonly admitted: A;
  },
  EndpointStoreError
>;

/**
 * A precondition a caller holds across one bind attempt. Running it
 * re-establishes the precondition just before the intent binds and yields
 * the effect that gives it up. The engine gives it up when the attempt binds
 * nothing. A bound intent keeps it, including one whose activation fails:
 * that intent reports `delivery-pending` through its completion latch, since
 * its post may still certify later. A failure refuses the send before
 * anything binds. Only a check that admits takes it, so a refused send never
 * establishes it.
 */
export type BindHold<E> = Effect.Effect<Effect.Effect<void>, E>;

/**
 * Check and commit until a commit is fresh. A stale capture gets one fresh
 * attempt; a second gets a terminal attempt, which holds without inference
 * and so commits.
 * @param attempt One check and its commit, told whether it is terminal.
 * @returns The first fresh commit, or none if every attempt was stale.
 */
export const untilFresh = <A, E>(
  attempt: (terminal: boolean) => Effect.Effect<A | "stale", E>,
): Effect.Effect<Option.Option<A>, E> => {
  const from = (index: number): Effect.Effect<Option.Option<A>, E> =>
    index === CHECK_ATTEMPTS
      ? Effect.succeed(Option.none())
      : attempt(index === CHECK_ATTEMPTS - 1).pipe(
          Effect.flatMap((committed) =>
            committed === "stale"
              ? from(index + 1)
              : Effect.succeed(Option.some(committed)),
          ),
        );
  return from(0);
};

/**
 * Each attempt checks first, then commits: an admitting check takes `hold`
 * and binds, so a caller's precondition is re-established after the check
 * and held only across the bind. One stale capture gets one fresh recheck,
 * and a second a terminal attempt.
 */
export const prepareCheckedSend = <E, A>(
  runtime: EngineRuntime,
  input: EngineSendInput,
  check: PreparedSendCheck<A>,
  hold: BindHold<E>,
): Effect.Effect<
  PreparedSendHandle & { readonly admitted: A },
  SendError | FirewallSendError | E
> =>
  Effect.gen(function* () {
    yield* awaitRouterAttachment(runtime);
    const prepared = yield* prepareIntent(runtime, input);
    const committed = yield* untilFresh((terminal) =>
      check(prepared, terminal).pipe(
        Effect.mapError(storeFailure),
        Effect.flatMap((checked) =>
          commitCheck(runtime, prepared, checked, hold),
        ),
      ),
    );
    return Option.isSome(committed)
      ? committed.value
      : yield* Effect.fail(representationFailure());
  }).pipe(Effect.withSpan("prepareCheckedSend"));

/**
 * Commit one check of a prepared post. A withholding check binds nothing and
 * takes no hold. An admitting check takes `hold` just before the intent
 * binds; when the hold refuses, the check commits withheld, so its judgment
 * is retained, and the send fails with the hold's refusal.
 */
function commitCheck<E, A>(
  runtime: EngineRuntime,
  prepared: PreparedSend,
  checked: Effect.Effect.Success<ReturnType<PreparedSendCheck<A>>>,
  hold: BindHold<E>,
): Effect.Effect<
  (PreparedSendHandle & { readonly admitted: A }) | "stale",
  SendError | FirewallSendError | E
> {
  return Effect.gen(function* () {
    const { completion } = checked;
    const withhold = activateIntent(
      runtime,
      prepared,
      bindChecked(runtime, { ...completion, admit: false }),
    );
    const activation = completion.admit
      ? yield* activateHeld(
          runtime,
          prepared,
          bindChecked(runtime, completion),
          hold.pipe(Effect.tapError(() => withhold)),
        )
      : yield* withhold;
    if (activation.kind === "ready") {
      return {
        postId: prepared.intent.postId,
        completion: activation.completion,
        admitted: checked.admitted,
      };
    }
    return activation.disposition === "withheld"
      ? yield* checked.refusal
      : activation.disposition;
  });
}

function bindChecked(
  runtime: EngineRuntime,
  completion: FirewallCompletion,
): IntentAdmission {
  return (binding) =>
    runtime.input.store.bindCheckedPostIntent(binding, completion);
}

/**
 * Take `hold`, then activate the prepared intent through `bind`, giving the
 * hold up unless the intent is ready. The hold is taken uninterruptibly, so
 * an interruption after it is taken still gives it up.
 */
function activateHeld<E>(
  runtime: EngineRuntime,
  prepared: PreparedSend,
  bind: IntentAdmission,
  hold: BindHold<E>,
): Effect.Effect<
  Exclude<IntentActivation, { kind: "waiting" }>,
  SendError | E
> {
  return Effect.uninterruptibleMask((restore) =>
    hold.pipe(
      Effect.flatMap((release) =>
        restore(activateIntent(runtime, prepared, bind)).pipe(
          Effect.onExit((exit) =>
            Exit.isSuccess(exit) && exit.value.kind === "ready"
              ? Effect.void
              : release,
          ),
        ),
      ),
    ),
  );
}

function prepareIntent(
  runtime: EngineRuntime,
  input: EngineSendInput,
): Effect.Effect<PreparedSend, SendError> {
  return Effect.gen(function* () {
    const membership = yield* resolveMembership(runtime, input);
    const postId = yield* mintPostId().pipe(
      Effect.mapError(representationFailure),
    );
    const intent = yield* Schema.decodeUnknown(PostIntentSchema)({
      sharnessVersion: runtime.wireVersion,
      kind: "post_intent",
      conversationId: membership.descriptor.conversationId,
      membershipHash: membership.hash,
      authorAgentId: runtime.input.localAgentCard.agentId,
      postId,
      content: input.content,
    }).pipe(Effect.mapError(representationFailure));
    const canonicalIntent = yield* encodeCanonical(
      PostIntentSchema,
      intent,
    ).pipe(Effect.mapError(representationFailure));
    return {
      membership,
      intent,
      canonicalIntent,
      ...(input.collective === undefined
        ? {}
        : { collective: input.collective }),
    };
  });
}

function storedIntent(prepared: PreparedSend): StoredPostIntent {
  return {
    conversationId: prepared.intent.conversationId,
    membershipHash: prepared.intent.membershipHash,
    authorAgentId: prepared.intent.authorAgentId,
    postId: prepared.intent.postId,
    canonicalIntent: prepared.canonicalIntent,
  };
}

function bindPreparedIntent(
  runtime: EngineRuntime,
  prepared: PreparedSend,
  bind: IntentAdmission,
): Effect.Effect<"admitted" | "withheld" | "stale", SendError> {
  return Effect.gen(function* () {
    const retained = runtime.conversations.get(prepared.intent.conversationId);
    if (retained !== undefined) {
      if (retained.membership.hash !== prepared.membership.hash) {
        return yield* Effect.fail(
          new SendError({ reason: "certification-unavailable" }),
        );
      }
      return yield* bind({
        kind: "existing-conversation",
        intent: storedIntent(prepared),
        ...(prepared.collective === undefined
          ? {}
          : { collective: prepared.collective }),
      }).pipe(
        Effect.catchTag("EndpointStoreError", (error) =>
          failBind(runtime, error),
        ),
      );
    }
    const created = yield* createConversation(runtime, prepared.membership);
    const disposition = yield* bind({
      kind: "new-conversation",
      foundation: created.foundation,
      intent: storedIntent(prepared),
      ...(prepared.collective === undefined
        ? {}
        : { collective: prepared.collective }),
    }).pipe(
      Effect.catchTag("EndpointStoreError", (error) =>
        failBind(runtime, error),
      ),
    );
    if (disposition !== "admitted") {
      return disposition;
    }
    yield* Effect.sync(() => {
      runtime.conversations.set(
        created.conversation.conversationId,
        created.conversation,
      );
    });
    return disposition;
  });
}

type IntentAdmission = (
  binding: PostIntentBinding,
) => Effect.Effect<"admitted" | "withheld" | "stale", EndpointStoreError>;

type IntentActivation =
  | Readonly<{ kind: "refused"; disposition: "withheld" | "stale" }>
  | Readonly<{
      kind: "ready";
      completion: Deferred.Deferred<RecordHash, SendError>;
    }>
  | Readonly<{
      kind: "waiting";
      barrier: Deferred.Deferred<undefined>;
    }>;

function activateIntent(
  runtime: EngineRuntime,
  prepared: PreparedSend,
  bind: IntentAdmission,
): Effect.Effect<Exclude<IntentActivation, { kind: "waiting" }>, SendError> {
  return runtime.gate
    .withPermits(1)(
      Effect.uninterruptible(activateIntentOnce(runtime, prepared, bind)),
    )
    .pipe(
      Effect.flatMap((activation) => {
        switch (activation.kind) {
          case "ready":
          case "refused":
            return Effect.succeed(activation);
          case "waiting":
            return runtime.phases
              .rearmCatchUp(runtime, prepared.intent.conversationId)
              .pipe(
                Effect.zipRight(Deferred.await(activation.barrier)),
                Effect.zipRight(activateIntent(runtime, prepared, bind)),
              );
          default: {
            const exhaustive: never = activation;
            return exhaustive;
          }
        }
      }),
    );
}

function activateIntentOnce(
  runtime: EngineRuntime,
  prepared: PreparedSend,
  bind: IntentAdmission,
): Effect.Effect<IntentActivation, SendError> {
  const { intent } = prepared;
  return Effect.gen(function* () {
    const barrier = pendingRecoveryFence(runtime, intent.conversationId);
    if (barrier !== undefined) {
      return { kind: "waiting", barrier } satisfies IntentActivation;
    }
    const disposition = yield* bindPreparedIntent(runtime, prepared, bind);
    if (disposition !== "admitted") {
      return { kind: "refused", disposition } satisfies IntentActivation;
    }
    return yield* activateBoundIntent(runtime, prepared);
  });
}

/**
 * Propose a post whose intent `bindPreparedIntent` durably stored, or complete
 * it when it already certified. The intent is in the store and
 * `runtime.intents` before any proposal, so a failure here does not mean the
 * post was not sent: `rebasePendingIntents` proposes it again when the
 * conversation's head moves, and recovery proposes it after a restart. So
 * the activation stays ready after any failure here, and its completion
 * latch fails the send as `delivery-pending`.
 * @param runtime Engine whose conversation and outbox take the proposal.
 * @param prepared The stored intent with its canonical bytes.
 * @returns The ready activation and its completion latch.
 */
function activateBoundIntent(
  runtime: EngineRuntime,
  prepared: PreparedSend,
): Effect.Effect<IntentActivation, SendError> {
  const { canonicalIntent, intent } = prepared;
  return Effect.gen(function* () {
    const retained = runtime.intents.get(intent.postId);
    if (retained !== undefined) {
      const completedRecordHash = runtime.completedPosts.get(intent.postId);
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
    const localIntent: EnginePostIntent = {
      intent,
      canonicalIntent,
      completion,
    };
    const completedRecordHash = runtime.completedPosts.get(intent.postId);
    yield* Effect.sync(() => {
      runtime.intents.set(intent.postId, localIntent);
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
