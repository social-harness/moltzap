/** @file Retained local checks, editable policies and assessment queue transitions. */

import type { DatabaseSync } from "node:sqlite";

import { Schema } from "effect";

import type {
  FirewallActivation,
  FirewallAttempt,
  FirewallAuditEntry,
  FirewallCommit,
  FirewallCompletion,
  FirewallInboxEntry,
  FirewallLocalAdmission,
} from "./types.js";

import {
  readBytes,
  readInteger,
  readOptionalBytes,
  readText,
  requireBytes,
  requireSameBytes,
  requireSameOptionalBytes,
  requireText,
  StoreSignal,
  transaction,
} from "../../communication/store/database/index.js";
import { DeliveryToken } from "../../communication/store/types.js";

const auditDisposition = Schema.Literal(
  "checking",
  "interrupted",
  "admitted",
  "withheld",
);

/**
 * A held item is never requeued. Provenance is bound with the item: the same token cannot later
 * carry different private facts. An item is anchored at the newest record
 * certified when it is queued, so a local item's evidence precedes every
 * record certified after it, as the runtime is shown them.
 */
export function queueFirewallItem(
  database: DatabaseSync,
  item: Omit<FirewallInboxEntry, "sequence">,
): void {
  requireText(item.conversation);
  requireBytes(item.canonicalItem);
  const prior = database
    .prepare(
      "SELECT conversation, canonical_item, canonical_provenance FROM firewall_incoming WHERE delivery_token = ?",
    )
    .get(item.deliveryToken);
  if (prior !== undefined) {
    requireSameBytes(readBytes(prior, "canonical_item"), item.canonicalItem);
    requireSameOptionalBytes(
      readOptionalBytes(prior, "canonical_provenance"),
      item.canonicalProvenance,
    );
    if (readText(prior, "conversation") !== item.conversation) {
      throw new StoreSignal("conflict");
    }
    return;
  }
  database
    .prepare(
      "INSERT INTO firewall_incoming (delivery_token, conversation, canonical_item, canonical_provenance, anchor) SELECT ?, ?, ?, ?, COALESCE(MAX(rowid), 0) FROM certified_records",
    )
    .run(
      item.deliveryToken,
      item.conversation,
      item.canonicalItem,
      item.canonicalProvenance ?? null,
    );
}

/** One unsettled predecessor per conversation is eligible for checking. */
export function readFirewallFrontiers(
  database: DatabaseSync,
): readonly FirewallInboxEntry[] {
  return database
    .prepare(`
    SELECT item.sequence, item.delivery_token, item.conversation, item.canonical_item,
      item.canonical_provenance
    FROM firewall_incoming item
    WHERE item.disposition = 'pending' AND NOT EXISTS (
      SELECT 1 FROM firewall_incoming earlier
      WHERE earlier.conversation = item.conversation
        AND earlier.disposition = 'pending' AND earlier.sequence < item.sequence
    ) ORDER BY item.sequence LIMIT 32
  `)
    .all()
    .map(queuedEntry);
}

/** Restart recovery visits every private item, including successors behind a held frontier. */
export function readPendingFirewallItems(
  database: DatabaseSync,
  after: number,
): readonly FirewallInboxEntry[] {
  if (!Number.isSafeInteger(after) || after < 0) {
    throw new StoreSignal("invalid-input");
  }
  return database
    .prepare(`
      SELECT sequence, delivery_token, conversation, canonical_item, canonical_provenance
      FROM firewall_incoming
      WHERE disposition = 'pending' AND sequence > ?
      ORDER BY sequence LIMIT 32
    `)
    .all(after)
    .map(queuedEntry);
}

/** Missing policy means initial rules have never been seeded, distinct from an empty list. */
export function readFirewallPolicy(
  database: DatabaseSync,
): Uint8Array | undefined {
  const row = database
    .prepare("SELECT canonical_rules FROM firewall_policy WHERE singleton = 1")
    .get();
  return row === undefined ? undefined : readBytes(row, "canonical_rules");
}

/** The editable document and its activation either both commit or neither does. */
export function writeFirewallPolicy(
  database: DatabaseSync,
  rules: Uint8Array,
  activation?: FirewallActivation,
): void {
  requireBytes(rules);
  transaction(database, () => {
    database
      .prepare(`INSERT INTO firewall_policy (singleton, canonical_rules) VALUES (1, ?)
      ON CONFLICT(singleton) DO UPDATE SET canonical_rules = excluded.canonical_rules`)
      .run(rules);
    if (activation !== undefined) {
      database
        .prepare(`INSERT INTO firewall_activations
        (activated_at, active_revision, added_rule_ids, removed_rule_ids)
        VALUES (?, ?, ?, ?)`)
        .run(
          activation.time,
          activation.activeRevision,
          JSON.stringify(activation.addedRuleIds),
          JSON.stringify(activation.removedRuleIds),
        );
    }
  });
}

/** Recent edits preserve activation order when timestamps coincide. */
export function readFirewallActivations(
  database: DatabaseSync,
  request: { readonly since?: number },
) {
  const since = request.since ?? 0;
  if (!Number.isSafeInteger(since) || since < 0) {
    throw new StoreSignal("invalid-input");
  }
  return database
    .prepare(`SELECT sequence, activated_at, active_revision,
    added_rule_ids, removed_rule_ids FROM firewall_activations
    WHERE activated_at >= ? ORDER BY activated_at DESC, sequence DESC LIMIT 100`)
    .all(since)
    .map((row) => ({
      sequence: readInteger(row, "sequence"),
      activation: {
        time: readInteger(row, "activated_at"),
        activeRevision: readText(row, "active_revision"),
        addedRuleIds: Schema.decodeUnknownSync(
          Schema.parseJson(Schema.Array(Schema.NonEmptyString)),
        )(readText(row, "added_rule_ids")),
        removedRuleIds: Schema.decodeUnknownSync(
          Schema.parseJson(Schema.Array(Schema.NonEmptyString)),
        )(readText(row, "removed_rule_ids")),
      },
    }));
}

/** Completion time includes checks that started before a caller's previous poll. */
export function readFirewallDecisions(database: DatabaseSync, since = 0) {
  if (!Number.isSafeInteger(since) || since < 0) {
    throw new StoreSignal("invalid-input");
  }
  return database
    .prepare(`SELECT rowid AS sequence, check_id, direction,
    canonical_candidate, canonical_input, canonical_result, disposition, decided_at
    FROM firewall_checks WHERE decided_at >= ?
    ORDER BY decided_at DESC, rowid DESC LIMIT 100`)
    .all(since)
    .map((row) => ({
      ...auditEntry(row),
      time: readInteger(row, "decided_at"),
    }));
}

/** Local result decisions and evidence settle with the caller's host publication transaction. */
export function settleLocalItem(
  database: DatabaseSync,
  admission: FirewallLocalAdmission,
): void {
  const { deliveryToken } = admission.item;
  requireText(admission.evidence.conversation);
  requireBytes(admission.evidence.canonicalEntry);
  requireQueueFrontier(database, deliveryToken, admission.queuedItem);
  if (admission.deterministic !== undefined) {
    beginFirewallAttempt(database, admission.deterministic);
    completeFirewallAttempt(
      database,
      { ...admission.deterministic, admit: true },
      "incoming",
      admission.deterministic.canonicalCandidate,
    );
  }
  for (const completion of admission.completions) {
    completeFirewallAttempt(
      database,
      completion,
      "incoming",
      admission.queuedItem,
    );
  }
  markAnswers(database, admission.answers);
  database
    .prepare(`INSERT INTO firewall_local_evidence (conversation, anchor, canonical_entry)
 SELECT ?, anchor, ? FROM firewall_incoming WHERE delivery_token = ?`)
    .run(
      admission.evidence.conversation,
      admission.evidence.canonicalEntry,
      deliveryToken,
    );
  settleQueuedItem(database, deliveryToken, "admitted");
}

/** A started attempt survives interruption without being mistaken for a decision. */
export function beginFirewallAttempt(
  database: DatabaseSync,
  attempt: FirewallAttempt,
): void {
  requireText(attempt.checkId);
  requireBytes(attempt.canonicalCandidate);
  requireBytes(attempt.canonicalInput);
  database
    .prepare(`
    INSERT INTO firewall_checks (check_id, direction, canonical_candidate, canonical_input)
    VALUES (?, ?, ?, ?)
  `)
    .run(
      attempt.checkId,
      attempt.direction,
      attempt.canonicalCandidate,
      attempt.canonicalInput,
    );
}

/** A settled item cannot be offered for reassessment after restart. */
export function settleQueuedItem(
  database: DatabaseSync,
  deliveryToken: DeliveryToken,
  disposition: "admitted" | "withheld",
  checkId?: string,
): void {
  database
    .prepare(
      "UPDATE firewall_incoming SET disposition = ?, check_id = ? WHERE delivery_token = ?",
    )
    .run(disposition, checkId ?? null, deliveryToken);
}

/** A conversation commits its unsettled predecessor before later host items. */
export function requireQueueFrontier(
  database: DatabaseSync,
  deliveryToken: DeliveryToken,
  canonicalItem: Uint8Array,
): void {
  const queued = database
    .prepare(`
      SELECT conversation, sequence, canonical_item FROM firewall_incoming
      WHERE delivery_token = ? AND disposition = 'pending'
    `)
    .get(deliveryToken);
  if (queued === undefined) {
    throw new StoreSignal("conflict");
  }
  requireSameBytes(readBytes(queued, "canonical_item"), canonicalItem);
  const predecessor = database
    .prepare(`
      SELECT 1 AS pending FROM firewall_incoming
      WHERE conversation = ? AND sequence < ? AND disposition = 'pending' LIMIT 1
    `)
    .get(readText(queued, "conversation"), readInteger(queued, "sequence"));
  if (predecessor !== undefined) {
    throw new StoreSignal("conflict");
  }
}

/** Completes one retained check for exactly its captured candidate and direction. */
export function completeFirewallAttempt(
  database: DatabaseSync,
  completion: FirewallCompletion,
  direction: FirewallAttempt["direction"],
  canonicalCandidate: Uint8Array,
): FirewallCommit {
  checkingRow(database, completion, direction, canonicalCandidate);
  const disposition = completion.admit ? "admitted" : "withheld";
  completeFirewallCheck(database, completion, disposition);
  return disposition;
}

/** An expired queued request is retired once without deleting protocol context. */
export function retireQueuedItem(
  database: DatabaseSync,
  token: DeliveryToken,
): void {
  const retired = database
    .prepare(
      "UPDATE firewall_incoming SET disposition = 'withheld' WHERE delivery_token = ? AND disposition = 'pending'",
    )
    .run(token);
  if (retired.changes !== 1) {
    throw new StoreSignal("not-found");
  }
}

/** Record whether an admitted result showed or withheld each answer record. */
function markAnswers(
  database: DatabaseSync,
  answers: FirewallLocalAdmission["answers"],
): void {
  for (const answer of answers) {
    requireText(answer.recordHash);
    const marked = database
      .prepare(`
        INSERT INTO firewall_answers (conversation_id, record_hash, admitted)
        SELECT conversation_id, record_hash, ? FROM certified_records WHERE record_hash = ?
        ON CONFLICT (conversation_id, record_hash) DO UPDATE SET admitted = excluded.admitted
      `)
      .run(answer.admitted ? 1 : 0, answer.recordHash);
    if (marked.changes !== 1) {
      throw new StoreSignal("conflict");
    }
  }
}

/** The started check a completion finishes, for exactly this candidate. */
function checkingRow(
  database: DatabaseSync,
  completion: FirewallCompletion,
  direction: FirewallAttempt["direction"],
  canonicalCandidate: Uint8Array,
): void {
  const row = database
    .prepare(
      "SELECT direction, canonical_candidate, disposition FROM firewall_checks WHERE check_id = ?",
    )
    .get(completion.checkId);
  if (
    row === undefined ||
    readText(row, "disposition") !== "checking" ||
    readText(row, "direction") !== direction
  ) {
    throw new StoreSignal("conflict");
  }
  requireSameBytes(readBytes(row, "canonical_candidate"), canonicalCandidate);
}

function auditEntry(
  row: Readonly<Record<string, unknown>>,
): FirewallAuditEntry {
  const canonicalResult = readOptionalBytes(row, "canonical_result");
  return {
    sequence: readInteger(row, "sequence"),
    checkId: readText(row, "check_id"),
    direction: Schema.decodeUnknownSync(Schema.Literal("incoming", "outgoing"))(
      readText(row, "direction"),
    ),
    canonicalCandidate: readBytes(row, "canonical_candidate"),
    canonicalInput: readBytes(row, "canonical_input"),
    disposition: Schema.decodeUnknownSync(auditDisposition)(
      readText(row, "disposition"),
    ),
    ...(canonicalResult === undefined ? {} : { canonicalResult }),
  };
}

function completeFirewallCheck(
  database: DatabaseSync,
  completion: Pick<FirewallCompletion, "checkId" | "canonicalResult">,
  disposition: FirewallCommit,
): void {
  requireBytes(completion.canonicalResult);
  const changed = database
    .prepare(`
    UPDATE firewall_checks SET canonical_result = ?, disposition = ?,
      decided_at = CAST(unixepoch('subsec') * 1000 AS INTEGER)
    WHERE check_id = ? AND disposition = 'checking'
  `)
    .run(completion.canonicalResult, disposition, completion.checkId);
  if (changed.changes !== 1) {
    throw new StoreSignal("conflict");
  }
}

function queuedEntry(
  row: Readonly<Record<string, unknown>>,
): FirewallInboxEntry {
  const canonicalProvenance = readOptionalBytes(row, "canonical_provenance");
  return {
    sequence: readInteger(row, "sequence"),
    deliveryToken: Schema.decodeUnknownSync(DeliveryToken)(
      readText(row, "delivery_token"),
    ),
    conversation: readText(row, "conversation"),
    canonicalItem: readBytes(row, "canonical_item"),
    ...(canonicalProvenance === undefined ? {} : { canonicalProvenance }),
  };
}
