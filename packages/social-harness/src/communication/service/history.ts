/** @file Verified conversation pages keep protocol hashes inside their storage cursor. */

import { SqlClient } from "@effect/sql";
import { Effect, Schema } from "effect";
import type { Ed25519PublicKey } from "../../identity/keys.js";
import { agentViewOf, type VerifiedAgentCard } from "../../identity/cards.js";
import {
  readStoredHistory,
  verifyStoredMembership,
} from "../conversations/index.js";
import {
  CommunicationError,
  type ConversationPage,
  type ConversationQuery,
  type HistoryQuery,
  type MessagePage,
} from "../index.js";
import { RecordHash } from "../records/index.js";
import * as Store from "../store/index.js";

const CURSOR_PREFIX = "communication:";
const corrupt = () => new CommunicationError({ reason: "history-gap" });

const membershipRow = Schema.Struct({
  conversation_id: Schema.String,
  membership_hash: Schema.String,
  canonical_membership: Schema.Uint8ArrayFromSelf,
});

/** Conversation enumeration reads only the selected membership page. */
export function listConversations(
  query: ConversationQuery,
  local: VerifiedAgentCard,
  signer: Ed25519PublicKey,
) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql.unsafe<Readonly<Record<string, unknown>>>(
      `
      SELECT state.conversation_id, membership.membership_hash, membership.canonical_membership
      FROM conversation_state AS state JOIN memberships AS membership USING (conversation_id)
      WHERE state.head_record_hash IS NOT NULL AND state.conversation_id > ?
      ORDER BY state.conversation_id LIMIT 51`,
      [query.afterConversationId ?? ""],
    );
    const conversations = yield* Effect.forEach(
      rows.slice(0, 50),
      (row) => conversationEntry(row, local, signer),
      { concurrency: 1 },
    );
    return {
      conversations,
      hasMore: rows.length > 50,
    } satisfies ConversationPage;
  }).pipe(
    Effect.catchTags({
      SqlError: () => new CommunicationError({ reason: "persistence-failed" }),
      ParseError: corrupt,
      ClientRepresentationError: corrupt,
      RouterWorkerPersistenceError: corrupt,
    }),
    Effect.withSpan("Communication.listConversations"),
  );
}

/** The first page fixes a head, and later pages retain that head after restart. */
export function readHistory(query: HistoryQuery, signer: Ed25519PublicKey) {
  return Effect.gen(function* () {
    const request = yield* historyRequest(query);
    const page = yield* Store.readConversation(request);
    const records = yield* readStoredHistory(signer, page, page.records);
    return {
      messages: records.map((record) => record.message),
      continuation:
        page.continuation === null ? null : CURSOR_PREFIX + page.continuation,
    } satisfies MessagePage;
  }).pipe(
    Effect.catchTags({
      EndpointStoreError: historyStoreFailure,
      ClientRepresentationError: corrupt,
      ParseError: corrupt,
      RouterWorkerPersistenceError: corrupt,
      SqlError: () => new CommunicationError({ reason: "persistence-failed" }),
    }),
    Effect.withSpan("Communication.readHistory"),
  );
}

function conversationEntry(
  row: Readonly<Record<string, unknown>>,
  local: VerifiedAgentCard,
  signer: Ed25519PublicKey,
) {
  return Schema.decodeUnknown(membershipRow)(row).pipe(
    Effect.flatMap((decoded) =>
      verifyStoredMembership(
        {
          conversationId: decoded.conversation_id,
          membershipHash: decoded.membership_hash,
          canonicalMembership: decoded.canonical_membership,
        },
        signer,
      ),
    ),
    Effect.flatMap((membership) => {
      if (
        !membership.members.some((member) => member.agentId === local.agentId)
      ) {
        return corrupt();
      }
      return Effect.succeed({
        conversationId: membership.descriptor.conversationId,
        members: membership.members.map(agentViewOf),
      });
    }),
  );
}

function historyRequest(query: HistoryQuery) {
  return Effect.gen(function* () {
    if ("continuation" in query) {
      return query.continuation.startsWith(CURSOR_PREFIX)
        ? { continuation: query.continuation.slice(CURSOR_PREFIX.length) }
        : yield* new CommunicationError({ reason: "invalid-continuation" });
    }
    if (query.afterMessage === undefined) {
      return { conversationId: query.conversationId };
    }
    const sql = yield* SqlClient.SqlClient;
    const row = (yield* sql.unsafe<Readonly<Record<string, unknown>>>(
      `SELECT staged.record_hash FROM staged_records AS staged JOIN certified_records AS certified USING (conversation_id, record_hash) WHERE staged.conversation_id = ? AND staged.author_agent_id = ? AND staged.msg_id = ?`,
      [
        query.conversationId,
        query.afterMessage.authorAgentId,
        query.afterMessage.msgId,
      ],
    ))[0];
    if (row === undefined) {
      return yield* corrupt();
    }
    return {
      conversationId: query.conversationId,
      afterRecordHash: yield* Schema.decodeUnknown(RecordHash)(row.record_hash),
    };
  });
}

function historyStoreFailure(error: Store.EndpointStoreError) {
  if (error.reason === "invalid-continuation") {
    return new CommunicationError({ reason: "invalid-continuation" });
  }
  if (error.reason === "persistence" || error.reason === "closed") {
    return new CommunicationError({ reason: "persistence-failed" });
  }
  return corrupt();
}
