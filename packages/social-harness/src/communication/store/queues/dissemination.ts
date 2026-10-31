/** @file Durable action-certified-record send obligations and exact outbox attachment. */

import * as SqlClient from "@effect/sql/SqlClient";
import { Effect } from "effect";
import type {
  DisseminationObligation,
  OutboundMessageInput,
  StoredOutboundMessage,
  StoreMutation,
} from "../types.js";
import {
  EndpointStoreError,
  readOptionalText,
  readText,
  requireEqual,
  requireText,
  storeOperation,
  transaction,
} from "../database/index.js";
import { enqueueOutboundInTransaction } from "./outbound.js";
/**
 * Retains the send obligation for a staged action-certified record inside
 * the transaction that stages it. The schema's foreign key refuses an
 * obligation for a record that is not staged.
 *
 * @param obligation The staged record that must reach the durable outbox.
 * @returns Whether the obligation was inserted or already durable.
 */
export function retainDisseminationInTransaction(
  obligation: DisseminationObligation,
): Effect.Effect<StoreMutation, EndpointStoreError, SqlClient.SqlClient> {
  return Effect.gen(function* () {
    const database = yield* SqlClient.SqlClient;
    validateObligation(obligation);
    if ((yield* findObligation(obligation)) !== undefined) {
      return "existing";
    }
    yield* database.unsafe<Readonly<Record<string, unknown>>>(
      `INSERT INTO dissemination_obligations (conversation_id, record_hash)
       VALUES (?, ?)`,
      [obligation.conversationId, obligation.recordHash],
    );
    return "inserted";
  }).pipe(storeOperation, Effect.withSpan("retainDisseminationInTransaction"));
}
/**
 * Commits a send obligation and its exact outbox row together.
 *
 * @param obligation Expected durable send obligation.
 * @param message Complete canonical outer envelope.
 * @returns The current durable envelope under its stable outbox identity.
 */
export function enqueueDisseminationOutbound(
  obligation: DisseminationObligation,
  message: OutboundMessageInput,
): Effect.Effect<
  StoredOutboundMessage,
  EndpointStoreError,
  SqlClient.SqlClient
> {
  return Effect.gen(function* () {
    const database = yield* SqlClient.SqlClient;
    validateObligation(obligation);
    requireEqual(obligation.conversationId, message.conversationId);
    return yield* transaction(
      Effect.gen(function* () {
        const retained = yield* findObligation(obligation);
        if (retained === undefined) {
          return yield* new EndpointStoreError({ reason: "not-found" });
        }
        const outbound = yield* enqueueOutboundInTransaction(message);
        if (
          retained.envelopeId !== undefined &&
          retained.envelopeId !== outbound.envelopeId
        ) {
          return yield* new EndpointStoreError({ reason: "conflict" });
        }
        if (retained.envelopeId === undefined) {
          yield* database.unsafe<Readonly<Record<string, unknown>>>(
            `UPDATE dissemination_obligations SET envelope_id = ?
           WHERE conversation_id = ? AND record_hash = ?
             AND envelope_id IS NULL`,
            [
              outbound.envelopeId,
              obligation.conversationId,
              obligation.recordHash,
            ],
          );
        }
        return outbound;
      }),
    );
  }).pipe(storeOperation, Effect.withSpan("enqueueDisseminationOutbound"));
}
/**
 * Reads unattached obligations in their durable insertion order.
 * @param conversationId Restrict the read to this conversation when provided.
 * @returns Exact obligations that do not yet own an outbox envelope.
 */
export function readPendingDissemination(
  conversationId?: string,
): Effect.Effect<
  readonly DisseminationObligation[],
  EndpointStoreError,
  SqlClient.SqlClient
> {
  return Effect.gen(function* () {
    const database = yield* SqlClient.SqlClient;
    return Object.freeze(
      (yield* database.unsafe<Readonly<Record<string, unknown>>>(
        `SELECT conversation_id, record_hash
         FROM dissemination_obligations WHERE envelope_id IS NULL ${conversationId === undefined ? "" : "AND conversation_id = ?"}
         ORDER BY obligation_sequence`,
        [...(conversationId === undefined ? [] : [conversationId])],
      )).map((row) =>
        Object.freeze({
          conversationId: readText(row, "conversation_id"),
          recordHash: readText(row, "record_hash"),
        }),
      ),
    );
  }).pipe(storeOperation, Effect.withSpan("readPendingDissemination"));
}
interface RetainedDissemination {
  readonly envelopeId?: string;
}
function findObligation(
  obligation: DisseminationObligation,
): Effect.Effect<
  RetainedDissemination | undefined,
  EndpointStoreError,
  SqlClient.SqlClient
> {
  return Effect.gen(function* () {
    const database = yield* SqlClient.SqlClient;
    const row = (yield* database.unsafe<Readonly<Record<string, unknown>>>(
      `SELECT envelope_id FROM dissemination_obligations
       WHERE conversation_id = ? AND record_hash = ?`,
      [obligation.conversationId, obligation.recordHash],
    ))[0];
    if (row === undefined) {
      return undefined;
    }
    const envelopeId = readOptionalText(row, "envelope_id");
    return Object.freeze(envelopeId === undefined ? {} : { envelopeId });
  }).pipe(storeOperation);
}
function validateObligation(obligation: DisseminationObligation): void {
  requireText(obligation.conversationId);
  requireText(obligation.recordHash);
}
