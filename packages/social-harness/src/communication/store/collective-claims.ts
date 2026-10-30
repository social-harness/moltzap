import * as SqlClient from "@effect/sql/SqlClient";
import { EndpointStoreError, storeOperation } from "./database/index.js";
import { Effect } from "effect";
/** @file Retains a collective operation’s identity and reserves its request, answer and closing messages. */
import { Schema } from "effect";
import {
  copyBytes,
  mintDeliveryToken,
  readBytes,
  readOptionalBytes,
  readText,
  requireBytes,
  requireEqual,
  requireSameBytes,
  requireText,
  StoreSignal,
} from "./database/index.js";
import { readStoredIdentity } from "./rows/index.js";
import {
  type CollectiveMessageBinding,
  type CollectiveOperationInput,
  DeliveryToken,
  type MessageIntent,
  type StoredCollectiveOperation,
  type StoreMutation,
} from "./types.js";
interface OriginIdentity {
  readonly creatorAgentId: string;
  readonly conversationId?: string;
}
/** The claimed slot and its intent commit together, with its protocol identity. */
export function bindCollectiveMessageInTransaction(
  binding: CollectiveMessageBinding,
  intent: MessageIntent,
): Effect.Effect<StoreMutation, EndpointStoreError, SqlClient.SqlClient> {
  return Effect.gen(function* () {
    const database = yield* SqlClient.SqlClient;
    requireText(binding.operationId);
    requireText(binding.destination);
    if (binding.operation !== undefined) {
      requireEqual(binding.operation.operationId, binding.operationId);
      yield* retainCollectiveInTransaction(binding.operation);
    }
    const operation = yield* findCollective(binding.operationId);
    if (operation === undefined) {
      throw new StoreSignal("not-found");
    }
    const prior = (yield* database.unsafe<Readonly<Record<string, unknown>>>(
      `
    SELECT author_agent_id, msg_id, destination FROM collective_messages
    WHERE operation_id = ? AND role = ? AND (role <> 'request' OR destination = ?)
  `,
      [binding.operationId, binding.role, binding.destination],
    ))[0];
    if (prior !== undefined) {
      requireEqual(readText(prior, "author_agent_id"), intent.authorAgentId);
      requireEqual(readText(prior, "msg_id"), intent.msgId);
      requireEqual(readText(prior, "destination"), binding.destination);
      return "existing";
    }
    yield* requireMessageState(binding, intent, operation);
    yield* database.unsafe<Readonly<Record<string, unknown>>>(
      `
    INSERT INTO collective_messages (operation_id, role, destination, author_agent_id, msg_id)
    VALUES (?, ?, ?, ?, ?)
  `,
      [
        binding.operationId,
        binding.role,
        binding.destination,
        intent.authorAgentId,
        intent.msgId,
      ],
    );
    return "inserted";
  }).pipe(storeOperation);
}
/**
 * Retain one exact origin/request binding in the caller's transaction. Remote
 * identities come from certified records; a peer cannot replace a local
 * operation or a different request that happens to name the same id.
 */
export function retainCollectiveInTransaction(
  input: CollectiveOperationInput,
): Effect.Effect<StoreMutation, EndpointStoreError, SqlClient.SqlClient> {
  return Effect.gen(function* () {
    const database = yield* SqlClient.SqlClient;
    requireText(input.operationId);
    requireBytes(input.canonicalRequest);
    requireBytes(input.canonicalDescriptor);
    const origin = yield* requireOrigin(input);
    const prior = yield* findCollective(input.operationId);
    if (prior !== undefined) {
      requireSameOperation(input, prior, origin);
      return "existing";
    }
    yield* insertCollective(input, origin);
    return "inserted";
  }).pipe(storeOperation);
}
/** The decoded immutable descriptor and its current terminal phase. */
export function findCollective(
  operationId: string,
): Effect.Effect<
  StoredCollectiveOperation | undefined,
  EndpointStoreError,
  SqlClient.SqlClient
> {
  return Effect.gen(function* () {
    const database = yield* SqlClient.SqlClient;
    const row = (yield* database.unsafe<Readonly<Record<string, unknown>>>(
      "SELECT * FROM collective_operations WHERE operation_id = ?",
      [operationId],
    ))[0];
    return row === undefined ? undefined : readCollective(row);
  }).pipe(storeOperation);
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
  const canonicalSelection = readOptionalBytes(row, "canonical_selection");
  return {
    operationId: readText(row, "operation_id"),
    creatorAgentId: readText(row, "creator_agent_id"),
    origin,
    canonicalRequest: readBytes(row, "canonical_request"),
    canonicalDescriptor: readBytes(row, "canonical_descriptor"),
    phase,
    ...(canonicalSelection === undefined ? {} : { canonicalSelection }),
    deliveryToken: Schema.decodeUnknownSync(DeliveryToken)(
      readText(row, "delivery_token"),
    ),
  };
}
function requireOrigin(input: CollectiveOperationInput): Effect.Effect<
  {
    readonly creatorAgentId: string;
    readonly conversationId?: string;
  },
  EndpointStoreError,
  SqlClient.SqlClient
> {
  return Effect.gen(function* () {
    const database = yield* SqlClient.SqlClient;
    const identity = yield* readStoredIdentity();
    if (identity === undefined) {
      throw new StoreSignal("not-found");
    }
    if (input.origin.kind === "local") {
      return { creatorAgentId: identity.agentId };
    }
    const row = (yield* database.unsafe<Readonly<Record<string, unknown>>>(
      `
    SELECT r.author_agent_id, c.conversation_id, d.canonical_message
    FROM certified_records c
    JOIN staged_records r USING (conversation_id, record_hash)
    JOIN pending_deliveries d USING (conversation_id, record_hash)
    WHERE c.record_hash = ?
  `,
      [input.origin.recordHash],
    ))[0];
    if (row === undefined) {
      throw new StoreSignal("not-found");
    }
    const creatorAgentId = readText(row, "author_agent_id");
    if (identity.agentId === creatorAgentId) {
      throw new StoreSignal("conflict");
    }
    requireSameBytes(
      readBytes(row, "canonical_message"),
      input.canonicalRequest,
    );
    return { creatorAgentId, conversationId: readText(row, "conversation_id") };
  }).pipe(storeOperation);
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
  if (prior.origin.kind === "remote" && input.origin.kind === "remote") {
    requireEqual(prior.origin.conversationId, origin.conversationId);
    requireEqual(prior.origin.recordHash, input.origin.recordHash);
  }
}
function insertCollective(
  input: CollectiveOperationInput,
  origin: OriginIdentity,
): Effect.Effect<void, EndpointStoreError, SqlClient.SqlClient> {
  return Effect.gen(function* () {
    const database = yield* SqlClient.SqlClient;
    yield* database.unsafe<Readonly<Record<string, unknown>>>(
      `
    INSERT INTO collective_operations
      (operation_id, creator_agent_id, origin, request_conversation_id,
       request_record_hash, canonical_request,
       canonical_descriptor, delivery_token)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `,
      [
        input.operationId,
        origin.creatorAgentId,
        input.origin.kind,
        origin.conversationId ?? null,
        input.origin.kind === "remote" ? input.origin.recordHash : null,
        copyBytes(input.canonicalRequest),
        copyBytes(input.canonicalDescriptor),
        yield* mintDeliveryToken((token) =>
          Effect.gen(function* () {
            return (
              (yield* database.unsafe<Readonly<Record<string, unknown>>>(
                `
      SELECT 1 AS retained FROM collective_operations WHERE delivery_token = ?
      UNION ALL SELECT 1 FROM pending_deliveries WHERE delivery_token = ?
      LIMIT 1
    `,
                [token, token],
              ))[0] !== undefined
            );
          }),
        ),
      ],
    );
  }).pipe(storeOperation);
}
function requireMessageState(
  binding: CollectiveMessageBinding,
  intent: MessageIntent,
  operation: StoredCollectiveOperation,
): Effect.Effect<void, EndpointStoreError, SqlClient.SqlClient> {
  return Effect.gen(function* () {
    const database = yield* SqlClient.SqlClient;
    if (
      binding.role === "request" &&
      (yield* database.unsafe<Readonly<Record<string, unknown>>>(
        "SELECT 1 FROM collective_refusals WHERE operation_id = ? AND destination = ?",
        [binding.operationId, binding.destination],
      ))[0] !== undefined
    ) {
      throw new StoreSignal("conflict");
    }
    if (binding.role === "response") {
      requireRemoteRequest(operation, intent.conversationId);
    } else {
      requireEqual(operation.origin.kind, "local");
      requireEqual(operation.creatorAgentId, intent.authorAgentId);
    }
    requireEqual(
      operation.phase,
      binding.role === "close" ? "finalizing" : "collecting",
    );
  }).pipe(storeOperation);
}
function requireRemoteRequest(
  operation: StoredCollectiveOperation,
  conversationId: string,
): void {
  if (operation.origin.kind !== "remote") {
    throw new StoreSignal("conflict");
  }
  requireEqual(operation.origin.conversationId, conversationId);
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
  };
}
