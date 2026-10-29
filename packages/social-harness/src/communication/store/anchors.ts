/** @file Atomic identity, post-intent, foundation, and Router-anchor transitions. */

import type { DatabaseSync } from "node:sqlite";
import type {
  CompletedReanchor,
  ConversationFoundation,
  EmptyConversationRestart,
  FirewallAttempt,
  FirewallCommit,
  FirewallCompletion,
  IdentityBinding,
  PostIntent,
  PostIntentBinding,
  ProposalLock,
  RestartedEmptyConversation,
  StagedReanchor,
  StoreMutation,
} from "./types.js";
import { bindCollectivePostInTransaction } from "./collective-claims.js";
import {
  copyBytes,
  readBytes,
  readOptionalText,
  readText,
  requireBytes,
  requireEqual,
  requireSameBytes,
  requireText,
  StoreSignal,
  transaction,
} from "./database/index.js";
import { admittedOperation, compareFirewallCheck } from "./firewall.js";
import {
  findProposalLock,
  findStagedReanchor,
  lockProposalInTransaction,
  readStoredIdentity,
  readStoredPosition,
  releaseProposalLock,
  requireSameReanchor,
} from "./rows/index.js";

/** Singleton identity binding operations. */
export const bindIdentity = Object.freeze({
  read: readStoredIdentity,
  write: writeIdentity,
});

/**
 * Durably binds one author-scoped post to its immutable canonical intent.
 *
 * @param database Exclusively owned endpoint database.
 * @param binding Canonical post recovery identity and optional new foundation.
 * @returns Whether the same binding was inserted or already durable.
 */
export function bindPostIntent(
  database: DatabaseSync,
  binding: PostIntentBinding,
): StoreMutation {
  validatePostIntentBinding(binding);
  return transaction(database, () =>
    bindIntentWithFoundation(database, binding),
  );
}

/** An assessment cannot authorize different bytes or survive a changed evidence range. */
export function bindCheckedPostIntent(
  database: DatabaseSync,
  binding: PostIntentBinding,
  completion: FirewallCompletion,
): FirewallCommit {
  validatePostIntentBinding(binding);
  return transaction(database, () => {
    const disposition = compareFirewallCheck(
      database,
      completion,
      "outgoing",
      binding.intent.canonicalIntent,
    );
    if (disposition === "admitted") {
      bindIntentWithFoundation(database, binding);
    }
    return disposition;
  });
}

/**
 * A gather request post binds only against the admitted check of its
 * operation, whose candidate is exactly the post's request content; without
 * one it is withheld and nothing binds.
 * @param database Exclusively owned endpoint database.
 * @param binding Canonical post recovery identity and optional new foundation.
 * @param operation The operation's admitted check.
 * @param operation.checkId The check that admitted the operation.
 * @param operation.canonicalCandidate The canonical request content it admitted.
 * @returns Whether the intent was bound.
 */
export function bindAdmittedPostIntent(
  database: DatabaseSync,
  binding: PostIntentBinding,
  operation: Pick<FirewallAttempt, "checkId" | "canonicalCandidate">,
): FirewallCommit {
  validatePostIntentBinding(binding);
  requireText(operation.checkId);
  requireBytes(operation.canonicalCandidate);
  return transaction(database, () => {
    if (!admittedOperation(database, operation)) {
      return "withheld";
    }
    bindIntentWithFoundation(database, binding);
    return "admitted";
  });
}

/**
 * Atomically persists the immutable membership and initial Router anchor.
 *
 * @param database Exclusively owned endpoint database.
 * @param foundation Verified immutable conversation foundation.
 * @returns Whether the same foundation was inserted or already durable.
 */
export function putConversationFoundation(
  database: DatabaseSync,
  foundation: ConversationFoundation,
): StoreMutation {
  return transaction(database, () =>
    putConversationFoundationInTransaction(database, foundation),
  );
}

/**
 * Commits the first valid Router-ordered action for one predecessor.
 *
 * A caller signs only after this operation succeeds, so an endpoint cannot
 * sign two actions for the same predecessor across crashes or restarts.
 *
 * @param database Exclusively owned endpoint database.
 * @param proposal Verified action core selected in Router order.
 * @returns Whether the lock was inserted or the same lock already existed.
 */
export function lockProposal(
  database: DatabaseSync,
  proposal: ProposalLock,
): StoreMutation {
  validateProposalLock(proposal);
  return transaction(database, () =>
    lockProposalInTransaction(database, proposal),
  );
}

/**
 * Atomically retains a verified FIRST_MESSAGE foundation and its first-candidate lock.
 *
 * @param database Exclusively owned endpoint database.
 * @param foundation Verified immutable membership and Router anchor.
 * @param proposal Verified gap-free FIRST_MESSAGE action selected in Router order.
 * @returns Whether either exact durable component was inserted.
 */
export function lockFirstMessageProposal(
  database: DatabaseSync,
  foundation: ConversationFoundation,
  proposal: ProposalLock,
): StoreMutation {
  validateProposalLock(proposal);
  if (
    proposal.previousRecordHash !== undefined ||
    proposal.conversationId !== foundation.conversationId
  ) {
    throw new StoreSignal("invalid-input");
  }
  return transaction(database, () => {
    const retainedFoundation = putConversationFoundationInTransaction(
      database,
      foundation,
    );
    const retainedProposal = lockProposalInTransaction(database, proposal);
    return retainedFoundation === "inserted" || retainedProposal === "inserted"
      ? "inserted"
      : "existing";
  });
}

/**
 * Replaces an uncommitted conversation's Router-instance foundation.
 *
 * The exact old foundation and empty certified head prevent this cleanup from
 * erasing committed history or a concurrently advanced anchor.
 *
 * @param database Exclusively owned endpoint database.
 * @param restart Expected old and verified replacement initial foundations.
 * @returns The replacement foundation and immutable retained post intents.
 */
export function restartEmptyConversation(
  database: DatabaseSync,
  restart: EmptyConversationRestart,
): RestartedEmptyConversation {
  validateEmptyConversationRestart(restart);
  return transaction(database, () => {
    requireEmptyConversationPosition(database, restart.expectedFoundation);
    clearIncompleteConversationState(database, restart.expectedFoundation);
    installReplacementFoundation(database, restart.replacementFoundation);
    return Object.freeze({
      foundation: copyFoundation(restart.replacementFoundation),
      postIntents: readConversationPostIntents(
        database,
        restart.replacementFoundation.conversationId,
      ),
    });
  });
}

/**
 * Durably stages at most one re-anchor proposal for one Router-instance scope,
 * for this endpoint's vote. It refuses a proposal away from a head this
 * endpoint holds a staged successor of under the same anchor, since it has
 * voted that successor durable.
 *
 * @param database Exclusively owned endpoint database.
 * @param reanchor Verified proposal body and stable hash.
 * @returns Whether the same proposal was inserted or already durable.
 */
export function stageReanchor(
  database: DatabaseSync,
  reanchor: StagedReanchor,
): StoreMutation {
  validateStagedReanchor(reanchor);
  return transaction(database, () =>
    stageReanchorInTransaction(database, reanchor, "vote"),
  );
}

/**
 * Atomically makes a staged threshold-complete Router anchor current.
 *
 * @param database Exclusively owned endpoint database.
 * @param reanchor Verified completed re-anchor and threshold evidence.
 * @returns Whether completion advanced the current anchor or was idempotent.
 */
export function completeReanchor(
  database: DatabaseSync,
  reanchor: CompletedReanchor,
): StoreMutation {
  validateCompletedReanchor(reanchor);
  return transaction(database, () =>
    completeReanchorInTransaction(database, reanchor),
  );
}

/**
 * Atomically stages and completes one member's verified completed re-anchor.
 *
 * The completion replaces a different candidate this endpoint staged for the
 * same previous anchor and Router instance. The one-candidate rule limits
 * what this endpoint signs, not which quorum-certified anchor it accepts:
 * two certificates in one scope would need an honest member to vote twice,
 * so the replaced candidate can never be certified.
 *
 * @param database Exclusively owned endpoint database.
 * @param reanchor One verified completed re-anchor from a member.
 * @returns Whether any durable state was added.
 */
export function applyCatchUpReanchor(
  database: DatabaseSync,
  reanchor: CompletedReanchor,
): StoreMutation {
  validateCompletedReanchor(reanchor);
  return transaction(database, () => {
    retireSupersededCandidates(database, reanchor);
    const staged = stageReanchorInTransaction(database, reanchor, "adopted");
    const completed = completeReanchorInTransaction(database, reanchor);
    return staged === "inserted" || completed === "inserted"
      ? "inserted"
      : "existing";
  });
}

function validatePostIntentBinding(binding: PostIntentBinding): void {
  const intent = binding.intent;
  requireText(intent.conversationId);
  requireText(intent.membershipHash);
  requireText(intent.authorAgentId);
  requireText(intent.postId);
  requireBytes(intent.canonicalIntent);
  if (intent.completedRecordHash !== undefined) {
    throw new StoreSignal("invalid-input");
  }
  if (binding.kind === "new-conversation") {
    validateFoundation(binding.foundation);
    requireEqual(binding.foundation.conversationId, intent.conversationId);
    requireEqual(binding.foundation.membershipHash, intent.membershipHash);
  }
}

function bindIntentWithFoundation(
  database: DatabaseSync,
  binding: PostIntentBinding,
): StoreMutation {
  const intent = binding.intent;
  const foundation =
    binding.kind === "new-conversation"
      ? putConversationFoundationInTransaction(database, binding.foundation)
      : requireConversationFoundation(database, intent);
  const postIntent = bindPostIntentInTransaction(database, intent);
  if (binding.collective !== undefined) {
    bindCollectivePostInTransaction(database, binding.collective, intent);
  }
  return foundation === "inserted" || postIntent === "inserted"
    ? "inserted"
    : "existing";
}

function validateProposalLock(proposal: ProposalLock): void {
  requireText(proposal.conversationId);
  if (proposal.previousRecordHash !== undefined) {
    requireText(proposal.previousRecordHash);
  }
  requireText(proposal.actionHash);
  requireBytes(proposal.canonicalActionCore);
}

function writeIdentity(
  database: DatabaseSync,
  binding: IdentityBinding,
): StoreMutation {
  requireText(binding.agentId);
  requireBytes(binding.canonicalAgentCard);
  return transaction(database, () => {
    const existing = readStoredIdentity(database);
    if (existing !== undefined) {
      requireEqual(existing.agentId, binding.agentId);
      requireSameBytes(existing.canonicalAgentCard, binding.canonicalAgentCard);
      return "existing";
    }
    database
      .prepare(
        `INSERT INTO identity_binding
          (singleton, agent_id, canonical_agent_card) VALUES (1, ?, ?)`,
      )
      .run(binding.agentId, copyBytes(binding.canonicalAgentCard));
    return "inserted";
  });
}

function bindPostIntentInTransaction(
  database: DatabaseSync,
  intent: PostIntent,
): StoreMutation {
  const identity = readStoredIdentity(database);
  if (identity === undefined) {
    throw new StoreSignal("not-found");
  }
  requireEqual(identity.agentId, intent.authorAgentId);
  const existing = database
    .prepare(
      `SELECT conversation_id, membership_hash, canonical_intent
       FROM post_intents WHERE author_agent_id = ? AND post_id = ?`,
    )
    .get(intent.authorAgentId, intent.postId);
  if (existing !== undefined) {
    requireEqual(readText(existing, "conversation_id"), intent.conversationId);
    requireEqual(readText(existing, "membership_hash"), intent.membershipHash);
    requireSameBytes(
      readBytes(existing, "canonical_intent"),
      intent.canonicalIntent,
    );
    return "existing";
  }
  database
    .prepare(
      `INSERT INTO post_intents
        (author_agent_id, post_id, conversation_id, membership_hash,
         canonical_intent)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      intent.authorAgentId,
      intent.postId,
      intent.conversationId,
      intent.membershipHash,
      copyBytes(intent.canonicalIntent),
    );
  return "inserted";
}

/**
 * Inserts or validates one complete membership and initial anchor in an
 * existing transaction.
 *
 * @param database Exclusively owned endpoint database.
 * @param foundation Verified immutable conversation foundation.
 * @returns Whether this transaction inserted the foundation.
 */
function putConversationFoundationInTransaction(
  database: DatabaseSync,
  foundation: ConversationFoundation,
): StoreMutation {
  validateFoundation(foundation);
  const existing = readFoundation(database, foundation.conversationId);
  if (existing !== undefined) {
    requireSameFoundation(existing, foundation);
    return "existing";
  }
  insertFoundation(database, foundation);
  return "inserted";
}

function requireConversationFoundation(
  database: DatabaseSync,
  intent: PostIntent,
): StoreMutation {
  const foundation = readFoundation(database, intent.conversationId);
  if (foundation === undefined) {
    throw new StoreSignal("not-found");
  }
  requireEqual(foundation.membershipHash, intent.membershipHash);
  return "existing";
}

function requireEmptyConversationPosition(
  database: DatabaseSync,
  expected: ConversationFoundation,
): void {
  const retained = readFoundation(database, expected.conversationId);
  if (retained === undefined) {
    throw new StoreSignal("not-found");
  }
  requireSameFoundation(retained, expected);
  const position = readStoredPosition(database, expected.conversationId);
  requireEqual(position.membershipHash, expected.membershipHash);
  requireEqual(position.currentAnchorHash, expected.anchorHash);
  requireEqual(position.headRecordHash, undefined);
  requireEqual(position.headOrdinal, -1);
  if (
    database
      .prepare(
        `SELECT 1 AS retained FROM certified_records
         WHERE conversation_id = ? LIMIT 1`,
      )
      .get(expected.conversationId) !== undefined
  ) {
    throw new StoreSignal("conflict");
  }
}

function readFoundation(
  database: DatabaseSync,
  conversationId: string,
): ConversationFoundation | undefined {
  const row = database
    .prepare(
      `SELECT membership.membership_hash, membership.canonical_membership,
              anchor.anchor_hash, anchor.canonical_anchor
       FROM memberships AS membership
       JOIN anchors AS anchor
         ON anchor.conversation_id = membership.conversation_id
        AND anchor.previous_anchor_hash IS NULL
       WHERE membership.conversation_id = ?`,
    )
    .get(conversationId);
  return row === undefined
    ? undefined
    : Object.freeze({
        conversationId,
        membershipHash: readText(row, "membership_hash"),
        canonicalMembership: readBytes(row, "canonical_membership"),
        anchorHash: readText(row, "anchor_hash"),
        canonicalAnchor: readBytes(row, "canonical_anchor"),
      });
}

function insertFoundation(
  database: DatabaseSync,
  foundation: ConversationFoundation,
): void {
  database
    .prepare(
      `INSERT INTO memberships
        (conversation_id, membership_hash, canonical_membership)
       VALUES (?, ?, ?)`,
    )
    .run(
      foundation.conversationId,
      foundation.membershipHash,
      copyBytes(foundation.canonicalMembership),
    );
  database
    .prepare(
      `INSERT INTO anchors
        (conversation_id, anchor_hash, canonical_anchor) VALUES (?, ?, ?)`,
    )
    .run(
      foundation.conversationId,
      foundation.anchorHash,
      copyBytes(foundation.canonicalAnchor),
    );
  database
    .prepare(
      `INSERT INTO conversation_state
        (conversation_id, membership_hash, current_anchor_hash, head_ordinal)
       VALUES (?, ?, ?, -1)`,
    )
    .run(
      foundation.conversationId,
      foundation.membershipHash,
      foundation.anchorHash,
    );
}

/**
 * Stage a re-anchor proposal. A proposal staged for this endpoint's vote
 * must not leave a head it holds a staged successor of; one adopted complete
 * from members carries no vote of this endpoint's, so it may.
 * @param database Exclusively owned endpoint database.
 * @param reanchor Verified proposal body and stable hash.
 * @param purpose Whether this endpoint votes for it or adopts it complete.
 * @returns Whether the proposal was inserted or already durable.
 */
function stageReanchorInTransaction(
  database: DatabaseSync,
  reanchor: StagedReanchor,
  purpose: "vote" | "adopted",
): StoreMutation {
  const existing = findStagedReanchor(
    database,
    reanchor.conversationId,
    reanchor.anchorHash,
  );
  if (existing !== undefined) {
    requireSameReanchor(existing, reanchor);
    return "existing";
  }
  requireUnclaimedReanchorScope(database, reanchor);
  requireReanchorPosition(database, reanchor);
  if (purpose === "vote") {
    requireNoStagedSuccessor(database, reanchor);
  }
  insertStagedReanchor(database, reanchor);
  return "inserted";
}

function completeReanchorInTransaction(
  database: DatabaseSync,
  reanchor: CompletedReanchor,
): StoreMutation {
  const staged = findStagedReanchor(
    database,
    reanchor.conversationId,
    reanchor.anchorHash,
  );
  if (staged === undefined) {
    throw new StoreSignal("not-found");
  }
  requireSameReanchor(staged, reanchor);
  if (hasAnchor(database, reanchor.conversationId, reanchor.anchorHash)) {
    return "existing";
  }
  requireReanchorPosition(database, reanchor);
  insertCompletedReanchor(database, reanchor);
  releaseSupersededProposal(database, reanchor);
  return "inserted";
}

/**
 * Retires the proposal locked at the head a completed re-anchor selects, with
 * everything held for it.
 *
 * An action binds its anchor, so once the new anchor is current no action
 * under the previous one is gap-free, and the old proposal can never be
 * signed, staged or certified here again. Its lock, kept, would refuse every
 * candidate at that head under the new anchor and stall the conversation.
 *
 * The staged record can be retired because the re-anchor's quorum
 * certificate shows it can never be certified anywhere: a member holding a
 * staged successor does not vote to re-anchor behind it, so the q(n) members
 * that selected this head leave at most 2f members that can attest the
 * successor's durability, fewer than q(n).
 *
 * @param database Exclusively owned endpoint database.
 * @param reanchor Completed re-anchor that just became current.
 */
function releaseSupersededProposal(
  database: DatabaseSync,
  reanchor: CompletedReanchor,
): void {
  const lock = findProposalLock(
    database,
    reanchor.conversationId,
    reanchor.selectedRecordHash,
  );
  if (lock !== undefined) {
    releaseProposalLock(database, lock);
  }
}

/**
 * Delete this endpoint's uncompleted candidates in a completed re-anchor's
 * scope that the completion does not select, with their re-anchor votes.
 * @param database Exclusively owned endpoint database.
 * @param reanchor Verified completed re-anchor that supersedes them.
 */
function retireSupersededCandidates(
  database: DatabaseSync,
  reanchor: CompletedReanchor,
): void {
  const scope = [
    reanchor.conversationId,
    reanchor.previousAnchorHash,
    reanchor.routerInstanceId,
    reanchor.anchorHash,
  ] as const;
  const superseded = database
    .prepare(
      `SELECT anchor_hash FROM reanchors
       WHERE conversation_id = ? AND previous_anchor_hash = ?
         AND router_instance_id = ? AND anchor_hash <> ?
         AND canonical_completed_reanchor IS NULL`,
    )
    .all(...scope)
    .map((row) => readText(row, "anchor_hash"));
  for (const anchorHash of superseded) {
    database
      .prepare(
        `DELETE FROM protocol_evidence
         WHERE conversation_id = ? AND evidence_kind = 'reanchor'
           AND subject_id = ?`,
      )
      .run(reanchor.conversationId, anchorHash);
  }
  database
    .prepare(
      `DELETE FROM reanchors
       WHERE conversation_id = ? AND previous_anchor_hash = ?
         AND router_instance_id = ? AND anchor_hash <> ?
         AND canonical_completed_reanchor IS NULL`,
    )
    .run(...scope);
}

function requireUnclaimedReanchorScope(
  database: DatabaseSync,
  reanchor: StagedReanchor,
): void {
  const scoped = database
    .prepare(
      `SELECT anchor_hash FROM reanchors
       WHERE conversation_id = ? AND previous_anchor_hash = ?
         AND router_instance_id = ?`,
    )
    .get(
      reanchor.conversationId,
      reanchor.previousAnchorHash,
      reanchor.routerInstanceId,
    );
  if (scoped !== undefined) {
    throw new StoreSignal("conflict");
  }
}

/**
 * Refuse a re-anchor away from a head this endpoint holds a staged successor
 * of under the same anchor. It voted that successor durable, so a re-anchor
 * away from the head and a durability certificate extending it never both
 * collect this endpoint's signature.
 * @param database Exclusively owned endpoint database.
 * @param reanchor Proposal about to be staged.
 */
function requireNoStagedSuccessor(
  database: DatabaseSync,
  reanchor: StagedReanchor,
): void {
  const successor = database
    .prepare(
      `SELECT 1 AS staged FROM staged_records
       WHERE conversation_id = ? AND anchor_hash = ?
         AND previous_record_hash = ? LIMIT 1`,
    )
    .get(
      reanchor.conversationId,
      reanchor.previousAnchorHash,
      reanchor.selectedRecordHash,
    );
  if (successor !== undefined) {
    throw new StoreSignal("conflict");
  }
}

function requireReanchorPosition(
  database: DatabaseSync,
  reanchor: StagedReanchor,
): void {
  const position = readStoredPosition(database, reanchor.conversationId);
  requireEqual(position.currentAnchorHash, reanchor.previousAnchorHash);
  requireEqual(position.headRecordHash, reanchor.selectedRecordHash);
}

function insertStagedReanchor(
  database: DatabaseSync,
  reanchor: StagedReanchor,
): void {
  database
    .prepare(
      `INSERT INTO reanchors
        (conversation_id, anchor_hash, previous_anchor_hash,
         router_instance_id, selected_record_hash, canonical_body)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      reanchor.conversationId,
      reanchor.anchorHash,
      reanchor.previousAnchorHash,
      reanchor.routerInstanceId,
      reanchor.selectedRecordHash,
      copyBytes(reanchor.canonicalBody),
    );
}

function insertCompletedReanchor(
  database: DatabaseSync,
  reanchor: CompletedReanchor,
): void {
  database
    .prepare(
      `INSERT INTO anchors
        (conversation_id, anchor_hash, previous_anchor_hash,
         selected_record_hash, canonical_anchor)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      reanchor.conversationId,
      reanchor.anchorHash,
      reanchor.previousAnchorHash,
      reanchor.selectedRecordHash,
      copyBytes(reanchor.canonicalCompletedReanchor),
    );
  database
    .prepare(
      `UPDATE reanchors SET canonical_completed_reanchor = ?
       WHERE conversation_id = ? AND anchor_hash = ?`,
    )
    .run(
      copyBytes(reanchor.canonicalCompletedReanchor),
      reanchor.conversationId,
      reanchor.anchorHash,
    );
  database
    .prepare(
      `UPDATE conversation_state SET current_anchor_hash = ?
       WHERE conversation_id = ?`,
    )
    .run(reanchor.anchorHash, reanchor.conversationId);
}

function hasAnchor(
  database: DatabaseSync,
  conversationId: string,
  anchorHash: string,
): boolean {
  return (
    database
      .prepare(
        `SELECT 1 AS retained FROM anchors
         WHERE conversation_id = ? AND anchor_hash = ?`,
      )
      .get(conversationId, anchorHash) !== undefined
  );
}

function validateEmptyConversationRestart(
  restart: EmptyConversationRestart,
): void {
  validateFoundation(restart.expectedFoundation);
  validateFoundation(restart.replacementFoundation);
  requireEqual(
    restart.expectedFoundation.conversationId,
    restart.replacementFoundation.conversationId,
  );
  requireEqual(
    restart.expectedFoundation.membershipHash,
    restart.replacementFoundation.membershipHash,
  );
  requireSameBytes(
    restart.expectedFoundation.canonicalMembership,
    restart.replacementFoundation.canonicalMembership,
  );
  if (
    restart.expectedFoundation.anchorHash ===
    restart.replacementFoundation.anchorHash
  ) {
    throw new StoreSignal("invalid-input");
  }
}

function validateFoundation(foundation: ConversationFoundation): void {
  requireText(foundation.conversationId);
  requireText(foundation.membershipHash);
  requireBytes(foundation.canonicalMembership);
  requireText(foundation.anchorHash);
  requireBytes(foundation.canonicalAnchor);
}

function clearIncompleteConversationState(
  database: DatabaseSync,
  expected: ConversationFoundation,
): void {
  const conversationId = expected.conversationId;
  database
    .prepare("DELETE FROM dissemination_obligations WHERE conversation_id = ?")
    .run(conversationId);
  database
    .prepare("DELETE FROM protocol_evidence WHERE conversation_id = ?")
    .run(conversationId);
  database
    .prepare("DELETE FROM proposal_locks WHERE conversation_id = ?")
    .run(conversationId);
  database
    .prepare("DELETE FROM staged_records WHERE conversation_id = ?")
    .run(conversationId);
  database
    .prepare("DELETE FROM reanchors WHERE conversation_id = ?")
    .run(conversationId);
  database
    .prepare(
      `UPDATE outbound_messages SET disposition = 'discarded'
       WHERE conversation_id = ? AND disposition = 'pending'`,
    )
    .run(conversationId);
}

function installReplacementFoundation(
  database: DatabaseSync,
  replacement: ConversationFoundation,
): void {
  const retainedReplacement = database
    .prepare(
      `SELECT 1 AS retained FROM anchors
       WHERE conversation_id = ? AND anchor_hash = ?`,
    )
    .get(replacement.conversationId, replacement.anchorHash);
  if (retainedReplacement !== undefined) {
    throw new StoreSignal("conflict");
  }
  database
    .prepare(
      `INSERT INTO anchors
        (conversation_id, anchor_hash, canonical_anchor) VALUES (?, ?, ?)`,
    )
    .run(
      replacement.conversationId,
      replacement.anchorHash,
      copyBytes(replacement.canonicalAnchor),
    );
  database
    .prepare(
      `UPDATE conversation_state
       SET current_anchor_hash = ?, head_record_hash = NULL, head_ordinal = -1
       WHERE conversation_id = ?`,
    )
    .run(replacement.anchorHash, replacement.conversationId);
  database
    .prepare(
      `DELETE FROM anchors
       WHERE conversation_id = ? AND anchor_hash <> ?`,
    )
    .run(replacement.conversationId, replacement.anchorHash);
}

function readConversationPostIntents(
  database: DatabaseSync,
  conversationId: string,
): readonly PostIntent[] {
  return Object.freeze(
    database
      .prepare(
        `SELECT conversation_id, membership_hash, author_agent_id, post_id,
                canonical_intent, completed_record_hash
         FROM post_intents WHERE conversation_id = ?
         ORDER BY author_agent_id, post_id`,
      )
      .all(conversationId)
      .map((row) => {
        const completedRecordHash = readOptionalText(
          row,
          "completed_record_hash",
        );
        return Object.freeze({
          conversationId: readText(row, "conversation_id"),
          membershipHash: readText(row, "membership_hash"),
          authorAgentId: readText(row, "author_agent_id"),
          postId: readText(row, "post_id"),
          canonicalIntent: readBytes(row, "canonical_intent"),
          ...(completedRecordHash === undefined ? {} : { completedRecordHash }),
        });
      }),
  );
}

function copyFoundation(
  foundation: ConversationFoundation,
): ConversationFoundation {
  return Object.freeze({
    ...foundation,
    canonicalMembership: copyBytes(foundation.canonicalMembership),
    canonicalAnchor: copyBytes(foundation.canonicalAnchor),
  });
}

function validateCompletedReanchor(reanchor: CompletedReanchor): void {
  validateStagedReanchor(reanchor);
  requireBytes(reanchor.canonicalCompletedReanchor);
}

function validateStagedReanchor(reanchor: StagedReanchor): void {
  requireText(reanchor.conversationId);
  requireText(reanchor.anchorHash);
  requireText(reanchor.previousAnchorHash);
  requireText(reanchor.routerInstanceId);
  requireText(reanchor.selectedRecordHash);
  requireBytes(reanchor.canonicalBody);
}

function requireSameFoundation(
  left: ConversationFoundation,
  right: ConversationFoundation,
): void {
  requireEqual(left.conversationId, right.conversationId);
  requireEqual(left.membershipHash, right.membershipHash);
  requireSameBytes(left.canonicalMembership, right.canonicalMembership);
  requireEqual(left.anchorHash, right.anchorHash);
  requireSameBytes(left.canonicalAnchor, right.canonicalAnchor);
}
