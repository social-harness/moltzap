/** @file Durable candidate locks and the conversation positions they protect. */

import type { DatabaseSync } from "node:sqlite";
import type {
  ConversationPosition,
  ProposalLock,
  StoreMutation,
} from "../types.js";
import {
  copyBytes,
  readBytes,
  readInteger,
  readOptionalText,
  readText,
  requireEqual,
  requireSameBytes,
  StoreSignal,
} from "../database/index.js";

/** The predecessor key of a conversation's first record. */
export const FIRST_MESSAGE_PREDECESSOR = "";

/**
 * Inserts one first-candidate lock inside a caller-owned transaction, or
 * confirms the same lock is already durable.
 * @param database Exclusively owned endpoint database.
 * @param proposal Verified gap-free action selected at its predecessor.
 * @returns Whether the lock was inserted or already durable.
 */
export function lockProposalInTransaction(
  database: DatabaseSync,
  proposal: ProposalLock,
): StoreMutation {
  const predecessorKey =
    proposal.previousRecordHash ?? FIRST_MESSAGE_PREDECESSOR;
  const existing = findProposalLock(
    database,
    proposal.conversationId,
    predecessorKey,
  );
  if (existing !== undefined) {
    requireSameProposalLock(existing, proposal);
    return "existing";
  }
  const position = readStoredPosition(database, proposal.conversationId);
  requireEqual(position.headRecordHash, proposal.previousRecordHash);
  database
    .prepare(
      `INSERT INTO proposal_locks
        (conversation_id, predecessor_key, previous_record_hash,
         action_hash, canonical_action_core)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      proposal.conversationId,
      predecessorKey,
      proposal.previousRecordHash ?? null,
      proposal.actionHash,
      copyBytes(proposal.canonicalActionCore),
    );
  return "inserted";
}

/**
 * Deletes one proposal lock inside a caller-owned transaction, with the
 * action signatures held for its action and every record staged for that
 * action, including the record's durability votes and dissemination
 * obligation. The caller shows the action can never be certified; kept
 * without the lock, any of these rows would name an action no durable lock
 * selects, which startup refuses.
 * @param database Exclusively owned endpoint database.
 * @param lock The durable lock to release.
 */
export function releaseProposalLock(
  database: DatabaseSync,
  lock: ProposalLock,
): void {
  const staged = `SELECT record_hash FROM staged_records
    WHERE conversation_id = ?1 AND action_hash = ?2`;
  for (const statement of [
    `DELETE FROM dissemination_obligations
     WHERE conversation_id = ?1 AND record_hash IN (${staged})`,
    `DELETE FROM protocol_evidence
     WHERE conversation_id = ?1 AND evidence_kind = 'durability'
       AND subject_id IN (${staged})`,
    `DELETE FROM staged_records
     WHERE conversation_id = ?1 AND action_hash = ?2`,
    `DELETE FROM protocol_evidence
     WHERE conversation_id = ?1 AND evidence_kind = 'action'
       AND subject_id = ?2`,
    `DELETE FROM proposal_locks
     WHERE conversation_id = ?1 AND action_hash = ?2`,
  ]) {
    database.prepare(statement).run(lock.conversationId, lock.actionHash);
  }
}

/**
 * Reads an optional proposal lock for one predecessor.
 *
 * @param database Exclusively owned endpoint database.
 * @param conversationId Opaque conversation identity.
 * @param predecessorKey Exact predecessor or the first message sentinel.
 * @returns The detached proposal lock when present.
 */
export function findProposalLock(
  database: DatabaseSync,
  conversationId: string,
  predecessorKey: string,
): ProposalLock | undefined {
  const row = database
    .prepare(
      `SELECT conversation_id, previous_record_hash, action_hash,
              canonical_action_core
       FROM proposal_locks
       WHERE conversation_id = ? AND predecessor_key = ?`,
    )
    .get(conversationId, predecessorKey);
  return row === undefined ? undefined : readProposalLock(row);
}

/**
 * Projects one durable proposal lock.
 *
 * @param row SQLite result row.
 * @returns The detached proposal lock.
 */
export function readProposalLock(
  row: Readonly<Record<string, unknown>>,
): ProposalLock {
  const previousRecordHash = readOptionalText(row, "previous_record_hash");
  return Object.freeze({
    conversationId: readText(row, "conversation_id"),
    ...(previousRecordHash === undefined ? {} : { previousRecordHash }),
    actionHash: readText(row, "action_hash"),
    canonicalActionCore: readBytes(row, "canonical_action_core"),
  });
}

/** Durable position plus the local indexing aid that carries no authority. */
export interface InternalPosition extends ConversationPosition {
  readonly headOrdinal: number;
}

/**
 * Reads a required conversation position.
 *
 * @param database Exclusively owned endpoint database.
 * @param conversationId Opaque conversation identity.
 * @returns Its durable anchor, head, and local ordinal.
 */
export function readStoredPosition(
  database: DatabaseSync,
  conversationId: string,
): InternalPosition {
  const row = database
    .prepare(
      `SELECT conversation_id, membership_hash, current_anchor_hash,
              head_record_hash, head_ordinal
       FROM conversation_state WHERE conversation_id = ?`,
    )
    .get(conversationId);
  if (row === undefined) {
    throw new StoreSignal("not-found");
  }
  return Object.freeze({
    ...readConversationPosition(row),
    headOrdinal: readInteger(row, "head_ordinal"),
  });
}

/**
 * Projects one durable position row without its local ordinal.
 *
 * @param row SQLite result row.
 * @returns The detached conversation position.
 */
export function readConversationPosition(
  row: Readonly<Record<string, unknown>>,
): ConversationPosition {
  const headRecordHash = readOptionalText(row, "head_record_hash");
  return Object.freeze({
    conversationId: readText(row, "conversation_id"),
    membershipHash: readText(row, "membership_hash"),
    currentAnchorHash: readText(row, "current_anchor_hash"),
    ...(headRecordHash === undefined ? {} : { headRecordHash }),
  });
}

function requireSameProposalLock(
  left: ProposalLock,
  right: ProposalLock,
): void {
  requireEqual(left.conversationId, right.conversationId);
  requireEqual(left.previousRecordHash, right.previousRecordHash);
  requireEqual(left.actionHash, right.actionHash);
  requireSameBytes(left.canonicalActionCore, right.canonicalActionCore);
}
