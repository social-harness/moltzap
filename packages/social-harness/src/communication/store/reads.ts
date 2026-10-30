/** @file Recovery and frozen local management reads over certified history. */

import * as SqlClient from "@effect/sql/SqlClient";
import { Effect, Schema } from "effect";
import { EndpointStoreError, storeOperation } from "./database/index.js";

import {
  readBytes,
  readInteger,
  readOptionalText,
  readText,
  StoreSignal,
  transaction,
} from "./database/index.js";
import {
  readPendingDissemination,
  readPendingOutbound,
  readRetainedDeliveries,
} from "./queues/index.js";
import {
  readCertifiedRecord,
  readConversationPosition,
  readProposalLock,
  readProtocolEvidence,
  readRecoveredReanchor,
  readStagedRecord,
  readStoredIdentity,
} from "./rows/index.js";
import type {
  CertifiedRecord,
  ConversationPage,
  EndpointRecovery,
  HistoryPage,
  MessageIntent,
  StoredAnchor,
  StoredMembership,
} from "./types.js";
const HISTORY_PAGE_SIZE = 50;
const historySelect = `
  SELECT staged.conversation_id, staged.record_hash,
         staged.previous_record_hash, staged.membership_hash,
         staged.anchor_hash, staged.action_hash, staged.author_agent_id,
         staged.msg_id, staged.canonical_record_core
  FROM certified_records AS certified
  JOIN staged_records AS staged
    ON staged.conversation_id = certified.conversation_id
   AND staged.record_hash = certified.record_hash
`;
/**
 * Lists locally certified conversation identifiers in canonical order.
 *
 * @param input Optional exclusive canonical lower bound.
 * @returns At most fifty identifiers and whether more remain.
 */
export function searchStoredConversations(
  input: Readonly<{
    afterConversationId?: string;
  }>,
): Effect.Effect<ConversationPage, EndpointStoreError, SqlClient.SqlClient> {
  return Effect.gen(function* () {
    const rows = yield* readConversationIdRows(input.afterConversationId);
    const conversationIds = rows
      .slice(0, HISTORY_PAGE_SIZE)
      .map((row) => readText(row, "conversation_id"));
    return Object.freeze({
      conversationIds: Object.freeze(conversationIds),
      hasMore: rows.length > HISTORY_PAGE_SIZE,
    });
  }).pipe(storeOperation);
}
/* eslint-disable agent-code-guard/no-conditional-chaining -- Omission selects all conversations consistently across the SQL readers; a supplied id restricts each read to the same conversation. */
/**
 * Recovers all durable endpoint state needed to resume protocol work.
 *
 * @param conversationId Restrict protocol rows to one conversation when provided.
 * @returns A detached snapshot of the selected durable endpoint protocol state.
 */
export function recoverStoredState(
  conversationId?: string,
): Effect.Effect<EndpointRecovery, EndpointStoreError, SqlClient.SqlClient> {
  return Effect.gen(function* () {
    const database = yield* SqlClient.SqlClient;
    const identity = yield* readStoredIdentity();
    return Object.freeze({
      ...(identity === undefined ? {} : { identity }),
      messageIntents: yield* readMessageIntents(conversationId),
      memberships: yield* readMemberships(conversationId),
      anchors: yield* readAnchors(conversationId),
      positions: yield* readPositions(conversationId),
      proposalLocks: Object.freeze(
        (yield* database.unsafe<Readonly<Record<string, unknown>>>(
          `SELECT conversation_id, previous_record_hash, action_hash,
                  canonical_action_core
           FROM proposal_locks ${conversationId === undefined ? "" : "WHERE conversation_id = ?"} ORDER BY conversation_id, predecessor_key`,
          [...(conversationId === undefined ? [] : [conversationId])],
        )).map(readProposalLock),
      ),
      stagedRecords: Object.freeze(
        (yield* database.unsafe<Readonly<Record<string, unknown>>>(
          `SELECT conversation_id, record_hash, previous_record_hash,
                  membership_hash, anchor_hash, action_hash, author_agent_id,
                  msg_id, canonical_record_core
           FROM staged_records ${conversationId === undefined ? "" : "WHERE conversation_id = ?"} ORDER BY conversation_id, rowid`,
          [...(conversationId === undefined ? [] : [conversationId])],
        )).map(readStagedRecord),
      ),
      evidence: yield* readEvidence(conversationId),
      certifiedRecords: yield* readAllCertifiedRecords(conversationId),
      stagedReanchors: yield* readReanchors(conversationId),
      pendingDeliveries: yield* readRetainedDeliveries(conversationId),
      disseminationObligations: yield* readPendingDissemination(conversationId),
      outboundMessages: yield* readPendingOutbound(conversationId),
    });
  }).pipe(storeOperation);
}
/* eslint-enable agent-code-guard/no-conditional-chaining -- Other reads resolve their own optional inputs. */
function readPositions(conversationId?: string) {
  return Effect.gen(function* () {
    const database = yield* SqlClient.SqlClient;
    return Object.freeze(
      (yield* database.unsafe<Readonly<Record<string, unknown>>>(
        `SELECT conversation_id, membership_hash, current_anchor_hash,
                  head_record_hash FROM conversation_state
           ${conversationId === undefined ? "" : "WHERE conversation_id = ?"}
           ORDER BY conversation_id`,
        [...(conversationId === undefined ? [] : [conversationId])],
      )).map(readConversationPosition),
    );
  }).pipe(storeOperation);
}
function readConversationIdRows(
  afterConversationId?: string,
): Effect.Effect<
  ReadonlyArray<Readonly<Record<string, unknown>>>,
  EndpointStoreError,
  SqlClient.SqlClient
> {
  return Effect.gen(function* () {
    const database = yield* SqlClient.SqlClient;
    if (afterConversationId === undefined) {
      return yield* database.unsafe<Readonly<Record<string, unknown>>>(
        `SELECT conversation_id FROM conversation_state
         WHERE head_record_hash IS NOT NULL
         ORDER BY conversation_id COLLATE BINARY LIMIT 51`,
        [],
      );
    }
    if (
      afterConversationId.length === 0 ||
      afterConversationId.includes("\u0000")
    ) {
      return yield* new EndpointStoreError({ reason: "invalid-input" });
    }
    return yield* database.unsafe<Readonly<Record<string, unknown>>>(
      `SELECT conversation_id FROM conversation_state
       WHERE head_record_hash IS NOT NULL AND conversation_id > ?
       ORDER BY conversation_id COLLATE BINARY LIMIT 51`,
      [afterConversationId],
    );
  }).pipe(storeOperation);
}
function readMessageIntents(
  conversationId?: string,
): Effect.Effect<
  readonly MessageIntent[],
  EndpointStoreError,
  SqlClient.SqlClient
> {
  return Effect.gen(function* () {
    const database = yield* SqlClient.SqlClient;
    return Object.freeze(
      (yield* database.unsafe<Readonly<Record<string, unknown>>>(
        `SELECT conversation_id, membership_hash, author_agent_id, msg_id,
                canonical_intent, completed_record_hash
         FROM message_intents ${conversationId === undefined ? "" : "WHERE conversation_id = ?"} ORDER BY author_agent_id, msg_id`,
        [...(conversationId === undefined ? [] : [conversationId])],
      )).map((row) => {
        const completedRecordHash = readOptionalText(
          row,
          "completed_record_hash",
        );
        return Object.freeze({
          conversationId: readText(row, "conversation_id"),
          membershipHash: readText(row, "membership_hash"),
          authorAgentId: readText(row, "author_agent_id"),
          msgId: readText(row, "msg_id"),
          canonicalIntent: readBytes(row, "canonical_intent"),
          ...(completedRecordHash === undefined ? {} : { completedRecordHash }),
        });
      }),
    );
  }).pipe(storeOperation);
}
function readMemberships(
  conversationId?: string,
): Effect.Effect<
  readonly StoredMembership[],
  EndpointStoreError,
  SqlClient.SqlClient
> {
  return Effect.gen(function* () {
    const database = yield* SqlClient.SqlClient;
    return Object.freeze(
      (yield* database.unsafe<Readonly<Record<string, unknown>>>(
        `SELECT conversation_id, membership_hash, canonical_membership
         FROM memberships ${conversationId === undefined ? "" : "WHERE conversation_id = ?"} ORDER BY conversation_id`,
        [...(conversationId === undefined ? [] : [conversationId])],
      )).map((row) =>
        Object.freeze({
          conversationId: readText(row, "conversation_id"),
          membershipHash: readText(row, "membership_hash"),
          canonicalMembership: readBytes(row, "canonical_membership"),
        }),
      ),
    );
  }).pipe(storeOperation);
}
function readAnchors(
  conversationId?: string,
): Effect.Effect<
  readonly StoredAnchor[],
  EndpointStoreError,
  SqlClient.SqlClient
> {
  return Effect.gen(function* () {
    const database = yield* SqlClient.SqlClient;
    return Object.freeze(
      (yield* database.unsafe<Readonly<Record<string, unknown>>>(
        `SELECT conversation_id, anchor_hash, previous_anchor_hash,
                selected_record_hash, canonical_anchor
         FROM anchors ${conversationId === undefined ? "" : "WHERE conversation_id = ?"} ORDER BY conversation_id, rowid`,
        [...(conversationId === undefined ? [] : [conversationId])],
      )).map((row) => {
        const previousAnchorHash = readOptionalText(
          row,
          "previous_anchor_hash",
        );
        const selectedRecordHash = readOptionalText(
          row,
          "selected_record_hash",
        );
        return Object.freeze({
          conversationId: readText(row, "conversation_id"),
          anchorHash: readText(row, "anchor_hash"),
          ...(previousAnchorHash === undefined ? {} : { previousAnchorHash }),
          ...(selectedRecordHash === undefined ? {} : { selectedRecordHash }),
          canonicalAnchor: readBytes(row, "canonical_anchor"),
        });
      }),
    );
  }).pipe(storeOperation);
}
function readEvidence(conversationId?: string) {
  return Effect.gen(function* () {
    const database = yield* SqlClient.SqlClient;
    return Object.freeze(
      (yield* database.unsafe<Readonly<Record<string, unknown>>>(
        `SELECT conversation_id, evidence_kind, subject_id,
                evidence_key, canonical_evidence
         FROM protocol_evidence
         ${conversationId === undefined ? "" : "WHERE conversation_id = ?"}
         ORDER BY conversation_id, evidence_kind, subject_id, evidence_key`,
        [...(conversationId === undefined ? [] : [conversationId])],
      )).map(readProtocolEvidence),
    );
  }).pipe(storeOperation);
}
function readAllCertifiedRecords(
  conversationId?: string,
): Effect.Effect<
  readonly CertifiedRecord[],
  EndpointStoreError,
  SqlClient.SqlClient
> {
  return Effect.gen(function* () {
    const database = yield* SqlClient.SqlClient;
    return Object.freeze(
      yield* Effect.forEach(
        yield* database.unsafe<Readonly<Record<string, unknown>>>(
          `${historySelect}
         ${conversationId === undefined ? "" : "WHERE certified.conversation_id = ?"}
         ORDER BY certified.conversation_id, certified.ordinal`,
          [...(conversationId === undefined ? [] : [conversationId])],
        ),
        (row) => readCertifiedRecord(row),
      ),
    );
  }).pipe(storeOperation);
}
function readReanchors(conversationId?: string) {
  return Effect.gen(function* () {
    const database = yield* SqlClient.SqlClient;
    return Object.freeze(
      (yield* database.unsafe<Readonly<Record<string, unknown>>>(
        `SELECT conversation_id, anchor_hash, previous_anchor_hash,
                router_instance_id, selected_record_hash, canonical_body,
                canonical_completed_reanchor
         FROM reanchors ${conversationId === undefined ? "" : "WHERE conversation_id = ?"} ORDER BY conversation_id, rowid`,
        [...(conversationId === undefined ? [] : [conversationId])],
      )).map(readRecoveredReanchor),
    );
  }).pipe(storeOperation);
}
/** History continuations identify immutable positions without retaining a live read session. */
export const HistoryContinuation = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(4096),
);
const historyCursor = Schema.Struct({
  conversationId: Schema.NonEmptyString,
  afterRecordHash: Schema.NonEmptyString,
  throughRecordHash: Schema.NonEmptyString,
});
const encodeCursor = Schema.encodeSync(Schema.parseJson(historyCursor));
const decodeCursor = Schema.decodeUnknown(Schema.parseJson(historyCursor), {
  onExcessProperty: "error",
});
/** Pages stop at the original certified head and can be replayed after restart. */
export function readStoredConversation(
  request:
    | Readonly<{
        conversationId: string;
        afterRecordHash?: string;
      }>
    | Readonly<{
        continuation: string;
      }>,
): Effect.Effect<HistoryPage, EndpointStoreError, SqlClient.SqlClient> {
  return transaction(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const resumed =
        "continuation" in request
          ? yield* decodeHistoryCursor(request.continuation)
          : undefined;
      const conversationId =
        resumed?.conversationId ??
        ("conversationId" in request ? request.conversationId : "");
      if (conversationId.length === 0)
        return yield* new EndpointStoreError({ reason: "invalid-input" });
      const heads = yield* sql.unsafe<Readonly<Record<string, unknown>>>(
        "SELECT record_hash,ordinal FROM certified_records WHERE conversation_id=? ORDER BY ordinal DESC LIMIT 1",
        [conversationId],
      );
      const head = heads[0];
      if (head === undefined)
        return yield* new EndpointStoreError({
          reason: resumed === undefined ? "not-found" : "invalid-continuation",
        });
      const throughRecordHash =
        resumed?.throughRecordHash ?? readText(head, "record_hash");
      const through = yield* historyPosition(
        conversationId,
        throughRecordHash,
        resumed !== undefined,
      );
      const afterRecordHash =
        resumed?.afterRecordHash ??
        ("afterRecordHash" in request ? request.afterRecordHash : undefined);
      const after =
        afterRecordHash === undefined
          ? -1
          : yield* historyPosition(
              conversationId,
              afterRecordHash,
              resumed !== undefined,
            );
      if (after > through)
        return yield* new EndpointStoreError({
          reason: "invalid-continuation",
        });
      const rows = yield* sql.unsafe<Readonly<Record<string, unknown>>>(
        historySelect +
          " WHERE certified.conversation_id=? AND certified.ordinal>? AND certified.ordinal<=? ORDER BY certified.ordinal LIMIT ?",
        [conversationId, after, through, HISTORY_PAGE_SIZE + 1],
      );
      const selected = rows.slice(0, HISTORY_PAGE_SIZE);
      const records = yield* Effect.forEach(selected, (row) =>
        readCertifiedRecord(row),
      );
      const last = selected.at(-1);
      const continuation =
        rows.length > HISTORY_PAGE_SIZE && last !== undefined
          ? Buffer.from(
              encodeCursor({
                conversationId,
                afterRecordHash: readText(last, "record_hash"),
                throughRecordHash,
              }),
            ).toString("base64url")
          : null;
      return { records, continuation };
    }),
  );
}
function decodeHistoryCursor(value: string) {
  return Effect.try({
    try: () => {
      if (value.length > 4096 || !/^[A-Za-z0-9_-]+$/u.test(value))
        throw new StoreSignal("invalid-continuation");
      const bytes = Buffer.from(value, "base64url");
      if (bytes.toString("base64url") !== value)
        throw new StoreSignal("invalid-continuation");
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    },
    catch: () => new EndpointStoreError({ reason: "invalid-continuation" }),
  }).pipe(
    Effect.flatMap(decodeCursor),
    Effect.catchTag("ParseError", () =>
      Effect.fail(new EndpointStoreError({ reason: "invalid-continuation" })),
    ),
  );
}
function historyPosition(
  conversationId: string,
  recordHash: string,
  continuation: boolean,
) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const row = (yield* sql.unsafe<Readonly<Record<string, unknown>>>(
      "SELECT ordinal FROM certified_records WHERE conversation_id=? AND record_hash=?",
      [conversationId, recordHash],
    ))[0];
    if (row === undefined)
      return yield* new EndpointStoreError({
        reason: continuation ? "invalid-continuation" : "not-found",
      });
    return readInteger(row, "ordinal");
  }).pipe(storeOperation);
}
