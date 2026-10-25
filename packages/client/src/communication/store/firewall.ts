/** @file Private admission queues, evidence ranges and retained check attempts. */

import type { DatabaseSync } from "node:sqlite";
import { Schema } from "effect";
import { sameBytes } from "../../encoding/canonical-json.js";
import {
  readBytes,
  readInteger,
  readOptionalBytes,
  readOptionalText,
  readText,
  requireBytes,
  requireSameBytes,
  requireSameOptionalBytes,
  requireText,
  StoreSignal,
  transaction,
} from "./database/index.js";
import { putInboxItem, retirePendingDelivery } from "./inbox.js";
import {
  DeliveryToken,
  type FirewallActivation,
  type FirewallAttempt,
  type FirewallAuditEntry,
  type FirewallCommit,
  type FirewallCompletion,
  type FirewallEvidence,
  type FirewallEvidenceRange,
  type FirewallEvidenceSlice,
  type FirewallEvidenceSlices,
  type FirewallHistoryEntry,
  type FirewallInboxEntry,
  type FirewallLocalAdmission,
  type FirewallLocalEntry,
  type FirewallRequestAdmission,
  type InboxEntry,
  MAXIMUM_RUNTIME_ITEM_BYTES,
  type OwnerProposal,
} from "./types.js";

// safer-arch-ignore file-implicit-boundary-module: Store composition and intent admission share these private transaction primitives so the audit, inbox, and intent writes commit atomically; only store/index.ts exposes the store capability.

const historySelect = `
  SELECT c.ordinal AS position, c.rowid AS sequence, c.conversation_id,
    s.canonical_record_core, m.canonical_membership,
    CASE WHEN i.delivery_token IS NOT NULL
      THEN 1 ELSE 0 END AS visible,
    a.admitted AS answer_admitted
  FROM certified_records c
  JOIN staged_records s ON s.conversation_id = c.conversation_id AND s.record_hash = c.record_hash
  JOIN memberships m ON m.conversation_id = c.conversation_id
  LEFT JOIN pending_deliveries d ON d.conversation_id = c.conversation_id AND d.record_hash = c.record_hash
  LEFT JOIN runtime_inbox i ON i.delivery_token = d.delivery_token
  LEFT JOIN firewall_answers a ON a.conversation_id = c.conversation_id AND a.record_hash = c.record_hash
`;

const auditDisposition = Schema.Literal(
  "checking",
  "interrupted",
  "stale",
  "admitted",
  "withheld",
);

/** Shutdown readers page over every attempt while daemon writers are stopped. */
export function readFirewallAuditPage(
  database: DatabaseSync,
  after: number,
): readonly FirewallAuditEntry[] {
  if (!Number.isSafeInteger(after) || after < 0) {
    throw new StoreSignal("invalid-input");
  }
  return database
    .prepare(`
    SELECT rowid AS sequence, check_id, direction, revision,
      canonical_candidate, canonical_input, canonical_result, disposition
    FROM firewall_checks WHERE rowid > ? ORDER BY rowid LIMIT 32
  `)
    .all(after)
    .map(auditEntry);
}

/**
 * Previously visible items retain their admission; a held item is never
 * requeued. Provenance is bound with the item: the same token cannot later
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
  const visible = database
    .prepare(
      "SELECT canonical_item FROM runtime_inbox WHERE delivery_token = ?",
    )
    .get(item.deliveryToken);
  if (visible !== undefined) {
    requireSameBytes(readBytes(visible, "canonical_item"), item.canonicalItem);
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

/** Incoming evidence stops strictly before the candidate's local certification position. */
export function readFirewallEvidence(
  database: DatabaseSync,
  input: FirewallEvidenceRange & { readonly maximumRecords: number },
): FirewallEvidence {
  const { slices, ...captured } = readFirewallEvidenceSlices(database, {
    ranges: [input],
    maximumRecords: input.maximumRecords,
  });
  const [slice] = slices;
  if (slice === undefined) {
    throw new StoreSignal("corrupt");
  }
  return { ...captured, ...slice };
}

/**
 * Several windows read at one revision, so the checks of one result's texts
 * compare against one capture and commit together.
 */
export function readFirewallEvidenceSlices(
  database: DatabaseSync,
  input: {
    readonly ranges: readonly FirewallEvidenceRange[];
    readonly maximumRecords: number;
  },
): FirewallEvidenceSlices {
  if (
    !Number.isSafeInteger(input.maximumRecords) ||
    input.maximumRecords < 1 ||
    input.maximumRecords > 1024
  ) {
    throw new StoreSignal("invalid-input");
  }
  return {
    revision: firewallRevision(database),
    pendingOutgoing:
      database
        .prepare(
          "SELECT 1 AS pending FROM post_intents WHERE completed_record_hash IS NULL LIMIT 1",
        )
        .get() !== undefined,
    slices: input.ranges.map((range) =>
      readSlice(database, range, input.maximumRecords),
    ),
  };
}

/**
 * How a received request's admission settled, read by its certified record.
 * The runtime was shown it when it reached the inbox; the check that decided
 * is the one its queue entry commits.
 */
export function readFirewallRequestAdmission(
  database: DatabaseSync,
  recordHash: string,
): FirewallRequestAdmission | undefined {
  requireText(recordHash);
  const row = database
    .prepare(`
      SELECT i.delivery_token AS presented, f.check_id, k.canonical_result
      FROM pending_deliveries d
      LEFT JOIN runtime_inbox i ON i.delivery_token = d.delivery_token
      LEFT JOIN firewall_incoming f ON f.delivery_token = d.delivery_token
      LEFT JOIN firewall_checks k ON k.check_id = f.check_id
      WHERE d.record_hash = ?
    `)
    .get(recordHash);
  if (row === undefined) {
    return undefined;
  }
  const checkId = readOptionalText(row, "check_id");
  const canonicalResult = readOptionalBytes(row, "canonical_result");
  return {
    presented: readOptionalText(row, "presented") !== undefined,
    ...(checkId === undefined ? {} : { checkId }),
    ...(canonicalResult === undefined ? {} : { canonicalResult }),
  };
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
    INSERT INTO firewall_checks (check_id, direction, revision, canonical_candidate, canonical_input)
    VALUES (?, ?, ?, ?, ?)
  `)
    .run(
      attempt.checkId,
      attempt.direction,
      attempt.revision,
      attempt.canonicalCandidate,
      attempt.canonicalInput,
    );
}

/** Visibility, guidance and audit commit together; a hold also retires raw delivery work. */
export function admitFirewallItem(
  database: DatabaseSync,
  item: Omit<InboxEntry, "sequence">,
  completion: FirewallCompletion,
): FirewallCommit {
  return transaction(database, () => {
    requireQueueFrontier(database, item.deliveryToken, item.canonicalItem);
    const disposition = compareFirewallCheck(
      database,
      completion,
      "incoming",
      item.canonicalItem,
    );
    if (disposition === "stale") {
      return disposition;
    }
    if (disposition === "admitted") {
      putInboxItem(database, item);
    } else {
      retirePendingDelivery(database, item.deliveryToken);
    }
    settleQueuedItem(
      database,
      item.deliveryToken,
      disposition,
      completion.checkId,
    );
    return disposition;
  });
}

/**
 * Commit one local item: its projection, the checks of its texts at one
 * revision, the answer records they showed or withheld, and its evidence.
 * A stale admitting check makes every check stale and changes nothing else,
 * so the item is checked again from a fresh capture; a withholding check is
 * never stale. A deterministic check is begun and completed here, so it
 * cannot be stale. Its evidence keeps the item's queue anchor.
 */
export function admitFirewallLocalItem(
  database: DatabaseSync,
  admission: FirewallLocalAdmission,
): FirewallCommit {
  const { deliveryToken } = admission.item;
  requireText(admission.evidence.conversation);
  requireBytes(admission.evidence.canonicalEntry);
  return transaction(database, () => {
    requireQueueFrontier(database, deliveryToken, admission.queuedItem);
    if (admission.deterministic !== undefined) {
      beginFirewallAttempt(database, {
        ...admission.deterministic,
        revision: firewallRevision(database),
      });
      completeFirewallCheck(database, admission.deterministic, "admitted");
    }
    if (!completeLocalChecks(database, admission)) {
      return "stale";
    }
    putInboxItem(database, admission.item);
    markAnswers(database, admission.answers);
    database
      .prepare(`
        INSERT INTO firewall_local_evidence (conversation, anchor, canonical_entry)
        SELECT ?, anchor, ? FROM firewall_incoming WHERE delivery_token = ?
      `)
      .run(
        admission.evidence.conversation,
        admission.evidence.canonicalEntry,
        deliveryToken,
      );
    settleQueuedItem(database, deliveryToken, "admitted");
    return "admitted";
  });
}

/**
 * Retire a queued item the runtime was never shown, without a check: a
 * request whose context restart lost, or whose deadline passed before its
 * check began. Its raw delivery retires with it.
 */
export function retireFirewallItem(
  database: DatabaseSync,
  deliveryToken: DeliveryToken,
): void {
  transaction(database, () => {
    const retired = database
      .prepare(
        "UPDATE firewall_incoming SET disposition = 'withheld' WHERE delivery_token = ? AND disposition = 'pending'",
      )
      .run(deliveryToken);
    if (retired.changes !== 1) {
      throw new StoreSignal("not-found");
    }
    retirePendingDelivery(database, deliveryToken);
  });
}

/**
 * Admit a gather operation: its check's evidence comparison and the admitted
 * row its request posts later bind against share one transaction. The row is
 * the check itself, whose candidate is the request content every post
 * carries.
 */
export function admitFirewallOperation(
  database: DatabaseSync,
  completion: FirewallCompletion,
  canonicalCandidate: Uint8Array,
): FirewallCommit {
  return transaction(database, () =>
    compareFirewallCheck(database, completion, "outgoing", canonicalCandidate),
  );
}

/**
 * Whether an admitted gather operation's check authorizes a request post with
 * exactly this content. A post intent binds against it in the caller's
 * transaction.
 */
export function admittedOperation(
  database: DatabaseSync,
  operation: Pick<FirewallAttempt, "checkId" | "canonicalCandidate">,
): boolean {
  const row = database
    .prepare(
      "SELECT direction, disposition, canonical_candidate FROM firewall_checks WHERE check_id = ?",
    )
    .get(operation.checkId);
  if (
    row === undefined ||
    readText(row, "direction") !== "outgoing" ||
    readText(row, "disposition") !== "admitted"
  ) {
    return false;
  }
  return sameBytes(
    readBytes(row, "canonical_candidate"),
    operation.canonicalCandidate,
  );
}

/** A fresh result and its exact candidate are compared inside the caller's transaction. */
export function compareFirewallCheck(
  database: DatabaseSync,
  completion: FirewallCompletion,
  direction: FirewallAttempt["direction"],
  canonicalCandidate: Uint8Array,
): FirewallCommit {
  const checked = checkingRow(
    database,
    completion,
    direction,
    canonicalCandidate,
  );
  const disposition = checkDisposition(
    staysFresh(completion, checked.revision, firewallRevision(database)),
    completion,
  );
  completeFirewallCheck(database, completion, disposition);
  return disposition;
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
  acceptedProposalId?: string,
): void {
  requireBytes(rules);
  transaction(database, () => {
    database
      .prepare(`INSERT INTO firewall_policy (singleton, canonical_rules) VALUES (1, ?)
      ON CONFLICT(singleton) DO UPDATE SET canonical_rules = excluded.canonical_rules`)
      .run(rules);
    if (acceptedProposalId !== undefined) {
      const changed = database
        .prepare(
          "UPDATE owner_proposals SET status = 'accepted' WHERE id = ? AND status = 'pending'",
        )
        .run(acceptedProposalId);
      if (changed.changes !== 1) {
        throw new StoreSignal("conflict");
      }
    }
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

/** Retained decisions accompany pending items so either decision remains idempotent after restart. */
export function readOwnerProposals(
  database: DatabaseSync,
): readonly OwnerProposal[] {
  return database
    .prepare(`SELECT id, proposed_at, canonical_request,
    canonical_removed_rules, status FROM owner_proposals ORDER BY proposed_at, rowid`)
    .all()
    .map((row) => ({
      id: readText(row, "id"),
      proposedAt: readInteger(row, "proposed_at"),
      canonicalRequest: readBytes(row, "canonical_request"),
      canonicalRemovedRules: readBytes(row, "canonical_removed_rules"),
      status: Schema.decodeUnknownSync(
        Schema.Literal("pending", "accepted", "declined"),
      )(readText(row, "status")),
    }));
}

/** Only the decision changes on an existing item; the proposed evidence stays intact. */
export function writeOwnerProposal(
  database: DatabaseSync,
  proposal: OwnerProposal,
): void {
  requireText(proposal.id);
  requireBytes(proposal.canonicalRequest);
  requireBytes(proposal.canonicalRemovedRules);
  database
    .prepare(`INSERT INTO owner_proposals
    (id, proposed_at, canonical_request, canonical_removed_rules, status)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET status = excluded.status`)
    .run(
      proposal.id,
      proposal.proposedAt,
      proposal.canonicalRequest,
      proposal.canonicalRemovedRules,
      proposal.status,
    );
}

/** A sequence cursor preserves every edit in bounded exports, including identical revisions. */
export function readFirewallActivations(
  database: DatabaseSync,
  request: { readonly since?: number; readonly after?: number },
) {
  const since = request.since ?? 0;
  const after = request.after ?? 0;
  if (
    !Number.isSafeInteger(since) ||
    since < 0 ||
    !Number.isSafeInteger(after) ||
    after < 0
  ) {
    throw new StoreSignal("invalid-input");
  }
  const order =
    request.after === undefined
      ? "activated_at DESC, sequence DESC"
      : "sequence";
  return database
    .prepare(`SELECT sequence, activated_at, active_revision,
    added_rule_ids, removed_rule_ids FROM firewall_activations
    WHERE activated_at >= ? AND sequence > ? ORDER BY ${order} LIMIT 100`)
    .all(since, after)
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
    .prepare(`SELECT rowid AS sequence, check_id, direction, revision,
    canonical_candidate, canonical_input, canonical_result, disposition, decided_at
    FROM firewall_checks WHERE decided_at >= ?
    ORDER BY decided_at DESC, rowid DESC LIMIT 100`)
    .all(since)
    .map((row) => ({
      ...auditEntry(row),
      time: readInteger(row, "decided_at"),
    }));
}

/**
 * Complete a local item's checks at the current revision, all stale when any
 * admitting one is.
 * @returns Whether the checks were fresh.
 */
function completeLocalChecks(
  database: DatabaseSync,
  admission: FirewallLocalAdmission,
): boolean {
  const revision = firewallRevision(database);
  const started = admission.completions.map((completion) => ({
    completion,
    revision: checkingRow(
      database,
      completion,
      "incoming",
      admission.queuedItem,
    ).revision,
  }));
  const fresh = started.every((check) =>
    staysFresh(check.completion, check.revision, revision),
  );
  for (const { completion } of started) {
    completeFirewallCheck(
      database,
      completion,
      checkDisposition(fresh, completion),
    );
  }
  return fresh;
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
): { readonly revision: number } {
  const row = database
    .prepare(
      "SELECT direction, revision, canonical_candidate, disposition FROM firewall_checks WHERE check_id = ?",
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
  return { revision: readInteger(row, "revision") };
}

function settleQueuedItem(
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
    revision: readInteger(row, "revision"),
    canonicalCandidate: readBytes(row, "canonical_candidate"),
    canonicalInput: readBytes(row, "canonical_input"),
    disposition: Schema.decodeUnknownSync(auditDisposition)(
      readText(row, "disposition"),
    ),
    ...(canonicalResult === undefined ? {} : { canonicalResult }),
  };
}

/**
 * Whether a check still holds at commit: a withholding check always does,
 * as does a shadow check, and an admitting one only while the evidence
 * revision it began at is current.
 */
function staysFresh(
  completion: FirewallCompletion,
  startedRevision: number,
  currentRevision: number,
): boolean {
  return (
    !completion.admit ||
    completion.shadow === true ||
    startedRevision === currentRevision
  );
}

function checkDisposition(
  fresh: boolean,
  completion: FirewallCompletion,
): FirewallCommit {
  if (!fresh) {
    return "stale";
  }
  return completion.admit ? "admitted" : "withheld";
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

/**
 * One conversation's window before a candidate. A delivery or record that
 * names no certified record has no window.
 */
function readSlice(
  database: DatabaseSync,
  range: FirewallEvidenceRange,
  maximumRecords: number,
): FirewallEvidenceSlice {
  const candidate = windowCandidate(database, range);
  if (candidate === undefined) {
    return range.beforeDelivery === undefined &&
      range.beforeRecord === undefined
      ? boundedHistory(database, {
          maximumRecords,
          beforePosition: Number.MAX_SAFE_INTEGER,
          beforeSequence: Number.MAX_SAFE_INTEGER,
          ...range,
        })
      : { history: [], overflow: false, earlierHistoryOmitted: false };
  }
  return {
    ...boundedHistory(database, {
      maximumRecords,
      beforePosition: readInteger(candidate, "position"),
      beforeSequence: readInteger(candidate, "sequence"),
      ...range,
      conversationId: readText(candidate, "conversation_id"),
    }),
    candidate: historyEntry(candidate),
  };
}

/** The certified record a range ends before, when it names one. */
function windowCandidate(
  database: DatabaseSync,
  range: FirewallEvidenceRange,
): Readonly<Record<string, unknown>> | undefined {
  if (range.beforeDelivery !== undefined) {
    return database
      .prepare(`${historySelect} WHERE d.delivery_token = ?`)
      .get(range.beforeDelivery);
  }
  return range.beforeRecord === undefined
    ? undefined
    : database
        .prepare(`${historySelect} WHERE c.record_hash = ?`)
        .get(range.beforeRecord);
}

/** A window entry with the global position that orders it among the other kind. */
interface PositionedEntry {
  readonly sequence: number;
  readonly local: boolean;
  readonly bytes: number;
  readonly entry: FirewallHistoryEntry | FirewallLocalEntry;
}

/** Where one window ends and which conversation it reads. */
interface HistoryWindow {
  readonly maximumRecords: number;
  readonly beforePosition: number;
  readonly beforeSequence: number;
  readonly conversationId?: string;
  readonly conversation?: string;
}

/**
 * The newest window of one conversation: its certified records and the local
 * evidence kept under its address, merged in certification order. A local
 * entry anchored at a certified record's position follows that record.
 * Whole entries are kept or omitted; a byte bound becomes an explicit
 * evidence gap. Both sources close on return, so a window that stops early
 * leaves no statement open to hold back the WAL checkpoint.
 */
function boundedHistory(database: DatabaseSync, window: HistoryWindow) {
  const recordSource = recordEntries(database, window);
  const localSource = localEntries(database, window);
  try {
    return mergedWindow(
      peekable(recordSource),
      peekable(localSource),
      window.maximumRecords,
    );
  } finally {
    recordSource.return(undefined);
    localSource.return(undefined);
  }
}

/**
 * Take entries newest first from both sources until the window is full or
 * its bytes exceed the inbox-item bound.
 */
function mergedWindow(
  records: Peekable,
  locals: Peekable,
  maximumRecords: number,
) {
  const history: Array<FirewallHistoryEntry | FirewallLocalEntry> = [];
  let bytes = 0;
  for (
    let next = newer(records.peek(), locals.peek());
    next !== undefined;
    next = newer(records.peek(), locals.peek())
  ) {
    if (history.length === maximumRecords) {
      return historyWindow(history, false, true);
    }
    (next.local ? locals : records).take();
    bytes += next.bytes;
    if (bytes > MAXIMUM_RUNTIME_ITEM_BYTES) {
      return historyWindow(history, true, false);
    }
    history.push(next.entry);
  }
  return historyWindow(history, false, false);
}

/**
 * A conversation's newest certified records before the window's end, newest
 * first. The conversation ordinal index bounds selection before blob reads.
 * @yields {PositionedEntry} Each record's entry and certification position.
 */
function* recordEntries(
  database: DatabaseSync,
  window: HistoryWindow,
): Generator<PositionedEntry> {
  const rows = database
    .prepare(`${historySelect}
      WHERE c.rowid IN (
        SELECT rowid FROM certified_records
        WHERE conversation_id = ? AND ordinal < ? ORDER BY ordinal DESC LIMIT ?
      ) ORDER BY c.ordinal DESC`)
    .iterate(
      window.conversationId ?? null,
      window.beforePosition,
      window.maximumRecords + 1,
    );
  for (const row of rows) {
    const entry = historyEntry(row);
    yield {
      sequence: readInteger(row, "sequence"),
      local: false,
      bytes:
        entry.canonicalRecordCore.byteLength +
        entry.canonicalMembership.byteLength,
      entry,
    };
  }
}

/**
 * The local evidence kept under the window's address before its end, newest
 * first.
 * @yields {PositionedEntry} Each local entry and the position it is anchored at.
 */
function* localEntries(
  database: DatabaseSync,
  window: HistoryWindow,
): Generator<PositionedEntry> {
  const rows = database
    .prepare(`
      SELECT anchor, canonical_entry FROM firewall_local_evidence
      WHERE conversation = ? AND anchor < ?
      ORDER BY anchor DESC, sequence DESC LIMIT ?`)
    .iterate(
      window.conversation ?? null,
      window.beforeSequence,
      window.maximumRecords + 1,
    );
  for (const row of rows) {
    const canonicalEntry = readBytes(row, "canonical_entry");
    yield {
      sequence: readInteger(row, "anchor"),
      local: true,
      bytes: canonicalEntry.byteLength,
      entry: { canonicalEntry },
    };
  }
}

/** The newer of two window candidates; a local entry follows the record at its anchor. */
function newer(
  record?: PositionedEntry,
  local?: PositionedEntry,
): PositionedEntry | undefined {
  if (record === undefined || local === undefined) {
    return record ?? local;
  }
  return local.sequence >= record.sequence ? local : record;
}

/** An iterator whose next value can be read before it is taken. */
interface Peekable {
  readonly peek: () => PositionedEntry | undefined;
  readonly take: () => void;
}

function peekable(source: Iterator<PositionedEntry>): Peekable {
  let head = source.next();
  return {
    peek: (): PositionedEntry | undefined =>
      head.done === true ? undefined : head.value,
    take: (): void => {
      head = source.next();
    },
  };
}

function historyWindow(
  history: Array<FirewallHistoryEntry | FirewallLocalEntry>,
  overflow: boolean,
  earlierHistoryOmitted: boolean,
) {
  history.reverse();
  return { history, overflow, earlierHistoryOmitted };
}

function historyEntry(
  row: Readonly<Record<string, unknown>>,
): FirewallHistoryEntry {
  return {
    canonicalRecordCore: readBytes(row, "canonical_record_core"),
    canonicalMembership: readBytes(row, "canonical_membership"),
    visible: readInteger(row, "visible") === 1,
    ...answerAdmission(row),
  };
}

/** Whether an admitted result showed or withheld a record; none for a record no result checked. */
function answerAdmission(
  row: Readonly<Record<string, unknown>>,
): Pick<FirewallHistoryEntry, "answer"> {
  if (row.answer_admitted === null) {
    return {};
  }
  return {
    answer: readInteger(row, "answer_admitted") === 1 ? "admitted" : "withheld",
  };
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

/** Revisions cover range membership and visibility, including known absences. */
function firewallRevision(database: DatabaseSync): number {
  const row = database
    .prepare("SELECT revision FROM firewall_evidence WHERE singleton = 1")
    .get();
  if (row === undefined) {
    throw new StoreSignal("corrupt");
  }
  return readInteger(row, "revision");
}

function requireQueueFrontier(
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
