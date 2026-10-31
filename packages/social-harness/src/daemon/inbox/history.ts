/** @file Saved local outcomes remain readable after delivery acknowledgment. */

import { SqlClient } from "@effect/sql";
import { Effect, Schema } from "effect";
import {
  readBytes,
  readInteger,
  readOptionalBytes,
  readText,
  storeOperation,
} from "../../communication/store/database/index.js";
import { DeliveryToken } from "../../communication/store/types.js";

const localResults =
  "FROM incoming_items AS incoming JOIN runtime_inbox AS inbox USING(delivery_token) WHERE incoming.author_agent_id IS NULL AND incoming.disposition='admitted'";

/** Local results remain discoverable when no messages were sent. */
export function listLocalResultConversations(after = "") {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql.unsafe<Readonly<Record<string, unknown>>>(
      `SELECT DISTINCT incoming.conversation ${localResults} AND incoming.conversation > ? ORDER BY incoming.conversation LIMIT 51`,
      [after],
    );
    return {
      addresses: rows.slice(0, 50).map((row) => readText(row, "conversation")),
      hasMore: rows.length > 50,
    };
  }).pipe(storeOperation, Effect.withSpan("listLocalResultConversations"));
}

/** Later results stay outside reads that captured this position. */
export function localResultBoundary(conversation: string) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const row = (yield* sql.unsafe<Readonly<Record<string, unknown>>>(
      `SELECT COALESCE(MAX(inbox.sequence),0) AS newest ${localResults} AND incoming.conversation=?`,
      [conversation],
    ))[0];
    return row === undefined ? 0 : readInteger(row, "newest");
  }).pipe(storeOperation, Effect.withSpan("localResultBoundary"));
}

/** Pages retain admitted content and guidance under their original delivery identity. */
export function readLocalResultPage(query: {
  readonly conversation: string;
  readonly after: number;
  readonly through: number;
  readonly limit: number;
}) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql.unsafe<Readonly<Record<string, unknown>>>(
      `SELECT inbox.sequence,inbox.delivery_token,inbox.canonical_item,inbox.canonical_guidance ${localResults} AND incoming.conversation=? AND inbox.sequence>? AND inbox.sequence<=? ORDER BY inbox.sequence LIMIT ?`,
      [query.conversation, query.after, query.through, query.limit + 1],
    );
    const items = yield* Effect.forEach(rows.slice(0, query.limit), resultRow, {
      concurrency: 1,
    });
    return {
      items,
      nextAfter: rows.length > query.limit ? items.at(-1)?.sequence : undefined,
    };
  }).pipe(storeOperation, Effect.withSpan("readLocalResultPage"));
}

function resultRow(row: Readonly<Record<string, unknown>>) {
  return Schema.decodeUnknown(DeliveryToken)(
    readText(row, "delivery_token"),
  ).pipe(
    Effect.map((deliveryToken) => {
      const guidance = readOptionalBytes(row, "canonical_guidance");
      return {
        deliveryToken,
        sequence: readInteger(row, "sequence"),
        canonicalItem: readBytes(row, "canonical_item"),
        ...(guidance === undefined ? {} : { canonicalGuidance: guidance }),
      };
    }),
  );
}
