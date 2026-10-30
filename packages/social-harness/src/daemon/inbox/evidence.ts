/** @file Supplies bounded evidence from protocol history, policy decisions and the retained host view. */

import * as SqlClient from "@effect/sql/SqlClient";
import { Effect } from "effect";
import {
  EndpointStoreError,
  storeOperation,
} from "../../communication/store/database/index.js";

import {
  readBytes,
  readInteger,
  readOptionalBytes,
  readOptionalText,
  readText,
  requireText,
  transaction,
} from "../../communication/store/database/index.js";
import { MAXIMUM_RUNTIME_ITEM_BYTES } from "../../encoding/limits.js";
import type {
  FirewallEvidence,
  FirewallEvidenceRange,
  FirewallEvidenceSlice,
  FirewallEvidenceSlices,
  FirewallHistoryEntry,
  FirewallLocalEntry,
  FirewallRequestAdmission,
} from "../../firewall/store/types.js";
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
  input: FirewallEvidenceRange & {
    readonly maximumRecords: number;
  },
): Effect.Effect<FirewallEvidence, EndpointStoreError, SqlClient.SqlClient> {
  return Effect.gen(function* () {
    const { slices } = yield* readFirewallEvidenceSlices({
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
      return yield* new EndpointStoreError({ reason: "corrupt" });
    }
    return slice;
  }).pipe(storeOperation);
}
/** A transaction gives every text of one result the same captured evidence. */
export function readFirewallEvidenceSlices(input: {
  readonly ranges: readonly FirewallEvidenceRange[];
  readonly maximumRecords: number;
}): Effect.Effect<
  FirewallEvidenceSlices,
  EndpointStoreError,
  SqlClient.SqlClient
> {
  return transaction(
    Effect.gen(function* () {
      if (
        !Number.isSafeInteger(input.maximumRecords) ||
        input.maximumRecords < 1 ||
        input.maximumRecords > 1024
      )
        return yield* new EndpointStoreError({ reason: "invalid-input" });
      const slices = yield* Effect.forEach(input.ranges, (range) =>
        readSlice(range, input.maximumRecords),
      );
      return { slices };
    }),
  );
}
/**
 * How a received request's admission settled, read by its certified record.
 * The runtime was shown it when it reached the inbox; the check that decided
 * is the one its queue entry commits.
 */
export function readFirewallRequestAdmission(
  recordHash: string,
): Effect.Effect<
  FirewallRequestAdmission | undefined,
  EndpointStoreError,
  SqlClient.SqlClient
> {
  return Effect.gen(function* () {
    const database = yield* SqlClient.SqlClient;
    requireText(recordHash);
    const row = (yield* database.unsafe<Readonly<Record<string, unknown>>>(
      `
      SELECT i.delivery_token AS presented, f.check_id, k.canonical_result
      FROM pending_deliveries d
      LEFT JOIN runtime_inbox i ON i.delivery_token = d.delivery_token
      LEFT JOIN firewall_incoming f ON f.delivery_token = d.delivery_token
      LEFT JOIN firewall_checks k ON k.check_id = f.check_id
      WHERE d.record_hash = ?
    `,
      [recordHash],
    ))[0];
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
  }).pipe(storeOperation);
}
/**
 * One conversation's window before a candidate. A delivery or record that
 * names no certified record has no window.
 */
function readSlice(
  range: FirewallEvidenceRange,
  maximumRecords: number,
): Effect.Effect<
  FirewallEvidenceSlice,
  EndpointStoreError,
  SqlClient.SqlClient
> {
  return Effect.gen(function* () {
    const candidate = yield* windowCandidate(range);
    if (candidate === undefined) {
      return range.beforeDelivery === undefined &&
        range.beforeRecord === undefined
        ? {
            pendingOutgoing:
              range.conversationId !== undefined &&
              (yield* unresolvedSend(range.conversationId)),
            ...(yield* boundedHistory({
              maximumRecords,
              beforePosition: Number.MAX_SAFE_INTEGER,
              beforeSequence: Number.MAX_SAFE_INTEGER,
              ...range,
            })),
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
      pendingOutgoing: yield* unresolvedSend(conversationId),
      ...(yield* boundedHistory({
        maximumRecords,
        beforePosition: readInteger(candidate, "position"),
        beforeSequence: readInteger(candidate, "sequence"),
        ...range,
        conversationId,
      })),
      candidate: historyEntry(candidate),
    };
  }).pipe(storeOperation);
}
function unresolvedSend(
  conversationId: string,
): Effect.Effect<boolean, EndpointStoreError, SqlClient.SqlClient> {
  return Effect.gen(function* () {
    const database = yield* SqlClient.SqlClient;
    return (
      (yield* database.unsafe<Readonly<Record<string, unknown>>>(
        "SELECT 1 AS pending FROM message_intents WHERE conversation_id = ? AND completed_record_hash IS NULL LIMIT 1",
        [conversationId],
      ))[0] !== undefined
    );
  }).pipe(storeOperation);
}
/** The certified record a range ends before, when it names one. */
function windowCandidate(
  range: FirewallEvidenceRange,
): Effect.Effect<
  Readonly<Record<string, unknown>> | undefined,
  EndpointStoreError,
  SqlClient.SqlClient
> {
  return Effect.gen(function* () {
    const database = yield* SqlClient.SqlClient;
    if (range.beforeDelivery !== undefined) {
      return (yield* database.unsafe<Readonly<Record<string, unknown>>>(
        `${historySelect} WHERE d.delivery_token = ?`,
        [range.beforeDelivery],
      ))[0];
    }
    return range.beforeRecord === undefined
      ? undefined
      : (yield* database.unsafe<Readonly<Record<string, unknown>>>(
          `${historySelect} WHERE c.record_hash = ?`,
          [range.beforeRecord],
        ))[0];
  }).pipe(storeOperation);
}
/** Both evidence sources are bounded before their saved payloads are decoded. */
function boundedHistory(window: HistoryWindow) {
  return Effect.gen(function* () {
    const records = yield* recordEntries(window);
    const locals = yield* localEntries(window);
    return mergedWindow(
      peekable(records[Symbol.iterator]()),
      peekable(locals[Symbol.iterator]()),
      window.maximumRecords,
    );
  }).pipe(storeOperation);
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
/** Selects only the newest bounded certified prefix before reading its payloads. */
function recordEntries(window: HistoryWindow) {
  return Effect.gen(function* () {
    const database = yield* SqlClient.SqlClient;
    const rows = yield* database.unsafe<Readonly<Record<string, unknown>>>(
      historySelect +
        " WHERE c.rowid IN (SELECT rowid FROM certified_records WHERE conversation_id=? AND ordinal<? ORDER BY ordinal DESC LIMIT ?) ORDER BY c.ordinal DESC",
      [
        window.conversationId ?? null,
        window.beforePosition,
        window.maximumRecords + 1,
      ],
    );
    return rows.map((row): PositionedEntry => {
      const entry = historyEntry(row);
      return {
        sequence: readInteger(row, "sequence"),
        local: false,
        bytes:
          entry.canonicalRecordCore.byteLength +
          entry.canonicalMembership.byteLength,
        entry,
      };
    });
  }).pipe(storeOperation);
}
/** Reads local result evidence under the same conversation window and bound. */
function localEntries(window: HistoryWindow) {
  return Effect.gen(function* () {
    const database = yield* SqlClient.SqlClient;
    const rows = yield* database.unsafe<Readonly<Record<string, unknown>>>(
      "SELECT anchor,canonical_entry FROM firewall_local_evidence WHERE conversation=? AND anchor<? ORDER BY anchor DESC,sequence DESC LIMIT ?",
      [
        window.conversation ?? null,
        window.beforeSequence,
        window.maximumRecords + 1,
      ],
    );
    return rows.map((row): PositionedEntry => {
      const canonicalEntry = readBytes(row, "canonical_entry");
      return {
        sequence: readInteger(row, "anchor"),
        local: true,
        bytes: canonicalEntry.byteLength,
        entry: { canonicalEntry },
      };
    });
  }).pipe(storeOperation);
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
