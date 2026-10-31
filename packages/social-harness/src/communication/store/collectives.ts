/** @file Collective custody and first-answer selection commit before network submission. */

import * as SqlClient from "@effect/sql/SqlClient";
import { Effect } from "effect";
import { Message } from "../message.js";
import {
  copyBytes,
  EndpointStoreError,
  mintDeliveryToken,
  readBytes,
  readInteger,
  readOptionalBytes,
  readText,
  requireSameBytes,
  storeOperation,
  StoreSignal,
  transaction,
} from "./database/index.js";
import { decodeRuntimeValue } from "./runtime-codec.js";
import {
  type CollectiveAnswerReference,
  type CollectiveOperationInput,
  DeliveryToken,
  type StoredCollectiveMessage,
  type StoredCollectiveOperation,
} from "./types.js";

/** A repeated operation must carry identical request bytes and ownership. */
export function putCollectiveOperation(input: CollectiveOperationInput) {
  return transaction(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const existing = yield* readCollectiveOperation(input.operationId);
      if (existing !== undefined) {
        requireSameBytes(existing.canonicalRequest, input.canonicalRequest);
        if (
          existing.creatorAgentId !== input.creatorAgentId ||
          existing.origin !== input.origin ||
          existing.deadlineAt !== input.deadlineAt
        ) {
          return yield* new EndpointStoreError({ reason: "conflict" });
        }
        return existing;
      }
      const deliveryToken = yield* mintDeliveryToken((token) =>
        sql
          .unsafe(
            "SELECT 1 FROM collective_operations WHERE delivery_token=?",
            [token],
          )
          .pipe(Effect.map((rows) => rows.length > 0)),
      );
      yield* sql.unsafe(
        "INSERT INTO collective_operations(operation_id,creator_agent_id,origin,canonical_request,deadline_at,delivery_token) VALUES(?,?,?,?,?,?)",
        [
          input.operationId,
          input.creatorAgentId,
          input.origin,
          copyBytes(input.canonicalRequest),
          input.deadlineAt,
          deliveryToken,
        ],
      );
      return {
        ...input,
        deliveryToken,
        phase: "collecting" as const,
        delivered: false,
      };
    }),
  ).pipe(storeOperation, Effect.withSpan("putCollectiveOperation"));
}

/** Reads retained operation state without touching protocol records. */
export function readCollectiveOperation(operationId: string) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const row = (yield* sql.unsafe<Readonly<Record<string, unknown>>>(
      "SELECT * FROM collective_operations WHERE operation_id=?",
      [operationId],
    ))[0];
    return row === undefined ? undefined : readOperation(row);
  }).pipe(storeOperation, Effect.withSpan("readCollectiveOperation"));
}

/** Only unfinished operations need deadline and close recovery work. */
export const readOpenCollectiveOperations = () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return (yield* sql.unsafe<Readonly<Record<string, unknown>>>(
      "SELECT * FROM collective_operations WHERE phase<>'completed' ORDER BY rowid",
    )).map(readOperation);
  }).pipe(storeOperation, Effect.withSpan("readOpenCollectiveOperations"));

/** The next unretired result is read without loading historical result bodies. */
export const readNextCollectiveResult = () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const row = (yield* sql.unsafe<Readonly<Record<string, unknown>>>(
      "SELECT * FROM collective_operations WHERE phase='completed' AND delivered=0 AND canonical_result IS NOT NULL ORDER BY rowid LIMIT 1",
    ))[0];
    return row === undefined ? undefined : readOperation(row);
  }).pipe(storeOperation, Effect.withSpan("readNextCollectiveResult"));

/** A claim owns its exact message even when submission is interrupted or uncertain. */
export function putCollectiveMessage(input: StoredCollectiveMessage) {
  return transaction(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const prior = (yield* sql.unsafe<Readonly<Record<string, unknown>>>(
        "SELECT canonical_message FROM collective_messages WHERE operation_id=? AND role=? AND destination=?",
        [input.operationId, input.role, input.destination],
      ))[0];
      if (prior !== undefined) {
        requireSameBytes(
          readBytes(prior, "canonical_message"),
          input.canonicalMessage,
        );
        return;
      }
      const message = yield* decodeRuntimeValue(
        Message,
        input.canonicalMessage,
      );
      yield* sql.unsafe(
        "INSERT INTO collective_messages(operation_id,role,destination,author_agent_id,msg_id,canonical_message) VALUES(?,?,?,?,?,?)",
        [
          input.operationId,
          input.role,
          input.destination,
          message.author.agentId,
          message.msgId,
          copyBytes(input.canonicalMessage),
        ],
      );
    }),
  ).pipe(storeOperation, Effect.withSpan("putCollectiveMessage"));
}

/** Outgoing custody is sufficient to resume the same send after restart. */
export function readCollectiveMessages(operationId?: string) {
  return readMessages(
    operationId === undefined ? "" : " WHERE operation_id=?",
    operationId === undefined ? [] : [operationId],
  ).pipe(Effect.withSpan("readCollectiveMessages"));
}

/** Outgoing custody retires after its owning service has durably handled the handoff. */
export function completeCollectiveMessage(reference: {
  readonly authorAgentId: string;
  readonly msgId: string;
}) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.unsafe(
      "UPDATE collective_messages SET completed=1 WHERE author_agent_id=? AND msg_id=?",
      [reference.authorAgentId, reference.msgId],
    );
  }).pipe(storeOperation, Effect.withSpan("completeCollectiveMessage"));
}

/** Only pending submissions load message snapshots into the scoped worker. */
export const readPendingCollectiveMessages = () =>
  readMessages(" WHERE completed=0", []).pipe(
    Effect.withSpan("readPendingCollectiveMessages"),
  );

/** Only a first answer recorded on the collector's clock before expiry can be selected. */
export function recordCollectiveAnswer(
  input: CollectiveAnswerReference,
  now: number,
) {
  return transaction(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const operation = yield* readCollectiveOperation(input.operationId);
      if (operation === undefined || operation.phase === "completed") {
        return false;
      }
      if (
        operation.origin === "local" &&
        (operation.phase !== "collecting" || now >= operation.deadlineAt)
      ) {
        return false;
      }
      const prior = (yield* sql.unsafe<Readonly<Record<string, unknown>>>(
        "SELECT canonical_message FROM collective_answers WHERE operation_id=? AND member=?",
        [input.operationId, input.member],
      ))[0];
      if (prior !== undefined) {
        return false;
      }
      yield* sql.unsafe(
        "INSERT INTO collective_answers(operation_id,member,canonical_message) VALUES(?,?,?)",
        [input.operationId, input.member, copyBytes(input.canonicalMessage)],
      );
      return true;
    }),
  ).pipe(storeOperation, Effect.withSpan("recordCollectiveAnswer"));
}

/** First-answer snapshots retain their original identities and content. */
export function readCollectiveAnswers(operationId: string) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return (yield* sql.unsafe<Readonly<Record<string, unknown>>>(
      "SELECT member,canonical_message FROM collective_answers WHERE operation_id=? ORDER BY rowid",
      [operationId],
    )).map(
      (row): CollectiveAnswerReference => ({
        operationId,
        member: readText(row, "member"),
        canonicalMessage: readBytes(row, "canonical_message"),
      }),
    );
  }).pipe(storeOperation, Effect.withSpan("readCollectiveAnswers"));
}

/** Freezing a result or close preserves the first completion choice through restart. */
export function finalizeCollectiveOperation(
  operationId: string,
  canonicalSelection: Uint8Array,
) {
  return transaction(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const existing = yield* readCollectiveOperation(operationId);
      if (existing === undefined) {
        return yield* new EndpointStoreError({ reason: "not-found" });
      }
      if (existing.canonicalSelection !== undefined) {
        requireSameBytes(existing.canonicalSelection, canonicalSelection);
        return;
      }
      yield* sql.unsafe(
        "UPDATE collective_operations SET phase='finalizing',canonical_selection=? WHERE operation_id=? AND phase='collecting'",
        [copyBytes(canonicalSelection), operationId],
      );
    }),
  ).pipe(storeOperation, Effect.withSpan("finalizeCollectiveOperation"));
}

/** A result and its sources commit together before the result consumer can observe either. */
export function completeCollectiveOperation(input: {
  readonly operationId: string;
  readonly canonicalResult: Uint8Array;
  readonly canonicalSources: Uint8Array;
}) {
  return transaction(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const existing = yield* readCollectiveOperation(input.operationId);
      if (existing === undefined) {
        return yield* new EndpointStoreError({ reason: "not-found" });
      }
      if (existing.canonicalResult !== undefined) {
        requireSameBytes(existing.canonicalResult, input.canonicalResult);
        if (existing.canonicalSources === undefined) {
          return yield* new EndpointStoreError({ reason: "corrupt" });
        }
        requireSameBytes(existing.canonicalSources, input.canonicalSources);
        return;
      }
      yield* sql.unsafe(
        "UPDATE collective_operations SET phase='completed',canonical_result=?,canonical_sources=? WHERE operation_id=?",
        [
          copyBytes(input.canonicalResult),
          copyBytes(input.canonicalSources),
          input.operationId,
        ],
      );
    }),
  ).pipe(storeOperation, Effect.withSpan("completeCollectiveOperation"));
}

/** Failed handoffs remain pending; a successful durable handler retires the same result. */
export function retireCollectiveResult(operationId: string) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.unsafe(
      "UPDATE collective_operations SET delivered=1 WHERE operation_id=? AND phase='completed'",
      [operationId],
    );
  }).pipe(storeOperation, Effect.withSpan("retireCollectiveResult"));
}

/** Invalid closes end an operation without inventing a result. */
export function retireCollectiveOperation(operationId: string) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.unsafe(
      "UPDATE collective_operations SET phase='completed',delivered=1 WHERE operation_id=?",
      [operationId],
    );
  }).pipe(storeOperation, Effect.withSpan("retireCollectiveOperation"));
}

function readMessages(where: string, parameters: readonly string[]) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return (yield* sql.unsafe<Readonly<Record<string, unknown>>>(
      "SELECT operation_id,role,destination,canonical_message FROM collective_messages" +
        where +
        " ORDER BY rowid",
      parameters,
    )).map((row): StoredCollectiveMessage => {
      const role = readText(row, "role");
      if (role !== "request" && role !== "response" && role !== "close") {
        throw new StoreSignal("corrupt");
      }
      return {
        operationId: readText(row, "operation_id"),
        role,
        destination: readText(row, "destination"),
        canonicalMessage: readBytes(row, "canonical_message"),
      };
    });
  }).pipe(storeOperation);
}

function readOperation(
  row: Readonly<Record<string, unknown>>,
): StoredCollectiveOperation {
  const origin = readOrigin(row);
  const phase = readPhase(row);
  const canonicalSelection = readOptionalBytes(row, "canonical_selection");
  const canonicalResult = readOptionalBytes(row, "canonical_result");
  const canonicalSources = readOptionalBytes(row, "canonical_sources");
  return {
    operationId: readText(row, "operation_id"),
    creatorAgentId: readText(row, "creator_agent_id"),
    origin,
    phase,
    canonicalRequest: readBytes(row, "canonical_request"),
    deadlineAt: readInteger(row, "deadline_at"),
    deliveryToken: DeliveryToken.make(readText(row, "delivery_token")),
    delivered: readInteger(row, "delivered") === 1,
    ...(canonicalSelection === undefined ? {} : { canonicalSelection }),
    ...(canonicalResult === undefined ? {} : { canonicalResult }),
    ...(canonicalSources === undefined ? {} : { canonicalSources }),
  };
}

function readOrigin(row: Readonly<Record<string, unknown>>) {
  const origin = readText(row, "origin");
  if (origin !== "local" && origin !== "remote") {
    throw new StoreSignal("corrupt");
  }
  return origin;
}

function readPhase(row: Readonly<Record<string, unknown>>) {
  const phase = readText(row, "phase");
  if (
    phase !== "collecting" &&
    phase !== "finalizing" &&
    phase !== "completed"
  ) {
    throw new StoreSignal("corrupt");
  }
  return phase;
}
