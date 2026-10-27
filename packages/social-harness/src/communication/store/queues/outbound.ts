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
 * @returns The retained envelope under its message identity.
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
 * @returns The retained envelope under its message identity.
 */
export function enqueueOutboundInTransaction(
  database: DatabaseSync,
  message: OutboundMessageInput,
): StoredOutboundMessage {
  validateMessageInput(message);
  requireConversation(database, message.conversationId);
  const existing = findOutbound(database, message.messageId);
  if (existing !== undefined) {
    requireEqual(existing.outbound.conversationId, message.conversationId);
    requireEqual(existing.outbound.wireVersion, message.wireVersion);
    requireSameBytes(
      existing.outbound.canonicalSignedMessage,
      message.canonicalSignedMessage,
    );
    return copyOutbound(existing.outbound);
  }
  requireMessageIdAvailable(database, message.messageId);
  database
    .prepare(
      `INSERT INTO outbound_messages
        (conversation_id, message_id,
         canonical_signed_message, wire_version, attempted, disposition)
       VALUES (?, ?, ?, ?, 0, 'pending')`,
    )
    .run(
      message.conversationId,
      message.messageId,
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
 * @param messageId Stable identity of the signed envelope.
 * @returns The current stored bytes, or an inactive terminal disposition.
 */
export function beginOutbound(
  database: DatabaseSync,
  messageId: string,
): OutboundAttempt {
  requireText(messageId);
  return transaction(database, () => {
    const retained = requireOutbound(database, messageId);
    if (retained.disposition !== "pending") {
      return Object.freeze({ kind: "inactive" });
    }
    const mode = retained.attempted ? "retry" : "initial";
    if (!retained.attempted) {
      database
        .prepare(
          `UPDATE outbound_messages SET attempted = 1
           WHERE message_id = ? AND disposition = 'pending'`,
        )
        .run(messageId);
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
    const retained = requireOutbound(database, outbound.messageId);
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
             WHERE message_id = ? AND disposition = 'pending'`,
          )
          .run(outbound.messageId);
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
    if (distinctIds.has(outbound.messageId)) {
      throw new StoreSignal("invalid-input");
    }
    distinctIds.add(outbound.messageId);
  }
  return transaction(database, () => {
    const retained = outbounds.map((outbound) => {
      const row = requireOutbound(database, outbound.messageId);
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
            `UPDATE dissemination_obligations SET message_id = NULL
             WHERE message_id = ?`,
          )
          .run(outbound.outbound.messageId);
        database
          .prepare(
            `UPDATE outbound_messages SET disposition = 'discarded'
             WHERE message_id = ? AND disposition = 'pending'`,
          )
          .run(outbound.outbound.messageId);
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
        `SELECT conversation_id, message_id,
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
  messageId: string,
): RetainedOutbound {
  const retained = findOutbound(database, messageId);
  if (retained === undefined) {
    throw new StoreSignal("not-found");
  }
  return retained;
}

function findOutbound(
  database: DatabaseSync,
  messageId: string,
): RetainedOutbound | undefined {
  const row = database
    .prepare(
      `SELECT conversation_id, message_id,
              canonical_signed_message, wire_version, attempted, disposition
       FROM outbound_messages WHERE message_id = ?`,
    )
    .get(messageId);
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
      messageId: readText(row, "message_id"),
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

function requireMessageIdAvailable(
  database: DatabaseSync,
  messageId: string,
): void {
  if (
    database
      .prepare(
        `SELECT 1 AS retained FROM outbound_messages
         WHERE message_id = ? LIMIT 1`,
      )
      .get(messageId) !== undefined
  ) {
    throw new StoreSignal("conflict");
  }
}

function validateStoredOutbound(outbound: StoredOutboundMessage): void {
  requireText(outbound.messageId);
  validateMessageInput(outbound);
}

function validateMessageInput(message: OutboundMessageInput): void {
  requireText(message.wireVersion);
  requireText(message.conversationId);
  requireText(message.messageId);
  requireBytes(message.canonicalSignedMessage);
}

function requireSameOutbound(
  left: StoredOutboundMessage,
  right: StoredOutboundMessage,
): void {
  requireEqual(left.conversationId, right.conversationId);
  requireEqual(left.messageId, right.messageId);
  requireEqual(left.wireVersion, right.wireVersion);
  requireSameBytes(left.canonicalSignedMessage, right.canonicalSignedMessage);
}

function copyOutbound(outbound: StoredOutboundMessage): StoredOutboundMessage {
  return Object.freeze({
    ...outbound,
    canonicalSignedMessage: copyBytes(outbound.canonicalSignedMessage),
  });
}
