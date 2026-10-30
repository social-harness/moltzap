import * as SqlClient from "@effect/sql/SqlClient";
import { EndpointStoreError, storeOperation } from "../database/index.js";
import { Effect } from "effect";
/** @file Certified record cores and their separately retained signer evidence. */
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
 * @param row SQLite result row for the certified record core.
 * @returns The detached complete certified record.
 */
export function readCertifiedRecord(
  row: Readonly<Record<string, unknown>>,
): Effect.Effect<CertifiedRecord, EndpointStoreError, SqlClient.SqlClient> {
  return Effect.gen(function* () {
    const database = yield* SqlClient.SqlClient;
    const staged = readStagedRecord(row);
    const actionEvidence = yield* readEvidenceForSubject(
      staged.conversationId,
      "action",
      staged.actionHash,
    );
    const durabilityEvidence = yield* readEvidenceForSubject(
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
  }).pipe(storeOperation);
}
/**
 * Reads an optional staged record by stable private hash.
 *
 * @param conversationId Opaque conversation identity.
 * @param recordHash Stable private record hash.
 * @returns The detached staged record when present.
 */
export function findStagedRecord(
  conversationId: string,
  recordHash: string,
): Effect.Effect<
  StagedRecord | undefined,
  EndpointStoreError,
  SqlClient.SqlClient
> {
  return Effect.gen(function* () {
    const database = yield* SqlClient.SqlClient;
    const row = (yield* database.unsafe<Readonly<Record<string, unknown>>>(
      `SELECT conversation_id, record_hash, previous_record_hash,
              membership_hash, anchor_hash, action_hash, author_agent_id,
              msg_id, canonical_record_core
       FROM staged_records WHERE conversation_id = ? AND record_hash = ?`,
      [conversationId, recordHash],
    ))[0];
    return row === undefined ? undefined : readStagedRecord(row);
  }).pipe(storeOperation);
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
    msgId: readText(row, "msg_id"),
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
  requireEqual(left.msgId, right.msgId);
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
 * @param conversationId Conversation whose evidence is retained.
 * @param kind Separate evidence domain to read.
 * @param subjectId Action, record, request, or anchor identity.
 * @returns Detached evidence ordered by signer key.
 */
function readEvidenceForSubject(
  conversationId: string,
  kind: ProtocolEvidence["kind"],
  subjectId: string,
): Effect.Effect<
  readonly ProtocolEvidence[],
  EndpointStoreError,
  SqlClient.SqlClient
> {
  return Effect.gen(function* () {
    const database = yield* SqlClient.SqlClient;
    return Object.freeze(
      (yield* database.unsafe<Readonly<Record<string, unknown>>>(
        `SELECT conversation_id, evidence_kind, subject_id,
                evidence_key, canonical_evidence
         FROM protocol_evidence
         WHERE conversation_id = ? AND evidence_kind = ? AND subject_id = ?
         ORDER BY evidence_key COLLATE BINARY`,
        [conversationId, kind, subjectId],
      )).map(readProtocolEvidence),
    );
  }).pipe(storeOperation);
}
