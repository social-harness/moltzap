/** @file Supplies bounded evidence from protocol history, policy decisions and the retained host view. */

import type { DatabaseSync } from "node:sqlite";

import type {
  FirewallEvidence,
  FirewallEvidenceRange,
  FirewallEvidenceSlice,
  FirewallEvidenceSlices,
  FirewallHistoryEntry,
  FirewallLocalEntry,
  FirewallRequestAdmission,
} from "../../firewall/store/types.js";

import {
  readBytes,
  readInteger,
  readOptionalBytes,
  readOptionalText,
  readText,
  requireText,
  StoreSignal,
} from "../../communication/store/database/index.js";
import { MAXIMUM_RUNTIME_ITEM_BYTES } from "../../encoding/limits.js";

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

/** An iterator whose next value can be read before it is taken. */
interface Peekable {
  readonly peek: () => PositionedEntry | undefined;
  readonly take: () => void;
}

/** Incoming evidence stops strictly before the candidate's local certification position. */
export function readFirewallEvidence(
  database: DatabaseSync,
  input: FirewallEvidenceRange & { readonly maximumRecords: number },
): FirewallEvidence {
  const { slices } = readFirewallEvidenceSlices(database, {
    ranges: [
      {
        beforeDelivery: input.beforeDelivery,
        beforeRecord: input.beforeRecord,
        conversationId: input.conversationId,
        conversation: input.conversation,
      },
    ],
    maximumRecords: input.maximumRecords,
  });
  const [slice] = slices;
  if (slice === undefined) {
    throw new StoreSignal("corrupt");
  }
  return slice;
}

/**
 * Several windows read in one synchronous capture, so the checks of one result's texts
 * use the same captured context.
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
  const slices = input.ranges.map((range) =>
    readSlice(database, range, input.maximumRecords),
  );
  return { slices };
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
      ? {
          pendingOutgoing:
            range.conversationId !== undefined &&
            unresolvedSend(database, range.conversationId),
          ...boundedHistory(database, {
            maximumRecords,
            beforePosition: Number.MAX_SAFE_INTEGER,
            beforeSequence: Number.MAX_SAFE_INTEGER,
            ...range,
          }),
        }
      : {
          pendingOutgoing: false,
          history: [],
          overflow: false,
          earlierHistoryOmitted: false,
        };
  }
  const conversationId = readText(candidate, "conversation_id");
  return {
    pendingOutgoing: unresolvedSend(database, conversationId),
    ...boundedHistory(database, {
      maximumRecords,
      beforePosition: readInteger(candidate, "position"),
      beforeSequence: readInteger(candidate, "sequence"),
      ...range,
      conversationId,
    }),
    candidate: historyEntry(candidate),
  };
}

function unresolvedSend(
  database: DatabaseSync,
  conversationId: string,
): boolean {
  return (
    database
      .prepare(
        "SELECT 1 AS pending FROM message_intents WHERE conversation_id = ? AND completed_record_hash IS NULL LIMIT 1",
      )
      .get(conversationId) !== undefined
  );
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
