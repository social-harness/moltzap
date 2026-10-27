/** @file Certified record cores and their separately retained signer evidence. */

import type { DatabaseSync } from "node:sqlite";
import type {
  CertifiedRecord,
  ProtocolEvidence,
  StagedRecord,
} from "../types.js";
import {
  readBytes,
  readOptionalText,
  readText,
  requireEqual,
  requireSameBytes,
  StoreSignal,
} from "../database/index.js";

/**
 * Projects one complete certified record and its separate evidence maps.
 *
 * @param database Exclusively owned endpoint database.
 * @param row SQLite result row for the certified record core.
 * @returns The detached complete certified record.
 */
export function readCertifiedRecord(
  database: DatabaseSync,
  row: Readonly<Record<string, unknown>>,
): CertifiedRecord {
  const staged = readStagedRecord(row);
  const actionEvidence = readEvidenceForSubject(
    database,
    staged.conversationId,
    "action",
    staged.actionHash,
  );
  const durabilityEvidence = readEvidenceForSubject(
    database,
    staged.conversationId,
    "durability",
    staged.recordHash,
  );
  if (actionEvidence.length === 0 || durabilityEvidence.length === 0) {
    throw new StoreSignal("corrupt");
  }
  return Object.freeze({
    ...staged,
    actionEvidence,
    durabilityEvidence,
  });
}

/**
 * Reads an optional staged record by stable private hash.
 *
 * @param database Exclusively owned endpoint database.
 * @param conversationId Opaque conversation identity.
 * @param recordHash Stable private record hash.
 * @returns The detached staged record when present.
 */
export function findStagedRecord(
  database: DatabaseSync,
  conversationId: string,
  recordHash: string,
): StagedRecord | undefined {
  const row = database
    .prepare(
      `SELECT conversation_id, record_hash, previous_record_hash,
              membership_hash, anchor_hash, action_hash, author_agent_id,
              post_id, canonical_record_core
       FROM staged_records WHERE conversation_id = ? AND record_hash = ?`,
    )
    .get(conversationId, recordHash);
  return row === undefined ? undefined : readStagedRecord(row);
}

/**
 * Projects one exact staged record core.
 *
 * @param row SQLite result row.
 * @returns The detached staged record.
 */
export function readStagedRecord(
  row: Readonly<Record<string, unknown>>,
): StagedRecord {
  const previousRecordHash = readOptionalText(row, "previous_record_hash");
  return Object.freeze({
    conversationId: readText(row, "conversation_id"),
    recordHash: readText(row, "record_hash"),
    ...(previousRecordHash === undefined ? {} : { previousRecordHash }),
    membershipHash: readText(row, "membership_hash"),
    anchorHash: readText(row, "anchor_hash"),
    actionHash: readText(row, "action_hash"),
    authorAgentId: readText(row, "author_agent_id"),
    postId: readText(row, "post_id"),
    canonicalRecordCore: readBytes(row, "canonical_record_core"),
  });
}

/**
 * Requires two records with one stable hash to have identical bindings.
 *
 * @param left Previously retained staged record.
 * @param right Candidate record with the same private hash.
 */
export function requireSameRecord(
  left: StagedRecord,
  right: StagedRecord,
): void {
  requireEqual(left.conversationId, right.conversationId);
  requireEqual(left.recordHash, right.recordHash);
  requireEqual(left.previousRecordHash, right.previousRecordHash);
  requireEqual(left.membershipHash, right.membershipHash);
  requireEqual(left.anchorHash, right.anchorHash);
  requireEqual(left.actionHash, right.actionHash);
  requireEqual(left.authorAgentId, right.authorAgentId);
  requireEqual(left.postId, right.postId);
  requireSameBytes(left.canonicalRecordCore, right.canonicalRecordCore);
}

/**
 * Projects one stable evidence value.
 *
 * @param row SQLite result row.
 * @returns The detached protocol evidence.
 */
export function readProtocolEvidence(
  row: Readonly<Record<string, unknown>>,
): ProtocolEvidence {
  return Object.freeze({
    conversationId: readText(row, "conversation_id"),
    kind: readEvidenceKind(row),
    subjectId: readText(row, "subject_id"),
    evidenceKey: readText(row, "evidence_key"),
    canonicalEvidence: readBytes(row, "canonical_evidence"),
  });
}

function readEvidenceKind(
  row: Readonly<Record<string, unknown>>,
): ProtocolEvidence["kind"] {
  const kind = readText(row, "evidence_kind");
  if (
    kind !== "action" &&
    kind !== "durability" &&
    kind !== "catch-up" &&
    kind !== "reanchor"
  ) {
    throw new StoreSignal("corrupt");
  }
  return kind;
}

/**
 * Reads one ordered signer evidence map from its separate store rows.
 *
 * @param database Exclusively owned endpoint database.
 * @param conversationId Conversation whose evidence is retained.
 * @param kind Separate evidence domain to read.
 * @param subjectId Action, record, request, or anchor identity.
 * @returns Detached evidence ordered by signer key.
 */
function readEvidenceForSubject(
  database: DatabaseSync,
  conversationId: string,
  kind: ProtocolEvidence["kind"],
  subjectId: string,
): readonly ProtocolEvidence[] {
  return Object.freeze(
    database
      .prepare(
        `SELECT conversation_id, evidence_kind, subject_id,
                evidence_key, canonical_evidence
         FROM protocol_evidence
         WHERE conversation_id = ? AND evidence_kind = ? AND subject_id = ?
         ORDER BY evidence_key COLLATE BINARY`,
      )
      .all(conversationId, kind, subjectId)
      .map(readProtocolEvidence),
  );
}
