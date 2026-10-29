/** @file Retains a collective operation’s identity and reserves its request, answer and closing messages. */

import type { DatabaseSync } from "node:sqlite";
import { Schema } from "effect";
import {
  copyBytes,
  mintDeliveryToken,
  readBytes,
  readInteger,
  readOptionalBytes,
  readOptionalText,
  readText,
  requireBytes,
  requireEqual,
  requireSameBytes,
  requireText,
  StoreSignal,
} from "./database/index.js";
import { readStoredIdentity } from "./rows/index.js";
import {
  type CollectiveOperationInput,
  type CollectivePostBinding,
  DeliveryToken,
  type PostIntent,
  type StoredCollectiveOperation,
  type StoreMutation,
} from "./types.js";

interface OriginIdentity {
  readonly creatorAgentId: string;
  readonly conversationId?: string;
}

/** The claimed slot and its intent commit together, including against a request's admission. */
export function bindCollectivePostInTransaction(
  database: DatabaseSync,
  binding: CollectivePostBinding,
  intent: PostIntent,
): StoreMutation {
  requireText(binding.operationId);
  requireText(binding.destination);
  if (binding.operation !== undefined) {
    requireEqual(binding.operation.operationId, binding.operationId);
    retainCollectiveInTransaction(database, binding.operation);
  }
  const operation = findCollective(database, binding.operationId);
  if (operation === undefined) {
    throw new StoreSignal("not-found");
  }
  const prior = database
    .prepare(`
    SELECT author_agent_id, post_id, destination FROM collective_posts
    WHERE operation_id = ? AND role = ? AND (role <> 'request' OR destination = ?)
  `)
    .get(binding.operationId, binding.role, binding.destination);
  if (prior !== undefined) {
    requireEqual(readText(prior, "author_agent_id"), intent.authorAgentId);
    requireEqual(readText(prior, "post_id"), intent.postId);
    requireEqual(readText(prior, "destination"), binding.destination);
    return "existing";
  }
  requirePostState(database, binding, intent, operation);
  database
    .prepare(`
    INSERT INTO collective_posts (operation_id, role, destination, author_agent_id, post_id)
    VALUES (?, ?, ?, ?, ?)
  `)
    .run(
      binding.operationId,
      binding.role,
      binding.destination,
      intent.authorAgentId,
      intent.postId,
    );
  return "inserted";
}

/**
 * Retain one exact origin/request binding in the caller's transaction. Remote
 * identities come from certified records; a peer cannot replace a local
 * operation or a different request that happens to name the same id.
 */
export function retainCollectiveInTransaction(
  database: DatabaseSync,
  input: CollectiveOperationInput,
): StoreMutation {
  requireText(input.operationId);
  requireBytes(input.canonicalRequest);
  requireBytes(input.canonicalDescriptor);
  const origin = requireOrigin(database, input);
  const prior = findCollective(database, input.operationId);
  if (prior !== undefined) {
    requireSameOperation(input, prior, origin);
    return "existing";
  }
  insertCollective(database, input, origin);
  return "inserted";
}

/** The decoded immutable descriptor and its current terminal phase. */
export function findCollective(
  database: DatabaseSync,
  operationId: string,
): StoredCollectiveOperation | undefined {
  const row = database
    .prepare("SELECT * FROM collective_operations WHERE operation_id = ?")
    .get(operationId);
  return row === undefined ? undefined : readCollective(row);
}

/** Private row decoding preserves the closed lifecycle vocabulary. */
export function readCollective(
  row: Readonly<Record<string, unknown>>,
): StoredCollectiveOperation {
  const origin = readOrigin(row);
  const phase = readText(row, "phase");
  if (
    phase !== "collecting" &&
    phase !== "finalizing" &&
    phase !== "completed"
  ) {
    throw new StoreSignal("corrupt");
  }
  const admittedCheckId = readOptionalText(row, "admitted_check_id");
  const canonicalSelection = readOptionalBytes(row, "canonical_selection");
  return {
    operationId: readText(row, "operation_id"),
    creatorAgentId: readText(row, "creator_agent_id"),
    origin,
    canonicalRequest: readBytes(row, "canonical_request"),
    canonicalDescriptor: readBytes(row, "canonical_descriptor"),
    ...(admittedCheckId === undefined ? {} : { admittedCheckId }),
    phase,
    ...(canonicalSelection === undefined ? {} : { canonicalSelection }),
    deliveryToken: Schema.decodeUnknownSync(DeliveryToken)(
      readText(row, "delivery_token"),
    ),
  };
}

function requireOrigin(
  database: DatabaseSync,
  input: CollectiveOperationInput,
): { readonly creatorAgentId: string; readonly conversationId?: string } {
  const identity = readStoredIdentity(database);
  if (identity === undefined) {
    throw new StoreSignal("not-found");
  }
  if (input.origin.kind === "local") {
    return { creatorAgentId: identity.agentId };
  }
  const row = database
    .prepare(`
    SELECT r.author_agent_id, c.conversation_id, d.canonical_message
    FROM certified_records c
    JOIN staged_records r USING (conversation_id, record_hash)
    JOIN pending_deliveries d USING (conversation_id, record_hash)
    WHERE c.record_hash = ?
  `)
    .get(input.origin.recordHash);
  if (row === undefined) {
    throw new StoreSignal("not-found");
  }
  const creatorAgentId = readText(row, "author_agent_id");
  if (identity.agentId === creatorAgentId) {
    throw new StoreSignal("conflict");
  }
  requireSameBytes(readBytes(row, "canonical_message"), input.canonicalRequest);
  return { creatorAgentId, conversationId: readText(row, "conversation_id") };
}

function requireSameOperation(
  input: CollectiveOperationInput,
  prior: StoredCollectiveOperation,
  origin: OriginIdentity,
): void {
  requireEqual(prior.creatorAgentId, origin.creatorAgentId);
  requireEqual(prior.origin.kind, input.origin.kind);
  requireSameBytes(prior.canonicalRequest, input.canonicalRequest);
  requireSameBytes(prior.canonicalDescriptor, input.canonicalDescriptor);
  requireEqual(prior.admittedCheckId, input.admittedCheckId);
  if (prior.origin.kind === "remote" && input.origin.kind === "remote") {
    requireEqual(prior.origin.conversationId, origin.conversationId);
    requireEqual(prior.origin.recordHash, input.origin.recordHash);
    requireEqual(
      prior.origin.requiresAdmission,
      input.origin.requiresAdmission,
    );
  }
}

function insertCollective(
  database: DatabaseSync,
  input: CollectiveOperationInput,
  origin: OriginIdentity,
): void {
  database
    .prepare(`
    INSERT INTO collective_operations
      (operation_id, creator_agent_id, origin, request_conversation_id,
       request_record_hash, requires_admission, canonical_request,
       canonical_descriptor, admitted_check_id, delivery_token)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
    .run(
      input.operationId,
      origin.creatorAgentId,
      input.origin.kind,
      origin.conversationId ?? null,
      input.origin.kind === "remote" ? input.origin.recordHash : null,
      input.origin.kind === "remote" && input.origin.requiresAdmission ? 1 : 0,
      copyBytes(input.canonicalRequest),
      copyBytes(input.canonicalDescriptor),
      input.admittedCheckId ?? null,
      mintDeliveryToken(
        (token) =>
          database
            .prepare(`
      SELECT 1 AS retained FROM collective_operations WHERE delivery_token = ?
      UNION ALL SELECT 1 FROM pending_deliveries WHERE delivery_token = ?
      UNION ALL SELECT 1 FROM runtime_inbox WHERE delivery_token = ?
      UNION ALL SELECT 1 FROM firewall_incoming WHERE delivery_token = ? LIMIT 1
    `)
            .get(token, token, token, token) !== undefined,
      ),
    );
}

function requirePostState(
  database: DatabaseSync,
  binding: CollectivePostBinding,
  intent: PostIntent,
  operation: StoredCollectiveOperation,
): void {
  if (
    binding.role === "request" &&
    database
      .prepare(
        "SELECT 1 FROM collective_refusals WHERE operation_id = ? AND destination = ?",
      )
      .get(binding.operationId, binding.destination) !== undefined
  ) {
    throw new StoreSignal("conflict");
  }
  if (binding.role === "response") {
    requireRemoteRequestAdmission(database, operation, intent.conversationId);
  } else {
    requireEqual(operation.origin.kind, "local");
    requireEqual(operation.creatorAgentId, intent.authorAgentId);
  }
  requireEqual(
    operation.phase,
    binding.role === "close" ? "finalizing" : "collecting",
  );
}

function requireRemoteRequestAdmission(
  database: DatabaseSync,
  operation: StoredCollectiveOperation,
  conversationId: string,
): void {
  if (operation.origin.kind !== "remote") {
    throw new StoreSignal("conflict");
  }
  requireEqual(operation.origin.conversationId, conversationId);
  if (!operation.origin.requiresAdmission) {
    return;
  }
  const shown = database
    .prepare(`
    SELECT 1 AS presented FROM pending_deliveries d
    JOIN runtime_inbox i USING (delivery_token)
    WHERE d.conversation_id = ? AND d.record_hash = ?
  `)
    .get(operation.origin.conversationId, operation.origin.recordHash);
  if (shown === undefined) {
    throw new StoreSignal("conflict");
  }
}

function readOrigin(
  row: Readonly<Record<string, unknown>>,
): StoredCollectiveOperation["origin"] {
  const origin = readText(row, "origin");
  if (origin === "local") {
    return { kind: "local" };
  }
  if (origin !== "remote") {
    throw new StoreSignal("corrupt");
  }
  return {
    kind: "remote",
    conversationId: readText(row, "request_conversation_id"),
    recordHash: readText(row, "request_record_hash"),
    requiresAdmission: readInteger(row, "requires_admission") === 1,
  };
}
