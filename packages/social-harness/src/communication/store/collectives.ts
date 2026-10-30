import * as SqlClient from "@effect/sql/SqlClient";
import { EndpointStoreError, storeOperation } from "./database/index.js";
import { Effect } from "effect";
/** @file Collective recovery, immutable completion selection, and terminal publication. */
import type {
  CollectiveAnswerReference,
  CollectiveOperationInput,
  CollectiveRequestRefusal,
  StoredCollectiveMessage,
  StoredCollectiveOperation,
  StoreMutation,
} from "./types.js";
import {
  findCollective,
  readCollective,
  retainCollectiveInTransaction,
} from "./collective-claims.js";
import {
  copyBytes,
  readBytes,
  readOptionalText,
  readText,
  requireBytes,
  requireEqual,
  requireSameBytes,
  requireText,
  StoreSignal,
  transaction,
} from "./database/index.js";
/** Unchecked local operations and verified remote requests retain their exact descriptor. */
export function putCollectiveOperation(
  input: CollectiveOperationInput,
): Effect.Effect<StoreMutation, EndpointStoreError, SqlClient.SqlClient> {
  return Effect.gen(function* () {
    const database = yield* SqlClient.SqlClient;
    return yield* transaction(
      (() =>
        Effect.gen(function* () {
          return yield* retainCollectiveInTransaction(input);
        }))(),
    );
  }).pipe(storeOperation);
}
/** Open and terminal operations are retained across ordinary process restarts. */
export function readCollectiveOperations(): Effect.Effect<
  readonly StoredCollectiveOperation[],
  EndpointStoreError,
  SqlClient.SqlClient
> {
  return Effect.gen(function* () {
    const database = yield* SqlClient.SqlClient;
    return (yield* database.unsafe<Readonly<Record<string, unknown>>>(
      "SELECT * FROM collective_operations ORDER BY rowid",
      [],
    )).map(readCollective);
  }).pipe(storeOperation);
}
/** Read the one operation whose phase or delivery identity a live transition needs. */
export function readCollectiveOperation(
  operationId: string,
): Effect.Effect<
  StoredCollectiveOperation | undefined,
  EndpointStoreError,
  SqlClient.SqlClient
> {
  return Effect.gen(function* () {
    const database = yield* SqlClient.SqlClient;
    return yield* findCollective(operationId);
  }).pipe(storeOperation);
}
/** Recovery reads all claims; live callers select one operation and, when known, its message role. */
export function readCollectiveMessages(query?: {
  readonly operationId: string;
  readonly role?: "request" | "response" | "close";
}): Effect.Effect<
  readonly StoredCollectiveMessage[],
  EndpointStoreError,
  SqlClient.SqlClient
> {
  return Effect.gen(function* () {
    const database = yield* SqlClient.SqlClient;
    const conditions: string[] = [];
    const values: string[] = [];
    if (query !== undefined) {
      conditions.push("c.operation_id = ?");
      values.push(query.operationId);
      if (query.role !== undefined) {
        conditions.push("c.role = ?");
        values.push(query.role);
      }
    }
    const where =
      conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`;
    return (yield* database.unsafe<Readonly<Record<string, unknown>>>(
      `
    SELECT c.operation_id, c.role, c.destination, p.* FROM collective_messages c
    JOIN message_intents p USING (author_agent_id, msg_id) ${where} ORDER BY c.rowid
  `,
      [...values],
    )).map(readCollectiveMessage);
  }).pipe(storeOperation);
}
/** Freeze counted record references before a close or local result can be published. */
export function finalizeCollectiveOperation(
  operationId: string,
  canonicalSelection: Uint8Array,
): Effect.Effect<StoreMutation, EndpointStoreError, SqlClient.SqlClient> {
  return Effect.gen(function* () {
    const database = yield* SqlClient.SqlClient;
    requireText(operationId);
    requireBytes(canonicalSelection);
    return yield* transaction(
      (() =>
        Effect.gen(function* () {
          const operation = yield* findCollective(operationId);
          if (operation === undefined) {
            throw new StoreSignal("not-found");
          }
          if (operation.canonicalSelection !== undefined) {
            requireSameBytes(operation.canonicalSelection, canonicalSelection);
            return "existing";
          }
          requireEqual(operation.phase, "collecting");
          yield* database.unsafe<Readonly<Record<string, unknown>>>(
            `
      UPDATE collective_operations SET phase = 'finalizing', canonical_selection = ?
      WHERE operation_id = ?
    `,
            [copyBytes(canonicalSelection), operationId],
          );
          return "inserted";
        }))(),
    );
  }).pipe(storeOperation);
}
/** Retain the first counted answer while the operation still collects. */
export function recordCollectiveAnswer(
  answer: CollectiveAnswerReference,
): Effect.Effect<string | undefined, EndpointStoreError, SqlClient.SqlClient> {
  return Effect.gen(function* () {
    const database = yield* SqlClient.SqlClient;
    return yield* transaction(
      (() =>
        Effect.gen(function* () {
          const operation = yield* findCollective(answer.operationId);
          if (operation?.phase !== "collecting") {
            return undefined;
          }
          const prior = (yield* database.unsafe<
            Readonly<Record<string, unknown>>
          >(
            "SELECT record_hash FROM collective_answers WHERE operation_id = ? AND member = ?",
            [answer.operationId, answer.member],
          ))[0];
          if (prior !== undefined) {
            return readText(prior, "record_hash");
          }
          const record = (yield* database.unsafe<
            Readonly<Record<string, unknown>>
          >(
            "SELECT conversation_id FROM certified_records WHERE record_hash = ?",
            [answer.recordHash],
          ))[0];
          if (record === undefined) {
            throw new StoreSignal("not-found");
          }
          yield* database.unsafe<Readonly<Record<string, unknown>>>(
            "INSERT INTO collective_answers (operation_id, member, conversation_id, record_hash) VALUES (?, ?, ?, ?)",
            [
              answer.operationId,
              answer.member,
              readText(record, "conversation_id"),
              answer.recordHash,
            ],
          );
          return answer.recordHash;
        }))(),
    );
  }).pipe(storeOperation);
}
/** Stable answer references survive loss of the classifier's memory. */
export function readCollectiveAnswers(): Effect.Effect<
  readonly CollectiveAnswerReference[],
  EndpointStoreError,
  SqlClient.SqlClient
> {
  return Effect.gen(function* () {
    const database = yield* SqlClient.SqlClient;
    return (yield* database.unsafe<Readonly<Record<string, unknown>>>(
      "SELECT operation_id, member, record_hash FROM collective_answers ORDER BY rowid",
      [],
    )).map((row) => ({
      operationId: readText(row, "operation_id"),
      member: readText(row, "member"),
      recordHash: readText(row, "record_hash"),
    }));
  }).pipe(storeOperation);
}
/** Confirmed pre-bind failures never turn into a new request on restart. */
export function recordCollectiveRefusal(
  refusal: CollectiveRequestRefusal,
): Effect.Effect<void, EndpointStoreError, SqlClient.SqlClient> {
  return Effect.gen(function* () {
    const database = yield* SqlClient.SqlClient;
    yield* transaction(
      (() =>
        Effect.gen(function* () {
          const operation = yield* findCollective(refusal.operationId);
          if (operation?.phase !== "collecting") {
            return;
          }
          const bound = (yield* database.unsafe<
            Readonly<Record<string, unknown>>
          >(
            "SELECT 1 FROM collective_messages WHERE operation_id = ? AND role = 'request' AND destination = ?",
            [refusal.operationId, refusal.destination],
          ))[0];
          if (bound !== undefined) {
            throw new StoreSignal("conflict");
          }
          const prior = (yield* database.unsafe<
            Readonly<Record<string, unknown>>
          >(
            "SELECT canonical_refusal FROM collective_refusals WHERE operation_id = ? AND destination = ?",
            [refusal.operationId, refusal.destination],
          ))[0];
          if (prior !== undefined) {
            requireSameBytes(
              readBytes(prior, "canonical_refusal"),
              refusal.canonicalRefusal,
            );
            return;
          }
          yield* database.unsafe<Readonly<Record<string, unknown>>>(
            "INSERT INTO collective_refusals (operation_id, destination, canonical_refusal) VALUES (?, ?, ?)",
            [
              refusal.operationId,
              refusal.destination,
              copyBytes(refusal.canonicalRefusal),
            ],
          );
        }))(),
    );
  }).pipe(storeOperation);
}
/** Only unbound request destinations can have retained refusals. */
export function readCollectiveRefusals(): Effect.Effect<
  readonly CollectiveRequestRefusal[],
  EndpointStoreError,
  SqlClient.SqlClient
> {
  return Effect.gen(function* () {
    const database = yield* SqlClient.SqlClient;
    return (yield* database.unsafe<Readonly<Record<string, unknown>>>(
      "SELECT operation_id, destination, canonical_refusal FROM collective_refusals ORDER BY rowid",
      [],
    )).map((row) => ({
      operationId: readText(row, "operation_id"),
      destination: readText(row, "destination"),
      canonicalRefusal: readBytes(row, "canonical_refusal"),
    }));
  }).pipe(storeOperation);
}
/** A refused invocation or invalid remote close ends without inventing an inbox item. */
export function retireCollectiveOperation(
  operationId: string,
  canonicalSelection: Uint8Array,
): Effect.Effect<void, EndpointStoreError, SqlClient.SqlClient> {
  return Effect.gen(function* () {
    const database = yield* SqlClient.SqlClient;
    yield* transaction(
      (() =>
        Effect.gen(function* () {
          const operation = yield* findCollective(operationId);
          if (operation === undefined) {
            throw new StoreSignal("not-found");
          }
          if (operation.canonicalSelection !== undefined) {
            requireSameBytes(operation.canonicalSelection, canonicalSelection);
          }
          yield* database.unsafe<Readonly<Record<string, unknown>>>(
            "UPDATE collective_operations SET phase = 'completed', canonical_selection = ? WHERE operation_id = ?",
            [copyBytes(canonicalSelection), operationId],
          );
        }))(),
    );
  }).pipe(storeOperation);
}
/** Completes protocol custody in the caller's terminal-publication transaction. */
export function completeCollectiveDelivery(
  operationId: string,
  deliveryToken: string,
): Effect.Effect<void, EndpointStoreError, SqlClient.SqlClient> {
  return Effect.gen(function* () {
    const database = yield* SqlClient.SqlClient;
    const operation = yield* findCollective(operationId);
    if (operation === undefined) {
      throw new StoreSignal("not-found");
    }
    if (operation.phase === "collecting") {
      throw new StoreSignal("conflict");
    }
    requireEqual(operation.deliveryToken, deliveryToken);
    yield* database.unsafe<Readonly<Record<string, unknown>>>(
      "UPDATE collective_operations SET phase = 'completed' WHERE operation_id = ?",
      [operationId],
    );
  }).pipe(storeOperation);
}
function readCollectiveMessage(
  row: Readonly<Record<string, unknown>>,
): StoredCollectiveMessage {
  const role = readText(row, "role");
  if (role !== "request" && role !== "response" && role !== "close") {
    throw new StoreSignal("corrupt");
  }
  const completedRecordHash = readOptionalText(row, "completed_record_hash");
  return {
    operationId: readText(row, "operation_id"),
    role,
    destination: readText(row, "destination"),
    intent: {
      authorAgentId: readText(row, "author_agent_id"),
      msgId: readText(row, "msg_id"),
      conversationId: readText(row, "conversation_id"),
      membershipHash: readText(row, "membership_hash"),
      canonicalIntent: readBytes(row, "canonical_intent"),
      ...(completedRecordHash === undefined ? {} : { completedRecordHash }),
    },
  };
}
