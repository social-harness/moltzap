/** @file Durable exact-envelope ownership across Router retries and restart. */

import type { DatabaseSync } from "node:sqlite";
import type {
  OutboundAttempt,
  OutboundMessageInput,
  StoredOutboundMessage,
  StoreMutation,
} from "../types.js";
import {
  copyBytes,
  readBytes,
  readInteger,
  readText,
  requireBytes,
  requireEqual,
  requireSameBytes,
  requireText,
  StoreSignal,
  transaction,
} from "../database/index.js";

type OutboundDisposition = "accepted" | "discarded" | "pending";

interface RetainedOutbound {
  readonly outbound: StoredOutboundMessage;
  readonly attempted: boolean;
  readonly disposition: OutboundDisposition;
}

/**
 * Stages one complete outer envelope before it can reach Router transport.
 *
 * @param database Exclusively owned endpoint database.
 * @param message Canonical complete signed envelope.
 * @returns The retained envelope under its envelope identity.
 */
export function enqueueOutbound(
  database: DatabaseSync,
  message: OutboundMessageInput,
): StoredOutboundMessage {
  validateMessageInput(message);
  return transaction(database, () =>
    enqueueOutboundInTransaction(database, message),
  );
}

/**
 * Retains one validated envelope inside a caller-owned SQLite transaction.
 * @param database Exclusively owned endpoint database.
 * @param message Canonical complete signed envelope.
 * @returns The retained envelope under its envelope identity.
 */
export function enqueueOutboundInTransaction(
  database: DatabaseSync,
  message: OutboundMessageInput,
): StoredOutboundMessage {
  validateMessageInput(message);
  requireConversation(database, message.conversationId);
  const existing = findOutbound(database, message.envelopeId);
  if (existing !== undefined) {
    requireEqual(existing.outbound.conversationId, message.conversationId);
    requireEqual(existing.outbound.wireVersion, message.wireVersion);
    requireSameBytes(
      existing.outbound.canonicalSignedMessage,
      message.canonicalSignedMessage,
    );
    return copyOutbound(existing.outbound);
  }
  requireEnvelopeIdAvailable(database, message.envelopeId);
  database
    .prepare(
      `INSERT INTO outbound_messages
        (conversation_id, envelope_id,
         canonical_signed_message, wire_version, attempted, disposition)
       VALUES (?, ?, ?, ?, 0, 'pending')`,
    )
    .run(
      message.conversationId,
      message.envelopeId,
      copyBytes(message.canonicalSignedMessage),
      message.wireVersion,
    );
  return copyOutbound({
    ...message,
  });
}

/**
 * Selects the exact durable envelope and retry mode for one Router attempt.
 *
 * @param database Exclusively owned endpoint database.
 * @param envelopeId Stable identity of the signed envelope.
 * @returns The current stored bytes, or an inactive terminal disposition.
 */
export function beginOutbound(
  database: DatabaseSync,
  envelopeId: string,
): OutboundAttempt {
  requireText(envelopeId);
  return transaction(database, () => {
    const retained = requireOutbound(database, envelopeId);
    if (retained.disposition !== "pending") {
      return Object.freeze({ kind: "inactive" });
    }
    const mode = retained.attempted ? "retry" : "initial";
    if (!retained.attempted) {
      database
        .prepare(
          `UPDATE outbound_messages SET attempted = 1
           WHERE envelope_id = ? AND disposition = 'pending'`,
        )
        .run(envelopeId);
    }
    return Object.freeze({
      kind: "pending",
      mode,
      outbound: copyOutbound(retained.outbound),
    });
  });
}

/**
 * Marks one exact stored envelope complete after Router accepts its bytes.
 *
 * @param database Exclusively owned endpoint database.
 * @param outbound Exact envelope whose Router digest was verified.
 * @returns Whether this call recorded acceptance or observed it already.
 */
export function completeOutbound(
  database: DatabaseSync,
  outbound: StoredOutboundMessage,
): StoreMutation {
  validateStoredOutbound(outbound);
  return transaction(database, () => {
    const retained = requireOutbound(database, outbound.envelopeId);
    requireSameOutbound(retained.outbound, outbound);
    switch (retained.disposition) {
      case "accepted":
        return "existing";
      case "discarded":
        throw new StoreSignal("conflict");
      case "pending":
        database
          .prepare(
            `UPDATE outbound_messages SET disposition = 'accepted'
             WHERE envelope_id = ? AND disposition = 'pending'`,
          )
          .run(outbound.envelopeId);
        return "inserted";
      default: {
        const exhaustive: never = retained.disposition;
        return exhaustive;
      }
    }
  });
}

/**
 * Atomically invalidates exact pending envelopes before protocol regeneration.
 *
 * @param database Exclusively owned endpoint database.
 * @param outbounds Complete expected envelopes to invalidate.
 * @returns Whether at least one pending envelope became inactive.
 */
export function discardOutbound(
  database: DatabaseSync,
  outbounds: readonly StoredOutboundMessage[],
): StoreMutation {
  const distinctIds = new Set<string>();
  for (const outbound of outbounds) {
    validateStoredOutbound(outbound);
    if (distinctIds.has(outbound.envelopeId)) {
      throw new StoreSignal("invalid-input");
    }
    distinctIds.add(outbound.envelopeId);
  }
  return transaction(database, () => {
    const retained = outbounds.map((outbound) => {
      const row = requireOutbound(database, outbound.envelopeId);
      requireSameOutbound(row.outbound, outbound);
      if (row.disposition === "accepted") {
        throw new StoreSignal("conflict");
      }
      return row;
    });
    const inserted = retained.some(
      (outbound) => outbound.disposition === "pending",
    );
    for (const outbound of retained) {
      if (outbound.disposition === "pending") {
        database
          .prepare(
            `UPDATE dissemination_obligations SET envelope_id = NULL
             WHERE envelope_id = ?`,
          )
          .run(outbound.outbound.envelopeId);
        database
          .prepare(
            `UPDATE outbound_messages SET disposition = 'discarded'
             WHERE envelope_id = ? AND disposition = 'pending'`,
          )
          .run(outbound.outbound.envelopeId);
      }
    }
    return inserted ? "inserted" : "existing";
  });
}

/**
 * Reads every pending stored envelope in durable insertion order.
 *
 * @param database Exclusively owned endpoint database.
 * @param conversationId Restrict the read to this conversation when provided.
 * @returns Detached pending envelopes, excluding accepted and discarded rows.
 */
export function readPendingOutbound(
  database: DatabaseSync,
  conversationId?: string,
): readonly StoredOutboundMessage[] {
  return Object.freeze(
    database
      .prepare(
        `SELECT conversation_id, envelope_id,
                canonical_signed_message, wire_version, attempted, disposition
         FROM outbound_messages WHERE disposition = 'pending' ${conversationId === undefined ? "" : "AND conversation_id = ?"}
         ORDER BY outbound_sequence`,
      )
      .all(...(conversationId === undefined ? [] : [conversationId]))
      .map((row) => copyOutbound(readOutbound(row).outbound)),
  );
}

function requireOutbound(
  database: DatabaseSync,
  envelopeId: string,
): RetainedOutbound {
  const retained = findOutbound(database, envelopeId);
  if (retained === undefined) {
    throw new StoreSignal("not-found");
  }
  return retained;
}

function findOutbound(
  database: DatabaseSync,
  envelopeId: string,
): RetainedOutbound | undefined {
  const row = database
    .prepare(
      `SELECT conversation_id, envelope_id,
              canonical_signed_message, wire_version, attempted, disposition
       FROM outbound_messages WHERE envelope_id = ?`,
    )
    .get(envelopeId);
  return row === undefined ? undefined : readOutbound(row);
}

function readOutbound(
  row: Readonly<Record<string, unknown>>,
): RetainedOutbound {
  const attempted = readInteger(row, "attempted");
  if (attempted !== 0 && attempted !== 1) {
    throw new StoreSignal("corrupt");
  }
  return Object.freeze({
    outbound: Object.freeze({
      conversationId: readText(row, "conversation_id"),
      envelopeId: readText(row, "envelope_id"),
      wireVersion: readText(row, "wire_version"),
      canonicalSignedMessage: readBytes(row, "canonical_signed_message"),
    }),
    attempted: attempted === 1,
    disposition: readDisposition(row),
  });
}

function readDisposition(
  row: Readonly<Record<string, unknown>>,
): OutboundDisposition {
  const disposition = readText(row, "disposition");
  switch (disposition) {
    case "accepted":
    case "discarded":
    case "pending":
      return disposition;
    default:
      throw new StoreSignal("corrupt");
  }
}

function requireConversation(
  database: DatabaseSync,
  conversationId: string,
): void {
  if (
    database
      .prepare(
        `SELECT 1 AS retained FROM conversation_state
         WHERE conversation_id = ?`,
      )
      .get(conversationId) === undefined
  ) {
    throw new StoreSignal("not-found");
  }
}

function requireEnvelopeIdAvailable(
  database: DatabaseSync,
  envelopeId: string,
): void {
  if (
    database
      .prepare(
        `SELECT 1 AS retained FROM outbound_messages
         WHERE envelope_id = ? LIMIT 1`,
      )
      .get(envelopeId) !== undefined
  ) {
    throw new StoreSignal("conflict");
  }
}

function validateStoredOutbound(outbound: StoredOutboundMessage): void {
  requireText(outbound.envelopeId);
  validateMessageInput(outbound);
}

function validateMessageInput(message: OutboundMessageInput): void {
  requireText(message.wireVersion);
  requireText(message.conversationId);
  requireText(message.envelopeId);
  requireBytes(message.canonicalSignedMessage);
}

function requireSameOutbound(
  left: StoredOutboundMessage,
  right: StoredOutboundMessage,
): void {
  requireEqual(left.conversationId, right.conversationId);
  requireEqual(left.envelopeId, right.envelopeId);
  requireEqual(left.wireVersion, right.wireVersion);
  requireSameBytes(left.canonicalSignedMessage, right.canonicalSignedMessage);
}

function copyOutbound(outbound: StoredOutboundMessage): StoredOutboundMessage {
  return Object.freeze({
    ...outbound,
    canonicalSignedMessage: copyBytes(outbound.canonicalSignedMessage),
  });
}
