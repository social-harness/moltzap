/** @file Atomic record-core, evidence, certification, and delivery transitions. */

import type { DatabaseSync } from "node:sqlite";
import type {
  CertifiedRecord,
  InboundDeliveryInput,
  ProposalLock,
  ProtocolEvidence,
  StagedRecord,
  StoreMutation,
} from "./types.js";
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
import {
  retainDeliveryInTransaction,
  retainDisseminationInTransaction,
} from "./queues/index.js";
import {
  findProposalLock,
  findStagedReanchor,
  findStagedRecord,
  GENESIS_PREDECESSOR,
  lockProposalInTransaction,
  readStoredIdentity,
  readStoredPosition,
  releaseProposalLock,
  requireSameRecord,
} from "./rows.js";

/**
 * Atomically stages an action-certified record and its send obligation.
 *
 * @param database Exclusively owned endpoint database.
 * @param record Verified record core whose complete action evidence is durable.
 * @returns Whether either exact durable component was inserted.
 */
export function stageRecordForDissemination(
  database: DatabaseSync,
  record: StagedRecord,
): StoreMutation {
  validateStagedRecord(record);
  return transaction(database, () => {
    const staged = stageRecordInTransaction(database, record, "vote");
    const obligation = retainDisseminationInTransaction(database, record);
    return staged === "inserted" || obligation === "inserted"
      ? "inserted"
      : "existing";
  });
}

/**
 * Merges one stable evidence item without replacing a conflicting value.
 *
 * @param database Exclusively owned endpoint database.
 * @param evidence Verified evidence with its canonical merge key.
 * @returns Whether the evidence was inserted or already durable.
 */
export function mergeEvidence(
  database: DatabaseSync,
  evidence: ProtocolEvidence,
): StoreMutation {
  validateEvidence(evidence);
  return transaction(database, () =>
    mergeEvidenceInTransaction(database, evidence),
  );
}

/**
 * Atomically replaces the lock this endpoint holds on another action at a
 * predecessor with the lock on an action whose `q(n)` action certificate it
 * verified, releasing everything held for the other action and retaining the
 * certificate's signatures. They are written with the new lock so that a
 * restart never finds the certified action locked without the certificate
 * that keeps this endpoint from signing it.
 *
 * A held action this endpoint already staged refuses the replacement as a
 * conflict. Staging it took its own `q(n)` action certificate, so a second one
 * at the same predecessor shows more than `f` faulty members, and this
 * endpoint, which may have voted for the staged record, must never vote for
 * another successor of that head under the same anchor.
 *
 * @param database Exclusively owned endpoint database.
 * @param lock The lock on the certified action.
 * @param certificate The action certificate's signatures as evidence rows.
 * @returns Whether the lock on the certified action was inserted.
 */
export function supersedeProposalLock(
  database: DatabaseSync,
  lock: ProposalLock,
  certificate: readonly ProtocolEvidence[],
): StoreMutation {
  validateCertificateEvidence(certificate, {
    conversationId: lock.conversationId,
    kind: "action",
    subjectId: lock.actionHash,
  });
  return transaction(database, () => {
    const held = findProposalLock(
      database,
      lock.conversationId,
      lock.previousRecordHash ?? GENESIS_PREDECESSOR,
    );
    if (held !== undefined && held.actionHash !== lock.actionHash) {
      if (hasStagedAction(database, held)) {
        throw new StoreSignal("conflict");
      }
      releaseProposalLock(database, held);
    }
    const mutation = lockProposalInTransaction(database, lock);
    for (const evidence of certificate) {
      mergeEvidenceInTransaction(database, evidence);
    }
    return mutation;
  });
}

/**
 * Atomically promotes a complete record, advances its head, and retains its
 * local post completion or remote host delivery.
 *
 * @param database Exclusively owned endpoint database.
 * @param record Verified complete certified record.
 * @param delivery Canonical remote host message, absent for the local author.
 * @returns Whether any durable state was inserted.
 */
export function promoteRecord(
  database: DatabaseSync,
  record: CertifiedRecord,
  delivery?: InboundDeliveryInput,
): StoreMutation {
  validateCertifiedRecord(record);
  return transaction(database, () =>
    promoteRecordInTransaction(database, record, delivery),
  );
}

/**
 * Atomically stages and promotes a record received whole, with its
 * certificates' evidence and its local post completion or remote host
 * delivery. A crash therefore never leaves its core staged without its
 * certification, where a restart could not tell it from a record this
 * endpoint staged for its own durability vote. This endpoint casts no vote
 * for it, so its core is staged even under an anchor this endpoint has
 * staged a re-anchor candidate away from; a vote of this endpoint's own in
 * its certificate is held to the rules it would be cast under.
 *
 * @param database Exclusively owned endpoint database.
 * @param record Verified complete certified record.
 * @param delivery Canonical remote host message, absent for the local author.
 * @returns Whether any durable state was inserted.
 */
export function applyCertifiedRecord(
  database: DatabaseSync,
  record: CertifiedRecord,
  delivery?: InboundDeliveryInput,
): StoreMutation {
  validateCertifiedRecord(record);
  return transaction(database, () => {
    const staged = stageRecordInTransaction(database, record, "certified");
    const promoted = promoteRecordInTransaction(database, record, delivery);
    return staged === "inserted" || promoted === "inserted"
      ? "inserted"
      : "existing";
  });
}

/**
 * Stage one record core. A record staged for this endpoint's durability vote
 * is refused under an anchor it has staged a re-anchor candidate away from; a
 * certified record's core is staged regardless, since it takes no vote.
 * @param database Exclusively owned endpoint database.
 * @param record Verified record core and private bindings.
 * @param purpose Whether this endpoint votes for the record or holds its
 *     durability certificate.
 * @returns Whether the record was inserted or already staged.
 */
function stageRecordInTransaction(
  database: DatabaseSync,
  record: StagedRecord,
  purpose: "vote" | "certified",
): StoreMutation {
  const existing = findStagedRecord(
    database,
    record.conversationId,
    record.recordHash,
  );
  if (existing !== undefined) {
    requireSameRecord(existing, record);
    return "existing";
  }
  requireRecordPosition(database, record);
  if (purpose === "vote") {
    requireNoReanchorAwayFrom(database, record);
  }
  database
    .prepare(
      `INSERT INTO staged_records
        (conversation_id, record_hash, previous_record_hash,
         membership_hash, anchor_hash, action_hash, author_agent_id, post_id,
         canonical_record_core)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      record.conversationId,
      record.recordHash,
      record.previousRecordHash ?? null,
      record.membershipHash,
      record.anchorHash,
      record.actionHash,
      record.authorAgentId,
      record.postId,
      copyBytes(record.canonicalRecordCore),
    );
  return "inserted";
}

function promoteRecordInTransaction(
  database: DatabaseSync,
  record: CertifiedRecord,
  // eslint-disable-next-line agent-code-guard/no-conditional-chaining -- Delivery retention resolves absence against the stored author identity inside this transaction.
  delivery?: InboundDeliveryInput,
): StoreMutation {
  const staged = findStagedRecord(
    database,
    record.conversationId,
    record.recordHash,
  );
  if (staged === undefined) {
    throw new StoreSignal("not-found");
  }
  requireSameRecord(staged, record);
  const evidenceMutation = mergeCertifiedEvidence(database, record);
  if (hasCertifiedRecord(database, record.conversationId, record.recordHash)) {
    const deliveryMutation = retainDeliveryInTransaction(
      database,
      record,
      delivery,
    );
    return evidenceMutation === "inserted" || deliveryMutation === "inserted"
      ? "inserted"
      : "existing";
  }
  const position = readStoredPosition(database, record.conversationId);
  requireEqual(position.currentAnchorHash, record.anchorHash);
  requireEqual(position.headRecordHash, record.previousRecordHash);
  insertCertifiedRecord(database, record, position.headOrdinal + 1);
  completeLocalPostIntent(database, record);
  retainDeliveryInTransaction(database, record, delivery);
  return "inserted";
}

function mergeCertifiedEvidence(
  database: DatabaseSync,
  record: CertifiedRecord,
): StoreMutation {
  let mutation: StoreMutation = "existing";
  for (const evidence of [
    ...record.actionEvidence,
    ...record.durabilityEvidence,
  ]) {
    if (mergeEvidenceInTransaction(database, evidence) === "inserted") {
      mutation = "inserted";
    }
  }
  return mutation;
}

function mergeEvidenceInTransaction(
  database: DatabaseSync,
  evidence: ProtocolEvidence,
): StoreMutation {
  requireEvidenceSubject(database, evidence);
  const existing = findEvidence(database, evidence);
  if (existing !== undefined) {
    requireSameBytes(existing, evidence.canonicalEvidence);
    return "existing";
  }
  database
    .prepare(
      `INSERT INTO protocol_evidence
        (conversation_id, evidence_kind, subject_id,
         evidence_key, canonical_evidence)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      evidence.conversationId,
      evidence.kind,
      evidence.subjectId,
      evidence.evidenceKey,
      copyBytes(evidence.canonicalEvidence),
    );
  return "inserted";
}

function requireRecordPosition(
  database: DatabaseSync,
  record: StagedRecord,
): void {
  const position = readStoredPosition(database, record.conversationId);
  requireEqual(position.membershipHash, record.membershipHash);
  requireEqual(position.currentAnchorHash, record.anchorHash);
  requireEqual(position.headRecordHash, record.previousRecordHash);
  const proposalLock = findProposalLock(
    database,
    record.conversationId,
    record.previousRecordHash ?? GENESIS_PREDECESSOR,
  );
  if (proposalLock !== undefined) {
    requireEqual(proposalLock.actionHash, record.actionHash);
  }
}

function findEvidence(
  database: DatabaseSync,
  evidence: ProtocolEvidence,
): Uint8Array | undefined {
  const row = database
    .prepare(
      `SELECT canonical_evidence FROM protocol_evidence
       WHERE conversation_id = ? AND evidence_kind = ?
         AND subject_id = ? AND evidence_key = ?`,
    )
    .get(
      evidence.conversationId,
      evidence.kind,
      evidence.subjectId,
      evidence.evidenceKey,
    );
  return row === undefined ? undefined : readBytes(row, "canonical_evidence");
}

function requireEvidenceSubject(
  database: DatabaseSync,
  evidence: ProtocolEvidence,
): void {
  requireMembership(database, evidence.conversationId);
  requireLocalEvidenceLock(database, evidence);
  if (evidence.kind === "action") {
    if (!hasActionSubject(database, evidence)) {
      throw new StoreSignal("not-found");
    }
  }
  if (
    evidence.kind === "durability" &&
    findStagedRecord(database, evidence.conversationId, evidence.subjectId) ===
      undefined
  ) {
    throw new StoreSignal("not-found");
  }
  if (
    evidence.kind === "reanchor" &&
    findStagedReanchor(
      database,
      evidence.conversationId,
      evidence.subjectId,
    ) === undefined
  ) {
    throw new StoreSignal("not-found");
  }
}

function requireLocalEvidenceLock(
  database: DatabaseSync,
  evidence: ProtocolEvidence,
): void {
  const identity = readStoredIdentity(database);
  if (identity === undefined || evidence.evidenceKey !== identity.agentId) {
    return;
  }
  if (evidence.kind === "action") {
    if (!hasProposalAction(database, evidence)) {
      throw new StoreSignal("not-found");
    }
    return;
  }
  if (evidence.kind === "durability") {
    requireLocalDurabilityEvidenceLock(database, evidence);
  }
}

function requireLocalDurabilityEvidenceLock(
  database: DatabaseSync,
  evidence: ProtocolEvidence,
): void {
  const record = findStagedRecord(
    database,
    evidence.conversationId,
    evidence.subjectId,
  );
  if (record === undefined) {
    throw new StoreSignal("not-found");
  }
  const proposalLock = findProposalLock(
    database,
    record.conversationId,
    record.previousRecordHash ?? GENESIS_PREDECESSOR,
  );
  if (
    proposalLock === undefined ||
    proposalLock.actionHash !== record.actionHash
  ) {
    throw new StoreSignal("not-found");
  }
  requireNoReanchorAwayFrom(database, record);
}

/**
 * Refuse a record under an anchor this endpoint has staged a re-anchor
 * candidate away from, wherever this endpoint would vote for it: as it stages
 * the record for its vote, and as it stores its own vote for any staged
 * record. A member that has voted to leave an anchor signs nothing more under
 * it, so a re-anchor away from a head and a durability certificate extending
 * that head never both collect this endpoint's signature.
 * @param database Exclusively owned endpoint database.
 * @param record Record about to be staged for this endpoint's vote, or a
 *     staged record this endpoint's own vote is about to be stored for.
 */
function requireNoReanchorAwayFrom(
  database: DatabaseSync,
  record: StagedRecord,
): void {
  const left = database
    .prepare(
      `SELECT 1 AS staged FROM reanchors
       WHERE conversation_id = ? AND previous_anchor_hash = ? LIMIT 1`,
    )
    .get(record.conversationId, record.anchorHash);
  if (left !== undefined) {
    throw new StoreSignal("conflict");
  }
}

function hasProposalAction(
  database: DatabaseSync,
  evidence: ProtocolEvidence,
): boolean {
  return (
    database
      .prepare(
        `SELECT 1 AS retained FROM proposal_locks
         WHERE conversation_id = ? AND action_hash = ? LIMIT 1`,
      )
      .get(evidence.conversationId, evidence.subjectId) !== undefined
  );
}

function hasStagedAction(database: DatabaseSync, lock: ProposalLock): boolean {
  return (
    database
      .prepare(
        `SELECT 1 AS staged FROM staged_records
         WHERE conversation_id = ? AND action_hash = ? LIMIT 1`,
      )
      .get(lock.conversationId, lock.actionHash) !== undefined
  );
}

function hasActionSubject(
  database: DatabaseSync,
  evidence: ProtocolEvidence,
): boolean {
  return (
    database
      .prepare(
        `SELECT 1 AS retained FROM proposal_locks
         WHERE conversation_id = ? AND action_hash = ?
         UNION ALL
         SELECT 1 AS retained FROM staged_records
         WHERE conversation_id = ? AND action_hash = ?
         LIMIT 1`,
      )
      .get(
        evidence.conversationId,
        evidence.subjectId,
        evidence.conversationId,
        evidence.subjectId,
      ) !== undefined
  );
}

function insertCertifiedRecord(
  database: DatabaseSync,
  record: CertifiedRecord,
  ordinal: number,
): void {
  database
    .prepare(
      `INSERT INTO certified_records (conversation_id, record_hash, ordinal)
       VALUES (?, ?, ?)`,
    )
    .run(record.conversationId, record.recordHash, ordinal);
  database
    .prepare(
      `UPDATE conversation_state
       SET head_record_hash = ?, head_ordinal = ? WHERE conversation_id = ?`,
    )
    .run(record.recordHash, ordinal, record.conversationId);
}

function completeLocalPostIntent(
  database: DatabaseSync,
  record: CertifiedRecord,
): void {
  const identity = readStoredIdentity(database);
  if (identity === undefined) {
    throw new StoreSignal("not-found");
  }
  if (record.authorAgentId !== identity.agentId) {
    return;
  }
  const row = database
    .prepare(
      `SELECT conversation_id, membership_hash, completed_record_hash
       FROM post_intents WHERE author_agent_id = ? AND post_id = ?`,
    )
    .get(record.authorAgentId, record.postId);
  if (row === undefined) {
    throw new StoreSignal("not-found");
  }
  requireEqual(readText(row, "conversation_id"), record.conversationId);
  requireEqual(readText(row, "membership_hash"), record.membershipHash);
  const completed = readOptionalText(row, "completed_record_hash");
  if (completed !== undefined && completed !== record.recordHash) {
    throw new StoreSignal("conflict");
  }
  database
    .prepare(
      `UPDATE post_intents SET completed_record_hash = ?
       WHERE author_agent_id = ? AND post_id = ?`,
    )
    .run(record.recordHash, record.authorAgentId, record.postId);
}

function requireMembership(
  database: DatabaseSync,
  conversationId: string,
): void {
  if (
    database
      .prepare(
        "SELECT 1 AS retained FROM memberships WHERE conversation_id = ?",
      )
      .get(conversationId) === undefined
  ) {
    throw new StoreSignal("not-found");
  }
}

function hasCertifiedRecord(
  database: DatabaseSync,
  conversationId: string,
  recordHash: string,
): boolean {
  return (
    database
      .prepare(
        `SELECT 1 AS retained FROM certified_records
         WHERE conversation_id = ? AND record_hash = ?`,
      )
      .get(conversationId, recordHash) !== undefined
  );
}

function validateCertifiedRecord(record: CertifiedRecord): void {
  validateStagedRecord(record);
  validateCertificateEvidence(record.actionEvidence, {
    conversationId: record.conversationId,
    kind: "action",
    subjectId: record.actionHash,
  });
  validateCertificateEvidence(record.durabilityEvidence, {
    conversationId: record.conversationId,
    kind: "durability",
    subjectId: record.recordHash,
  });
}

function validateCertificateEvidence(
  evidenceItems: readonly ProtocolEvidence[],
  expected: Readonly<{
    conversationId: string;
    kind: ProtocolEvidence["kind"];
    subjectId: string;
  }>,
): void {
  if (evidenceItems.length === 0) {
    throw new StoreSignal("invalid-input");
  }
  const keys = new Set<string>();
  for (const evidence of evidenceItems) {
    validateEvidence(evidence);
    if (
      evidence.conversationId !== expected.conversationId ||
      evidence.kind !== expected.kind ||
      evidence.subjectId !== expected.subjectId ||
      keys.has(evidence.evidenceKey)
    ) {
      throw new StoreSignal("invalid-input");
    }
    keys.add(evidence.evidenceKey);
  }
}

function validateStagedRecord(record: StagedRecord): void {
  requireText(record.conversationId);
  requireText(record.recordHash);
  if (record.previousRecordHash !== undefined) {
    requireText(record.previousRecordHash);
  }
  requireText(record.membershipHash);
  requireText(record.anchorHash);
  requireText(record.actionHash);
  requireText(record.authorAgentId);
  requireText(record.postId);
  requireBytes(record.canonicalRecordCore);
}

function validateEvidence(evidence: ProtocolEvidence): void {
  requireText(evidence.conversationId);
  requireText(evidence.subjectId);
  requireText(evidence.evidenceKey);
  requireBytes(evidence.canonicalEvidence);
}
