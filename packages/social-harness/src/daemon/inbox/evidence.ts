/** @file The daemon combines verified recent messages with its saved host visibility and result history. */

import * as SqlClient from "@effect/sql/SqlClient";
import { Effect } from "effect";
import type { Ed25519PublicKey } from "../../identity/keys.js";
import type {
  FirewallEvidenceRange,
  FirewallEvidenceSlices,
  FirewallHistoryEntry,
  FirewallLocalEntry,
} from "./types.js";
import { readRecentMessages } from "../../communication/conversations/index.js";
import { messageMembers } from "../../communication/message.js";
import { deriveConversationId } from "../../communication/records/index.js";
import {
  EndpointStoreError,
  readBytes,
  readInteger,
  storeOperation,
  transaction,
} from "../../communication/store/database/index.js";
import { compareAgentIds } from "../../encoding/identifier.js";
import { MAXIMUM_RUNTIME_ITEM_BYTES } from "../../encoding/limits.js";

interface PositionedEntry {
  readonly sequence: number;
  readonly local: boolean;
  readonly bytes: number;
  readonly entry: FirewallHistoryEntry | FirewallLocalEntry;
}
interface Peekable {
  readonly peek: () => PositionedEntry | undefined;
  readonly take: () => void;
}
interface HistoryWindow extends FirewallEvidenceRange {
  readonly maximumRecords: number;
  readonly registrySignerPublicKey: Ed25519PublicKey;
}

/** A candidate is excluded by author and message id while assessment sees the latest history. */
export function readFirewallEvidence(input: HistoryWindow) {
  return readFirewallEvidenceSlices({ ...input, ranges: [input] }).pipe(
    Effect.flatMap(({ slices }) =>
      slices[0] === undefined
        ? new EndpointStoreError({ reason: "corrupt" })
        : Effect.succeed(slices[0]),
    ),
    Effect.withSpan("readFirewallEvidence"),
  );
}

/** One transaction captures all result texts against the same durable history. */
export function readFirewallEvidenceSlices(input: {
  readonly ranges: readonly FirewallEvidenceRange[];
  readonly maximumRecords: number;
  readonly registrySignerPublicKey: Ed25519PublicKey;
}) {
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
          readSlice({
            ...range,
            maximumRecords: input.maximumRecords,
            registrySignerPublicKey: input.registrySignerPublicKey,
          }),
        { concurrency: 1 },
      );
      return { slices } satisfies FirewallEvidenceSlices;
    }),
  ).pipe(Effect.withSpan("readFirewallEvidenceSlices"));
}

function readSlice(window: HistoryWindow) {
  return Effect.gen(function* () {
    const conversationId =
      window.conversationId ??
      (window.message === undefined
        ? undefined
        : yield* conversationOf(window.message));
    const records = yield* recordEntries({
      ...window,
      ...(conversationId === undefined ? {} : { conversationId }),
    });
    const locals = yield* localEntries(window);
    return {
      pendingOutgoing:
        conversationId === undefined
          ? false
          : yield* unresolvedSend(conversationId),
      ...mergedWindow(
        peekable(records[Symbol.iterator]()),
        peekable(locals[Symbol.iterator]()),
        window.maximumRecords,
      ),
    };
  }).pipe(storeOperation);
}

function conversationOf(
  message: NonNullable<FirewallEvidenceRange["message"]>,
) {
  const [first, second, ...rest] = messageMembers(message)
    .map((member) => member.agentId)
    .sort(compareAgentIds);
  return first === undefined || second === undefined
    ? Effect.fail(new EndpointStoreError({ reason: "corrupt" }))
    : deriveConversationId([first, second, ...rest]).pipe(
        Effect.catchTag(
          "ClientRepresentationError",
          () => new EndpointStoreError({ reason: "corrupt" }),
        ),
      );
}

function unresolvedSend(conversationId: string) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return (
      (yield* sql.unsafe<Readonly<Record<string, unknown>>>(
        "SELECT 1 AS pending FROM message_intents WHERE conversation_id=? AND completed_record_hash IS NULL LIMIT 1",
        [conversationId],
      ))[0] !== undefined
    );
  }).pipe(storeOperation);
}

/** Communication verifies the bounded messages before the host attaches local visibility. */
function recordEntries(window: HistoryWindow) {
  return Effect.gen(function* () {
    if (window.conversationId === undefined) {
      return [];
    }
    const messages = yield* readRecentMessages({
      registrySignerPublicKey: window.registrySignerPublicKey,
      conversationId: window.conversationId,
      maximumRecords: window.maximumRecords + 1,
    });
    return yield* Effect.forEach(
      messages
        .filter(
          (entry) =>
            entry.message.author.agentId !== window.message?.author.agentId ||
            entry.message.msgId !== window.message?.msgId,
        )
        .slice(0, window.maximumRecords + 1),
      (entry) =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const row = (yield* sql.unsafe<Readonly<Record<string, unknown>>>(
            "SELECT admitted FROM message_visibility WHERE author_agent_id=? AND msg_id=?",
            [entry.message.author.agentId, entry.message.msgId],
          ))[0];
          return {
            sequence: entry.sequence,
            local: false,
            bytes: entry.bytes,
            entry: {
              message: entry.message,
              visible: row !== undefined && readInteger(row, "admitted") === 1,
            },
          } satisfies PositionedEntry;
        }),
      { concurrency: 1 },
    );
  });
}

/** Local results remain in the host view that was saved when they were presented. */
function localEntries(window: HistoryWindow) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql.unsafe<Readonly<Record<string, unknown>>>(
      "SELECT anchor,canonical_entry FROM local_history WHERE conversation=? ORDER BY anchor DESC,sequence DESC LIMIT ?",
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
