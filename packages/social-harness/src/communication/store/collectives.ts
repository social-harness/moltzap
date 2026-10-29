/** @file Collective recovery, immutable completion selection, and terminal publication. */

import type { DatabaseSync } from "node:sqlite";
import type {
  CollectiveAnswerReference,
  CollectiveDelivery,
  CollectiveOperationInput,
  CollectiveRequestRefusal,
  EndpointStore,
  StoredCollectiveOperation,
  StoredCollectiveMessage,
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
import { queueFirewallItem } from "./firewall.js";
import { putInboxItem } from "./host-inbox.js";

/** Unchecked local operations and verified remote requests retain their exact descriptor. */
export function putCollectiveOperation(
  database: DatabaseSync,
  input: CollectiveOperationInput,
): StoreMutation {
  return transaction(database, () =>
    retainCollectiveInTransaction(database, input),
  );
}

/** Open and terminal operations are retained across ordinary process restarts. */
export function readCollectiveOperations(
  database: DatabaseSync,
): readonly StoredCollectiveOperation[] {
  return database
    .prepare("SELECT * FROM collective_operations ORDER BY rowid")
    .all()
    .map(readCollective);
}

/** Read the one operation whose phase or delivery identity a live transition needs. */
export function readCollectiveOperation(
  database: DatabaseSync,
  operationId: string,
): StoredCollectiveOperation | undefined {
  return findCollective(database, operationId);
}

/** Recovery reads all claims; live callers select one operation and, when known, its message role. */
export function readCollectiveMessages(
  database: DatabaseSync,
  query?: Parameters<EndpointStore["readCollectiveMessages"]>[0],
): readonly StoredCollectiveMessage[] {
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
  return database
    .prepare(`
    SELECT c.operation_id, c.role, c.destination, p.* FROM collective_messages c
    JOIN message_intents p USING (author_agent_id, msg_id) ${where} ORDER BY c.rowid
  `)
    .all(...values)
    .map(readCollectiveMessage);
}

/** Freeze counted record references before a close or local result can be published. */
export function finalizeCollectiveOperation(
  database: DatabaseSync,
  operationId: string,
  canonicalSelection: Uint8Array,
): StoreMutation {
  requireText(operationId);
  requireBytes(canonicalSelection);
  return transaction(database, () => {
    const operation = findCollective(database, operationId);
    if (operation === undefined) {
      throw new StoreSignal("not-found");
    }
    if (operation.canonicalSelection !== undefined) {
      requireSameBytes(operation.canonicalSelection, canonicalSelection);
      return "existing";
    }
    requireEqual(operation.phase, "collecting");
    database
      .prepare(`
      UPDATE collective_operations SET phase = 'finalizing', canonical_selection = ?
      WHERE operation_id = ?
    `)
      .run(copyBytes(canonicalSelection), operationId);
    return "inserted";
  });
}

/** One terminal payload and its delivery identity commit with the completed phase. */
export function publishCollectiveItem(
  database: DatabaseSync,
  delivery: CollectiveDelivery,
): void {
  transaction(database, () => {
    const operation = findCollective(database, delivery.operationId);
    if (operation === undefined) {
      throw new StoreSignal("not-found");
    }
    if (operation.phase === "collecting") {
      throw new StoreSignal("conflict");
    }
    requireEqual(operation.deliveryToken, delivery.deliveryToken);
    if (delivery.firewall) {
      queueFirewallItem(database, delivery);
    } else {
      putInboxItem(database, delivery);
    }
    database
      .prepare(
        "UPDATE collective_operations SET phase = 'completed' WHERE operation_id = ?",
      )
      .run(delivery.operationId);
  });
}

/** Retain the first counted answer while the operation still collects. */
export function recordCollectiveAnswer(
  database: DatabaseSync,
  answer: CollectiveAnswerReference,
): string | undefined {
  return transaction(database, () => {
    const operation = findCollective(database, answer.operationId);
    if (operation?.phase !== "collecting") {
      return undefined;
    }
    const prior = database
      .prepare(
        "SELECT record_hash FROM collective_answers WHERE operation_id = ? AND member = ?",
      )
      .get(answer.operationId, answer.member);
    if (prior !== undefined) {
      return readText(prior, "record_hash");
    }
    const record = database
      .prepare(
        "SELECT conversation_id FROM certified_records WHERE record_hash = ?",
      )
      .get(answer.recordHash);
    if (record === undefined) {
      throw new StoreSignal("not-found");
    }
    database
      .prepare(
        "INSERT INTO collective_answers (operation_id, member, conversation_id, record_hash) VALUES (?, ?, ?, ?)",
      )
      .run(
        answer.operationId,
        answer.member,
        readText(record, "conversation_id"),
        answer.recordHash,
      );
    return answer.recordHash;
  });
}

/** Stable answer references survive loss of the classifier's memory. */
export function readCollectiveAnswers(
  database: DatabaseSync,
): readonly CollectiveAnswerReference[] {
  return database
    .prepare(
      "SELECT operation_id, member, record_hash FROM collective_answers ORDER BY rowid",
    )
    .all()
    .map((row) => ({
      operationId: readText(row, "operation_id"),
      member: readText(row, "member"),
      recordHash: readText(row, "record_hash"),
    }));
}

/** Confirmed pre-bind failures never turn into a new request on restart. */
export function recordCollectiveRefusal(
  database: DatabaseSync,
  refusal: CollectiveRequestRefusal,
): void {
  transaction(database, () => {
    const operation = findCollective(database, refusal.operationId);
    if (operation?.phase !== "collecting") {
      return;
    }
    const bound = database
      .prepare(
        "SELECT 1 FROM collective_messages WHERE operation_id = ? AND role = 'request' AND destination = ?",
      )
      .get(refusal.operationId, refusal.destination);
    if (bound !== undefined) {
      throw new StoreSignal("conflict");
    }
    const prior = database
      .prepare(
        "SELECT canonical_refusal FROM collective_refusals WHERE operation_id = ? AND destination = ?",
      )
      .get(refusal.operationId, refusal.destination);
    if (prior !== undefined) {
      requireSameBytes(
        readBytes(prior, "canonical_refusal"),
        refusal.canonicalRefusal,
      );
      return;
    }
    database
      .prepare(
        "INSERT INTO collective_refusals (operation_id, destination, canonical_refusal) VALUES (?, ?, ?)",
      )
      .run(
        refusal.operationId,
        refusal.destination,
        copyBytes(refusal.canonicalRefusal),
      );
  });
}

/** Only unbound request destinations can have retained refusals. */
export function readCollectiveRefusals(
  database: DatabaseSync,
): readonly CollectiveRequestRefusal[] {
  return database
    .prepare(
      "SELECT operation_id, destination, canonical_refusal FROM collective_refusals ORDER BY rowid",
    )
    .all()
    .map((row) => ({
      operationId: readText(row, "operation_id"),
      destination: readText(row, "destination"),
      canonicalRefusal: readBytes(row, "canonical_refusal"),
    }));
}

/** A refused invocation or invalid remote close ends without inventing an inbox item. */
export function retireCollectiveOperation(
  database: DatabaseSync,
  operationId: string,
  canonicalSelection: Uint8Array,
): void {
  transaction(database, () => {
    const operation = findCollective(database, operationId);
    if (operation === undefined) {
      throw new StoreSignal("not-found");
    }
    if (operation.canonicalSelection !== undefined) {
      requireSameBytes(operation.canonicalSelection, canonicalSelection);
    }
    database
      .prepare(
        "UPDATE collective_operations SET phase = 'completed', canonical_selection = ? WHERE operation_id = ?",
      )
      .run(copyBytes(canonicalSelection), operationId);
  });
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
