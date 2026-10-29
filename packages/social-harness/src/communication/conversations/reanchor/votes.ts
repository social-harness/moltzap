/**
 * @file Re-anchor votes: one recovery run's memory of the votes it took,
 * their persistence, the stored votes for a candidate anchor, and the
 * completed re-anchor they certify.
 */

import { Effect, Schema } from "effect";
import type { AgentId } from "../../../identity/agents.js";
import type { EngineActionFold, EngineRuntime } from "../engine-context.js";
import {
  decodeCanonical,
  encodeCanonical,
} from "../../../encoding/canonical-json.js";
import {
  SignedMessage,
  type SignedMessage as SignedMessageValue,
} from "../../../identity/envelope/signed-message.js";
import {
  type AnchorHash as AnchorHashValue,
  CompletedReanchor,
  type CompletedReanchor as CompletedReanchorValue,
  type ConversationId as ConversationIdValue,
  type EvidenceStatement as EvidenceStatementValue,
  ReanchorBody,
  type ReanchorBody as ReanchorBodyValue,
  type ReanchorVoteStatement as ReanchorVoteStatementValue,
  type VerifiedMembership,
  verifyStableEvidence,
} from "../../records/index.js";
import { RouterWorkerPersistenceError } from "../../router/index.js";
import {
  type EndpointRecovery,
  type EndpointStore,
  isSemanticStoreRejection,
} from "../../store/index.js";
import { orderedSignatures, protocolEvidence } from "../history/index.js";

/** One verified re-anchor vote and its signed message, held for the rest of the run. */
export interface PendingReanchorVote {
  readonly message: SignedMessageValue;
  readonly statement: ReanchorVoteStatementValue;
}

/**
 * One recovery run's re-anchor vote memory: the votes it holds per
 * conversation and candidate anchor.
 */
export type ReanchorVotes = Map<
  ConversationIdValue,
  Map<AnchorHashValue, Map<AgentId, PendingReanchorVote>>
>;

/**
 * Hold a verified vote for the rest of the run.
 * @param votes The run's vote memory.
 * @param vote Verified vote the run took.
 * @returns Completion once the vote is held.
 */
export function rememberReanchorVote(
  votes: ReanchorVotes,
  vote: PendingReanchorVote,
): Effect.Effect<void> {
  return Effect.sync(() => {
    const conversationId = vote.statement.reanchor.conversationId;
    const candidates =
      votes.get(conversationId) ??
      new Map<
        AnchorHashValue,
        Map<
          PendingReanchorVote["statement"]["signerAgentId"],
          PendingReanchorVote
        >
      >();
    votes.set(conversationId, candidates);
    const signers =
      candidates.get(vote.statement.anchorHash) ??
      new Map<
        PendingReanchorVote["statement"]["signerAgentId"],
        PendingReanchorVote
      >();
    candidates.set(vote.statement.anchorHash, signers);
    signers.set(vote.statement.signerAgentId, vote);
  });
}

/**
 * Whether the run already holds this signer's vote for this candidate anchor.
 * @param votes The run's vote memory.
 * @param vote Vote to look up.
 * @returns Whether the vote is held.
 */
export function reanchorVoteIsRemembered(
  votes: ReanchorVotes,
  vote: PendingReanchorVote,
): boolean {
  return (
    votes
      .get(vote.statement.reanchor.conversationId)
      ?.get(vote.statement.anchorHash)
      ?.has(vote.statement.signerAgentId) === true
  );
}

/**
 * Merge one vote into the store's re-anchor evidence for its candidate anchor.
 * One statement has more than one valid signature, so a member can send a
 * second, differently signed copy of a vote the store already holds. The
 * store refuses that copy, and it does not count.
 * @param runtime Engine whose store keeps the evidence.
 * @param vote Verified vote to persist.
 * @returns Whether the vote is durable; false when the store refused it.
 */
export function persistReanchorVote(
  runtime: EngineRuntime,
  vote: PendingReanchorVote,
): Effect.Effect<boolean, RouterWorkerPersistenceError> {
  return protocolEvidence(
    vote.statement.reanchor.conversationId,
    "reanchor",
    vote.statement.anchorHash,
    vote.message,
  ).pipe(
    Effect.flatMap((evidence) => runtime.input.store.mergeEvidence(evidence)),
    Effect.as(true),
    Effect.catchTag("EndpointStoreError", (error) =>
      isSemanticStoreRejection(error)
        ? Effect.succeed(false)
        : Effect.fail(persistenceFailure()),
    ),
    Effect.mapError(persistenceFailure),
  );
}

/**
 * Read and verify every stored vote for one candidate anchor.
 * @param runtime Engine whose store keeps the votes.
 * @param membership Verified membership the votes must verify under.
 * @param body Re-anchor body every stored vote must name.
 * @param anchorHash Candidate anchor the votes are for.
 * @returns The stored votes, one per signer.
 */
export function decodeReanchorVotes(
  runtime: EngineRuntime,
  membership: VerifiedMembership,
  body: ReanchorBodyValue,
  anchorHash: AnchorHashValue,
): Effect.Effect<readonly SignedMessageValue[], RouterWorkerPersistenceError> {
  return runtime.input.store.recover(body.conversationId).pipe(
    Effect.mapError(persistenceFailure),
    Effect.flatMap((recovery) =>
      Effect.forEach(
        recovery.evidence.filter((evidence) =>
          evidenceTargetsAnchor(evidence, body.conversationId, anchorHash),
        ),
        (evidence) =>
          verifyStoredReanchorVote(evidence, membership, body, anchorHash),
        { concurrency: 1 },
      ),
    ),
    Effect.flatMap((votes) =>
      votesHaveUniqueSigners(votes)
        ? Effect.succeed(votes)
        : Effect.fail(persistenceFailure()),
    ),
  );
}

/**
 * Assemble a completed re-anchor whose certificate holds `votes` in
 * decoded-AgentId order.
 * @param body Re-anchor body the votes name.
 * @param anchorHash Hash of `body`.
 * @param votes Stored votes for the anchor, at least one.
 * @returns The completed re-anchor.
 */
export function assembleCompletedReanchor(
  body: ReanchorBodyValue,
  anchorHash: AnchorHashValue,
  votes: readonly SignedMessageValue[],
): Effect.Effect<CompletedReanchorValue, RouterWorkerPersistenceError> {
  return orderedSignatures(votes).pipe(
    Effect.mapError(persistenceFailure),
    Effect.flatMap((ordered) => {
      if (ordered === undefined) {
        return Effect.fail(persistenceFailure());
      }
      const completed: CompletedReanchorValue = {
        sharnessVersion: body.sharnessVersion,
        kind: "completed_reanchor",
        anchorHash,
        reanchor: body,
        certificate: {
          sharnessVersion: body.sharnessVersion,
          kind: "reanchor_certificate",
          anchorHash,
          votes: ordered,
        },
      };
      return Effect.succeed(completed);
    }),
  );
}

/**
 * Make a completed re-anchor durable and the conversation's current anchor.
 * @param runtime Engine whose store and conversation receive the anchor.
 * @param completed Verified completed re-anchor.
 * @returns Completion once the anchor is durable and current.
 */
export function persistCompletedReanchor(
  runtime: EngineRuntime,
  completed: CompletedReanchorValue,
): Effect.Effect<void, RouterWorkerPersistenceError> {
  return storeAndAdoptReanchor(
    runtime,
    completed,
    runtime.input.store.completeReanchor,
  ).pipe(Effect.mapError(persistenceFailure));
}

/**
 * Make a member's verified completed re-anchor durable and the
 * conversation's current anchor. It supersedes a different candidate this
 * endpoint staged for the same anchor and Router instance: its quorum
 * certificate shows that candidate can never be certified, because two
 * certificates for one scope would need an honest member to vote twice. The
 * store refuses a completion that does not extend this endpoint's durable
 * position; that refusal comes from the member's input, not a failed store,
 * so the completion does not count.
 * @param runtime Engine whose store and conversation take the anchor.
 * @param completed Verified completed re-anchor from a member.
 * @returns Whether the anchor was applied; false when the store refused it.
 */
export function applyCompletedReanchor(
  runtime: EngineRuntime,
  completed: CompletedReanchorValue,
): Effect.Effect<boolean, RouterWorkerPersistenceError> {
  return storeAndAdoptReanchor(
    runtime,
    completed,
    runtime.input.store.applyCatchUpReanchor,
  ).pipe(
    Effect.as(true),
    Effect.catchTag("EndpointStoreError", (error) =>
      isSemanticStoreRejection(error)
        ? Effect.succeed(false)
        : Effect.fail(persistenceFailure()),
    ),
    Effect.withSpan("applyCompletedReanchor"),
  );
}

type WriteReanchor =
  | EndpointStore["completeReanchor"]
  | EndpointStore["applyCatchUpReanchor"];

/**
 * The durable row and its in-memory adoption form one interruption boundary,
 * so interruption cannot leave the store past an anchor the engine still holds.
 */
function storeAndAdoptReanchor(
  runtime: EngineRuntime,
  completed: CompletedReanchorValue,
  write: WriteReanchor,
) {
  const body = completed.reanchor;
  return Effect.all({
    canonicalBody: encodeCanonical(ReanchorBody, body),
    canonicalCompletedReanchor: encodeCanonical(CompletedReanchor, completed),
  }).pipe(
    Effect.mapError(persistenceFailure),
    Effect.flatMap((canonical) =>
      write({
        conversationId: body.conversationId,
        anchorHash: completed.anchorHash,
        previousAnchorHash: body.previousAnchorHash,
        routerInstanceId: body.routerInstanceId,
        selectedRecordHash: body.selectedRecordHash,
        ...canonical,
      }).pipe(
        Effect.zipRight(
          Effect.sync(() => {
            adoptCompletedReanchor(runtime, completed);
          }),
        ),
        Effect.uninterruptible,
      ),
    ),
  );
}

/**
 * Make a durable completed re-anchor the conversation's current anchor in
 * memory, and drop the fold of the proposal it supersedes at the selected
 * head, staged or not. That proposal binds the previous anchor, so it is no
 * longer gap-free and can never certify; the store has retired its lock,
 * signatures and staged record, and resuming its fold would only resend dead
 * evidence.
 * @param runtime Engine whose conversation and folds change.
 * @param completed Completed re-anchor the store has made current.
 */
function adoptCompletedReanchor(
  runtime: EngineRuntime,
  completed: CompletedReanchorValue,
): void {
  const body = completed.reanchor;
  const conversation = runtime.conversations.get(body.conversationId);
  if (conversation !== undefined) {
    conversation.currentAnchor = completed;
  }
  for (const [actionHash, fold] of runtime.actionFolds) {
    if (isSupersededProposal(fold, completed)) {
      runtime.actionFolds.delete(actionHash);
      if (fold.recordHash !== undefined) {
        runtime.recordFolds.delete(fold.recordHash);
      }
    }
  }
}

function isSupersededProposal(
  fold: EngineActionFold,
  completed: CompletedReanchorValue,
): boolean {
  const body = completed.reanchor;
  if (
    fold.conversation.conversationId !== body.conversationId ||
    fold.action.kind !== "MESSAGE"
  ) {
    return false;
  }
  return (
    fold.action.previousRecordHash === body.selectedRecordHash &&
    fold.action.anchorHash !== completed.anchorHash
  );
}

function evidenceTargetsAnchor(
  evidence: EndpointRecovery["evidence"][number],
  conversationId: ConversationIdValue,
  anchorHash: AnchorHashValue,
): boolean {
  return (
    evidence.kind === "reanchor" &&
    evidence.conversationId === conversationId &&
    evidence.subjectId === anchorHash
  );
}

function verifyStoredReanchorVote(
  evidence: EndpointRecovery["evidence"][number],
  membership: VerifiedMembership,
  body: ReanchorBodyValue,
  anchorHash: AnchorHashValue,
): Effect.Effect<SignedMessageValue, RouterWorkerPersistenceError> {
  return decodeCanonical(SignedMessage, evidence.canonicalEvidence).pipe(
    Effect.flatMap((message) => Schema.encode(SignedMessage)(message)),
    Effect.flatMap((representation) =>
      verifyStableEvidence({ representation, membership }),
    ),
    Effect.flatMap((verified) =>
      storedVoteMatches(verified.statement, body, anchorHash)
        ? Effect.succeed(verified.message)
        : Effect.fail(persistenceFailure()),
    ),
    Effect.mapError(persistenceFailure),
  );
}

function storedVoteMatches(
  statement: EvidenceStatementValue,
  body: ReanchorBodyValue,
  anchorHash: AnchorHashValue,
): boolean {
  return (
    statement.kind === "reanchor_vote" &&
    statement.anchorHash === anchorHash &&
    sameReanchorBody(statement.reanchor, body)
  );
}

function votesHaveUniqueSigners(votes: readonly SignedMessageValue[]): boolean {
  return (
    new Set<PendingReanchorVote["statement"]["signerAgentId"]>(
      votes.map((vote) => vote.senderAgentId),
    ).size === votes.length
  );
}

function sameReanchorBody(
  left: ReanchorBodyValue,
  right: ReanchorBodyValue,
): boolean {
  return [
    left.conversationId === right.conversationId,
    left.membershipHash === right.membershipHash,
    left.previousAnchorHash === right.previousAnchorHash,
    left.selectedRecordHash === right.selectedRecordHash,
    left.routerInstanceId === right.routerInstanceId,
  ].every((matches) => matches);
}

function persistenceFailure(): RouterWorkerPersistenceError {
  return new RouterWorkerPersistenceError();
}
