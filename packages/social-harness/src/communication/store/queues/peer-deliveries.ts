/** @file Stores messages from peers and tracks whether the daemon has consumed them. */

import * as SqlClient from "@effect/sql/SqlClient";
import { Effect, Either, Schema } from "effect";
import {
  copyBytes,
  EndpointStoreError,
  mintDeliveryToken,
  readBytes,
  readInteger,
  readText,
  requireBytes,
  requireEqual,
  requireSameBytes,
  requireText,
  storeOperation,
  StoreSignal,
  transaction,
} from "../database/index.js";
import { readStoredIdentity } from "../rows/index.js";
import {
  type CertifiedRecord,
  DeliveryToken,
  type InboundDeliveryInput,
  type PendingDelivery,
  type StoreMutation,
} from "../types.js";
const deliveryColumns = `
  delivery_token, conversation_id, record_hash, recipient_agent_id,
  canonical_message, acknowledged
`;
/**
 * Reads unacknowledged deliveries in stable local commit order.
 *
 * @returns Detached pending deliveries in durable insertion order.
 */
export function readPendingDeliveries(): Effect.Effect<
  readonly PendingDelivery[],
  EndpointStoreError,
  SqlClient.SqlClient
> {
  return Effect.gen(function* () {
    const database = yield* SqlClient.SqlClient;
    return Object.freeze(
      (yield* database.unsafe<Readonly<Record<string, unknown>>>(
        `SELECT ${deliveryColumns} FROM pending_deliveries
         WHERE acknowledged = 0 ORDER BY delivery_sequence`,
        [],
      )).map(readPendingDelivery),
    );
  }).pipe(storeOperation, Effect.withSpan("readPendingDeliveries"));
}
/**
 * Reads every retained delivery, including acknowledged tombstones.
 *
 * @param conversationId Restrict the read to this conversation when provided.
 * @returns Detached retained deliveries in durable insertion order.
 */
export function readRetainedDeliveries(
  conversationId?: string,
): Effect.Effect<
  readonly PendingDelivery[],
  EndpointStoreError,
  SqlClient.SqlClient
> {
  return Effect.gen(function* () {
    const database = yield* SqlClient.SqlClient;
    return Object.freeze(
      (yield* database.unsafe<Readonly<Record<string, unknown>>>(
        `SELECT ${deliveryColumns} FROM pending_deliveries ${conversationId === undefined ? "" : "WHERE conversation_id = ?"}
         ORDER BY delivery_sequence`,
        [...(conversationId === undefined ? [] : [conversationId])],
      )).map(readPendingDelivery),
    );
  }).pipe(storeOperation, Effect.withSpan("readRetainedDeliveries"));
}
/**
 * Durably acknowledges one delivery without deleting its collision tombstone.
 *
 * @param deliveryToken Stable opaque delivery identity.
 * @returns Whether acknowledgment state advanced or was already retained.
 */
export function acknowledgeDelivery(
  deliveryToken: DeliveryToken,
): Effect.Effect<StoreMutation, EndpointStoreError, SqlClient.SqlClient> {
  return Effect.gen(function* () {
    const database = yield* SqlClient.SqlClient;
    Either.match(Schema.decodeUnknownEither(DeliveryToken)(deliveryToken), {
      onLeft: () => {
        throw new StoreSignal("invalid-input");
      },
      onRight: () => undefined,
    });
    return yield* transaction(
      Effect.gen(function* () {
        const row = (yield* database.unsafe<Readonly<Record<string, unknown>>>(
          `SELECT ${deliveryColumns} FROM pending_deliveries
         WHERE delivery_token = ?`,
          [deliveryToken],
        ))[0];
        if (row === undefined) {
          return yield* new EndpointStoreError({ reason: "not-found" });
        }
        if (readPendingDelivery(row).acknowledged) {
          return "existing";
        }
        yield* database.unsafe<Readonly<Record<string, unknown>>>(
          `UPDATE pending_deliveries SET acknowledged = 1
         WHERE delivery_token = ?`,
          [deliveryToken],
        );
        return "inserted";
      }),
    );
  }).pipe(storeOperation, Effect.withSpan("acknowledgeDelivery"));
}
/**
 * Creates or validates the delivery coupled to one certified record.
 *
 * This function runs inside the record-promotion transaction after the
 * certified marker exists. It suppresses the local author's own message.
 *
 * @param record Complete record whose certification is already durable.
 * @param delivery Canonical remote message, absent for the local author.
 * @returns Whether the delivery row was inserted or already retained.
 */
export function retainDeliveryInTransaction(
  record: CertifiedRecord,
  delivery?: InboundDeliveryInput,
): Effect.Effect<StoreMutation, EndpointStoreError, SqlClient.SqlClient> {
  return Effect.gen(function* () {
    const database = yield* SqlClient.SqlClient;
    const identity = yield* readStoredIdentity();
    if (identity === undefined) {
      return yield* new EndpointStoreError({ reason: "not-found" });
    }
    if (record.authorAgentId === identity.agentId) {
      if (delivery !== undefined) {
        return yield* new EndpointStoreError({ reason: "conflict" });
      }
      return "existing";
    }
    if (delivery === undefined) {
      return yield* new EndpointStoreError({ reason: "invalid-input" });
    }
    requireText(delivery.recipientAgentId);
    requireBytes(delivery.canonicalMessage);
    requireEqual(identity.agentId, delivery.recipientAgentId);
    const existing = yield* findRetainedDelivery(
      record.conversationId,
      record.recordHash,
    );
    if (existing !== undefined) {
      requireEqual(existing.recipientAgentId, delivery.recipientAgentId);
      requireSameBytes(existing.canonicalMessage, delivery.canonicalMessage);
      return "existing";
    }
    const deliveryToken = yield* mintRetainedDeliveryToken();
    yield* database.unsafe<Readonly<Record<string, unknown>>>(
      `INSERT INTO pending_deliveries
        (delivery_token, conversation_id, record_hash, recipient_agent_id,
         canonical_message)
       VALUES (?, ?, ?, ?, ?)`,
      [
        deliveryToken,
        record.conversationId,
        record.recordHash,
        delivery.recipientAgentId,
        copyBytes(delivery.canonicalMessage),
      ],
    );
    return "inserted";
  }).pipe(storeOperation, Effect.withSpan("retainDeliveryInTransaction"));
}
function findRetainedDelivery(
  conversationId: string,
  recordHash: string,
): Effect.Effect<
  PendingDelivery | undefined,
  EndpointStoreError,
  SqlClient.SqlClient
> {
  return Effect.gen(function* () {
    const database = yield* SqlClient.SqlClient;
    const row = (yield* database.unsafe<Readonly<Record<string, unknown>>>(
      `SELECT ${deliveryColumns} FROM pending_deliveries
       WHERE conversation_id = ? AND record_hash = ?`,
      [conversationId, recordHash],
    ))[0];
    return row === undefined ? undefined : readPendingDelivery(row);
  }).pipe(storeOperation);
}
/** Collision retries reuse one indexed query, including acknowledgment tombstones. */
function mintRetainedDeliveryToken(): Effect.Effect<
  DeliveryToken,
  EndpointStoreError,
  SqlClient.SqlClient
> {
  return Effect.gen(function* () {
    const database = yield* SqlClient.SqlClient;
    return Schema.decodeUnknownSync(DeliveryToken)(
      yield* mintDeliveryToken((token) =>
        Effect.gen(function* () {
          return (
            (yield* database.unsafe<Readonly<Record<string, unknown>>>(
              "SELECT 1 FROM pending_deliveries WHERE delivery_token = ?",
              [token],
            ))[0] !== undefined
          );
        }),
      ),
    );
  }).pipe(storeOperation);
}
/**
 * Projects one retained durable delivery row.
 *
 * @param row SQLite result row.
 * @returns The detached delivery and its acknowledgment state.
 */
function readPendingDelivery(
  row: Readonly<Record<string, unknown>>,
): PendingDelivery {
  const acknowledged = readInteger(row, "acknowledged");
  if (acknowledged !== 0 && acknowledged !== 1) {
    throw new StoreSignal("corrupt");
  }
  const deliveryToken = Either.match(
    Schema.decodeUnknownEither(DeliveryToken)(readText(row, "delivery_token")),
    {
      onLeft: () => {
        throw new StoreSignal("corrupt");
      },
      onRight: (token) => token,
    },
  );
  return Object.freeze({
    deliveryToken,
    conversationId: readText(row, "conversation_id"),
    recordHash: readText(row, "record_hash"),
    recipientAgentId: readText(row, "recipient_agent_id"),
    canonicalMessage: readBytes(row, "canonical_message"),
    acknowledged: acknowledged === 1,
  });
}
