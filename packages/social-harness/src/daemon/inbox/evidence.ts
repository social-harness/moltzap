/** @file Supplies bounded evidence from protocol history, policy decisions and the retained host view. */

import * as SqlClient from "@effect/sql/SqlClient";
import { Effect } from "effect";
import type {
  FirewallEvidence,
  FirewallEvidenceRange,
  FirewallEvidenceSlice,
  FirewallEvidenceSlices,
  FirewallHistoryEntry,
  FirewallLocalEntry,
  FirewallRequestAdmission,
} from "../../firewall/store/types.js";
import type { Ed25519PublicKey } from "../../identity/keys.js";
import { readRecentMessages } from "../../communication/conversations/index.js";
import {
  EndpointStoreError,
  readBytes,
  readInteger,
  readOptionalBytes,
  readOptionalText,
  readText,
  requireText,
  storeOperation,
  transaction,
} from "../../communication/store/database/index.js";
import { MAXIMUM_RUNTIME_ITEM_BYTES } from "../../encoding/limits.js";
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
  readonly registrySignerPublicKey: Ed25519PublicKey;
  readonly candidateRecordHash?: string;
  readonly conversationId?: string;
  readonly conversation?: string;
}
/** An iterator whose next value can be read before it is taken. */
interface Peekable {
  readonly peek: () => PositionedEntry | undefined;
  readonly take: () => void;
}
/** Evidence captures recent conversation history when assessment begins. */
export function readFirewallEvidence(
  input: FirewallEvidenceRange & {
    readonly maximumRecords: number;
    readonly registrySignerPublicKey: Ed25519PublicKey;
  },
): Effect.Effect<FirewallEvidence, EndpointStoreError, SqlClient.SqlClient> {
  return Effect.gen(function* () {
    const { slices } = yield* readFirewallEvidenceSlices({
      ranges: [
        {
          candidateDelivery: input.candidateDelivery,
          candidateRecord: input.candidateRecord,
          conversationId: input.conversationId,
          conversation: input.conversation,
        },
      ],
      maximumRecords: input.maximumRecords,
      registrySignerPublicKey: input.registrySignerPublicKey,
    });
    const [slice] = slices;
    if (slice === undefined) {
      return yield* new EndpointStoreError({ reason: "corrupt" });
    }
    return slice;
  }).pipe(storeOperation, Effect.withSpan("readFirewallEvidence"));
}
/** A transaction gives every text of one result the same captured evidence. */
export function readFirewallEvidenceSlices(input: {
  readonly ranges: readonly FirewallEvidenceRange[];
  readonly maximumRecords: number;
  readonly registrySignerPublicKey: Ed25519PublicKey;
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
      ) {
        return yield* new EndpointStoreError({ reason: "invalid-input" });
      }
      const slices = yield* Effect.forEach(
        input.ranges,
        (range) =>
          readSlice(range, input.maximumRecords, input.registrySignerPublicKey),
        { concurrency: 1 },
      );
      return { slices };
    }),
  ).pipe(Effect.withSpan("readFirewallEvidenceSlices"));
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
  }).pipe(storeOperation, Effect.withSpan("readFirewallRequestAdmission"));
}
/**
 * One conversation's recent window, excluding its candidate. A delivery or record that
 * names no certified record has no window.
 */
function readSlice(
  range: FirewallEvidenceRange,
  maximumRecords: number,
  registrySignerPublicKey: Ed25519PublicKey,
): Effect.Effect<
  FirewallEvidenceSlice,
  EndpointStoreError,
  SqlClient.SqlClient
> {
  return Effect.gen(function* () {
    const candidate = yield* windowCandidate(range);
    if (candidate === undefined) {
      return range.candidateDelivery === undefined &&
        range.candidateRecord === undefined
        ? {
            pendingOutgoing:
              range.conversationId !== undefined &&
              (yield* unresolvedSend(range.conversationId)),
            ...(yield* boundedHistory({
              maximumRecords,
              registrySignerPublicKey,
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
        registrySignerPublicKey,
        candidateRecordHash: readText(candidate, "record_hash"),
        ...range,
        conversationId,
      })),
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
    if (range.candidateDelivery !== undefined) {
      return (yield* database.unsafe<Readonly<Record<string, unknown>>>(
        "SELECT c.conversation_id,c.record_hash FROM pending_deliveries d JOIN certified_records c ON c.conversation_id=d.conversation_id AND c.record_hash=d.record_hash WHERE d.delivery_token=?",
        [range.candidateDelivery],
      ))[0];
    }
    return range.candidateRecord === undefined
      ? undefined
      : (yield* database.unsafe<Readonly<Record<string, unknown>>>(
          "SELECT conversation_id,record_hash FROM certified_records WHERE record_hash=?",
          [range.candidateRecord],
        ))[0];
  }).pipe(storeOperation);
}
/** Both evidence sources are bounded before their saved payloads are decoded. */
function boundedHistory(window: HistoryWindow) {
  return Effect.gen(function* () {
    const records = yield* recordEntries(window);
    const locals = yield* localEntries(window);
    return {
      ...mergedWindow(
        peekable(records.entries[Symbol.iterator]()),
        peekable(locals[Symbol.iterator]()),
        window.maximumRecords,
      ),
      ...(records.candidate === undefined
        ? {}
        : { candidate: records.candidate }),
    };
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
/** Communication verifies the bounded recent messages before policy reads them. */
function recordEntries(window: HistoryWindow) {
  return Effect.gen(function* () {
    if (window.conversationId === undefined) {
      return { entries: [], candidate: undefined };
    }
    const messages = yield* readRecentMessages({
      registrySignerPublicKey: window.registrySignerPublicKey,
      conversationId: window.conversationId,
      maximumRecords: window.maximumRecords,
      ...(window.candidateRecordHash === undefined
        ? {}
        : { candidateRecordHash: window.candidateRecordHash }),
    });
    const entries = yield* Effect.forEach(
      messages,
      (entry) =>
        Effect.gen(function* () {
          return {
            sequence: entry.sequence,
            local: false,
            bytes: entry.bytes,
            recordHash: entry.recordHash,
            entry: yield* messageVisibility(entry),
          } satisfies PositionedEntry & { readonly recordHash: string };
        }),
      { concurrency: 1 },
    );
    return {
      entries: entries.filter(
        (entry) => entry.recordHash !== window.candidateRecordHash,
      ),
      candidate: entries.find(
        (entry) => entry.recordHash === window.candidateRecordHash,
      )?.entry,
    };
  });
}
function messageVisibility(
  entry: Effect.Effect.Success<ReturnType<typeof readRecentMessages>>[number],
) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const row = (yield* sql.unsafe<Readonly<Record<string, unknown>>>(
      "SELECT EXISTS(SELECT 1 FROM pending_deliveries d JOIN runtime_inbox i ON i.delivery_token=d.delivery_token WHERE d.record_hash=?) AS visible,(SELECT admitted FROM firewall_answers WHERE record_hash=?) AS answer_admitted",
      [entry.recordHash, entry.recordHash],
    ))[0];
    if (row === undefined) {
      return yield* new EndpointStoreError({ reason: "corrupt" });
    }
    return {
      message: entry.message,
      visible: readInteger(row, "visible") === 1,
      ...answerAdmission(row),
    } satisfies FirewallHistoryEntry;
  }).pipe(storeOperation);
}
/** Reads local result evidence under the same conversation window and bound. */
function localEntries(window: HistoryWindow) {
  return Effect.gen(function* () {
    const database = yield* SqlClient.SqlClient;
    const rows = yield* database.unsafe<Readonly<Record<string, unknown>>>(
      "SELECT anchor,canonical_entry FROM firewall_local_evidence WHERE conversation=? ORDER BY anchor DESC,sequence DESC LIMIT ?",
      [window.conversation ?? null, window.maximumRecords + 1],
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
