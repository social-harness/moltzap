/** @file SQLite ownership, current-format validation, and closed persistence primitives. */

import { Effect } from "effect";
// eslint-disable-next-line agent-code-guard/prefer-effect-platform -- Ownership requires synchronous permission changes before the database escapes acquisition.
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { CertifiedRecord } from "../types.js";

import {
  EndpointStoreError,
  mapStoreFailure,
  OutboxTooOldError,
  readInteger,
  readText,
  requireText,
  StoreSignal,
} from "./values.js";

/** One process-local frozen management read. */
interface HistorySnapshot {
  readonly records: readonly CertifiedRecord[];
  readonly offset: number;
}

/** Exclusive SQLite state retained for one Effect scope. */
export interface StoreState {
  readonly database: DatabaseSync;
  readonly opening: StoreOpening;
  readonly snapshots: Map<string, HistorySnapshot>;
  closed: boolean;
}

const DATABASE_NAME = "sharnessd.sqlite3";

const SCHEMA_VERSION = 16;

/** Only an empty database or the current stored format can be opened. */
export type StoreOpening = "create" | "reopen";

const collectiveSchemaSql = `
  CREATE TABLE collective_answers (
    operation_id TEXT NOT NULL REFERENCES collective_operations(operation_id),
    member TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    record_hash TEXT NOT NULL,
    PRIMARY KEY (operation_id, member),
    FOREIGN KEY (conversation_id, record_hash) REFERENCES certified_records(conversation_id, record_hash)
  ) STRICT;
  CREATE TABLE collective_refusals (
    operation_id TEXT NOT NULL REFERENCES collective_operations(operation_id),
    destination TEXT NOT NULL,
    canonical_refusal BLOB NOT NULL,
    PRIMARY KEY (operation_id, destination)
  ) STRICT;
  CREATE TABLE collective_operations (
    operation_id TEXT PRIMARY KEY,
    creator_agent_id TEXT NOT NULL,
    origin TEXT NOT NULL CHECK (origin IN ('local', 'remote')),
    request_conversation_id TEXT,
    request_record_hash TEXT,
    canonical_request BLOB NOT NULL,
    canonical_descriptor BLOB NOT NULL,
    phase TEXT NOT NULL DEFAULT 'collecting' CHECK (phase IN ('collecting', 'finalizing', 'completed')),
    canonical_selection BLOB,
    delivery_token TEXT NOT NULL UNIQUE,
    FOREIGN KEY (request_conversation_id, request_record_hash)
      REFERENCES certified_records(conversation_id, record_hash),
    CHECK ((origin = 'local' AND request_conversation_id IS NULL AND request_record_hash IS NULL)
      OR (origin = 'remote' AND request_conversation_id IS NOT NULL AND request_record_hash IS NOT NULL)),
    CHECK ((phase = 'collecting' AND canonical_selection IS NULL)
      OR (phase IN ('finalizing', 'completed') AND canonical_selection IS NOT NULL))
  ) STRICT;
  CREATE TABLE collective_messages (
    operation_id TEXT NOT NULL REFERENCES collective_operations(operation_id),
    role TEXT NOT NULL CHECK (role IN ('request', 'response', 'close')),
    destination TEXT NOT NULL,
    author_agent_id TEXT NOT NULL,
    msg_id TEXT NOT NULL,
    PRIMARY KEY (operation_id, role, destination),
    UNIQUE (author_agent_id, msg_id),
    FOREIGN KEY (author_agent_id, msg_id) REFERENCES message_intents(author_agent_id, msg_id)
  ) STRICT;
  CREATE UNIQUE INDEX collective_one_response ON collective_messages(operation_id) WHERE role = 'response';
  CREATE UNIQUE INDEX collective_one_close ON collective_messages(operation_id) WHERE role = 'close';
`;

const schemaSql = `
  CREATE TABLE identity_binding (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    agent_id TEXT NOT NULL,
    canonical_agent_card BLOB NOT NULL
  ) STRICT;
  CREATE TABLE message_intents (
    author_agent_id TEXT NOT NULL,
    msg_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    membership_hash TEXT NOT NULL,
    canonical_intent BLOB NOT NULL,
    completed_record_hash TEXT,
    PRIMARY KEY (author_agent_id, msg_id),
    FOREIGN KEY (conversation_id, membership_hash)
      REFERENCES memberships(conversation_id, membership_hash)
  ) STRICT;
  CREATE INDEX message_intents_unresolved ON message_intents(conversation_id)
    WHERE completed_record_hash IS NULL;
  CREATE TABLE memberships (
    conversation_id TEXT PRIMARY KEY,
    membership_hash TEXT NOT NULL,
    canonical_membership BLOB NOT NULL,
    UNIQUE (conversation_id, membership_hash)
  ) STRICT;
  CREATE TABLE anchors (
    conversation_id TEXT NOT NULL REFERENCES memberships(conversation_id),
    anchor_hash TEXT NOT NULL,
    previous_anchor_hash TEXT,
    selected_record_hash TEXT,
    canonical_anchor BLOB NOT NULL,
    PRIMARY KEY (conversation_id, anchor_hash)
  ) STRICT;
  CREATE TABLE conversation_state (
    conversation_id TEXT PRIMARY KEY REFERENCES memberships(conversation_id),
    membership_hash TEXT NOT NULL,
    current_anchor_hash TEXT NOT NULL,
    head_record_hash TEXT,
    head_ordinal INTEGER NOT NULL CHECK (head_ordinal >= -1),
    FOREIGN KEY (conversation_id, current_anchor_hash)
      REFERENCES anchors(conversation_id, anchor_hash)
  ) STRICT;
  CREATE TABLE proposal_locks (
    conversation_id TEXT NOT NULL REFERENCES memberships(conversation_id),
    predecessor_key TEXT NOT NULL,
    previous_record_hash TEXT,
    action_hash TEXT NOT NULL,
    canonical_action_core BLOB NOT NULL,
    PRIMARY KEY (conversation_id, predecessor_key),
    CHECK (
      (previous_record_hash IS NULL AND predecessor_key = '') OR
      (previous_record_hash IS NOT NULL AND predecessor_key = previous_record_hash)
    )
  ) STRICT;
  CREATE TABLE staged_records (
    conversation_id TEXT NOT NULL REFERENCES memberships(conversation_id),
    record_hash TEXT NOT NULL,
    previous_record_hash TEXT,
    membership_hash TEXT NOT NULL,
    anchor_hash TEXT NOT NULL,
    action_hash TEXT NOT NULL,
    author_agent_id TEXT NOT NULL,
    msg_id TEXT NOT NULL,
    canonical_record_core BLOB NOT NULL,
    PRIMARY KEY (conversation_id, record_hash),
    FOREIGN KEY (conversation_id, anchor_hash)
      REFERENCES anchors(conversation_id, anchor_hash)
  ) STRICT;
  CREATE TABLE protocol_evidence (
    conversation_id TEXT NOT NULL REFERENCES memberships(conversation_id),
    evidence_kind TEXT NOT NULL CHECK (
      evidence_kind IN ('action', 'durability', 'catch-up', 'reanchor')
    ),
    subject_id TEXT NOT NULL,
    evidence_key TEXT NOT NULL,
    canonical_evidence BLOB NOT NULL,
    PRIMARY KEY (conversation_id, evidence_kind, subject_id, evidence_key)
  ) STRICT;
  CREATE TABLE certified_records (
    conversation_id TEXT NOT NULL,
    record_hash TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    PRIMARY KEY (conversation_id, record_hash),
    UNIQUE (conversation_id, ordinal),
    FOREIGN KEY (conversation_id, record_hash)
      REFERENCES staged_records(conversation_id, record_hash)
  ) STRICT;
  CREATE INDEX certified_records_by_hash ON certified_records(record_hash);
  CREATE TABLE reanchors (
    conversation_id TEXT NOT NULL REFERENCES memberships(conversation_id),
    anchor_hash TEXT NOT NULL,
    previous_anchor_hash TEXT NOT NULL,
    router_instance_id TEXT NOT NULL,
    selected_record_hash TEXT NOT NULL,
    canonical_body BLOB NOT NULL,
    canonical_completed_reanchor BLOB,
    PRIMARY KEY (conversation_id, anchor_hash),
    UNIQUE (conversation_id, previous_anchor_hash, router_instance_id),
    FOREIGN KEY (conversation_id, previous_anchor_hash)
      REFERENCES anchors(conversation_id, anchor_hash),
    FOREIGN KEY (conversation_id, selected_record_hash)
      REFERENCES certified_records(conversation_id, record_hash)
  ) STRICT;
  CREATE TABLE pending_deliveries (
    delivery_sequence INTEGER PRIMARY KEY,
    delivery_token TEXT NOT NULL UNIQUE,
    conversation_id TEXT NOT NULL,
    record_hash TEXT NOT NULL,
    recipient_agent_id TEXT NOT NULL,
    canonical_message BLOB NOT NULL,
    acknowledged INTEGER NOT NULL DEFAULT 0 CHECK (acknowledged IN (0, 1)),
    UNIQUE (conversation_id, record_hash, recipient_agent_id),
    FOREIGN KEY (conversation_id, record_hash)
      REFERENCES certified_records(conversation_id, record_hash)
  ) STRICT;
  CREATE INDEX pending_deliveries_by_record ON pending_deliveries(record_hash);
  CREATE TABLE outbound_messages (
    outbound_sequence INTEGER PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES memberships(conversation_id),
    envelope_id TEXT NOT NULL UNIQUE,
    canonical_signed_message BLOB NOT NULL,
    wire_version TEXT NOT NULL,
    attempted INTEGER NOT NULL CHECK (attempted IN (0, 1)),
    disposition TEXT NOT NULL CHECK (
      disposition IN ('pending', 'accepted', 'discarded')
    )
  ) STRICT;
  CREATE TABLE dissemination_obligations (
    obligation_sequence INTEGER PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    record_hash TEXT NOT NULL,
    envelope_id TEXT UNIQUE,
    UNIQUE (conversation_id, record_hash),
    FOREIGN KEY (conversation_id, record_hash)
      REFERENCES staged_records(conversation_id, record_hash),
    FOREIGN KEY (envelope_id) REFERENCES outbound_messages(envelope_id)
  ) STRICT;
`;

/**
 * Acquires one endpoint database after validating its current format.
 * @param stateDirectory Exclusive persistent state directory.
 * @param options Explicit live window for retained outbound messages.
 * @param options.liveWireVersions Versions accepted for pending outbound envelopes.
 * @returns Acquired database state after integrity and compatibility checks.
 */
export const openStoreState = (
  stateDirectory: string,
  options: {
    readonly liveWireVersions: readonly string[];
  },
): Effect.Effect<StoreState, EndpointStoreError | OutboxTooOldError> =>
  Effect.try({
    try: () => initializeStoreState(stateDirectory, options.liveWireVersions),
    catch: (failure) =>
      failure instanceof OutboxTooOldError
        ? failure
        : mapStoreFailure(failure, "persistence"),
  });

/**
 * Reads, without writing, how the store in `stateDirectory` would open. An
 * incompatible or corrupt database fails as `openStoreState` would.
 * @param stateDirectory Exclusive persistent state directory.
 * @returns How `openStoreState` will open the store.
 */
export const inspectStoreState = (
  stateDirectory: string,
): Effect.Effect<StoreOpening, EndpointStoreError> =>
  Effect.try({
    try: () => {
      requireText(stateDirectory);
      const databasePath = resolve(stateDirectory, DATABASE_NAME);
      return inspectExistingDatabase(databasePath);
    },
    catch: (failure) => mapStoreFailure(failure, "persistence"),
  });

/**
 * Closes exactly the SQLite and volatile snapshot state in this scope.
 * @param state Acquired database and process-local snapshots.
 * @returns An infallible finalizer effect.
 */
export const closeStoreState = (state: StoreState): Effect.Effect<void> =>
  Effect.sync(() => {
    if (state.closed) {
      return;
    }
    state.closed = true;
    state.snapshots.clear();
    try {
      state.database.close();
      // eslint-disable-next-line agent-code-guard/bare-catch, no-empty -- Finalization must remain infallible and disclose no SQLite diagnostic.
    } catch {}
  });

/**
 * Converts a synchronous store operation into the closed Effect channel.
 * @param state Acquired database and process-local snapshots.
 * @param operation Synchronous operation inside the ownership boundary.
 * @returns The operation in the closed store error channel.
 */
export function runStoreOperation<Value>(
  state: StoreState,
  operation: () => Value,
): Effect.Effect<Value, EndpointStoreError> {
  return Effect.try({
    try: () => {
      if (state.closed) {
        throw new StoreSignal("closed");
      }
      return operation();
    },
    catch: (failure) => mapStoreFailure(failure, "persistence"),
  });
}

/**
 * Runs one non-yielding SQLite transaction. Explicit or automatic rollback
 * before a commit attempt excludes a commit. An active failed transaction
 * and an unconfirmed commit require recovery on a fresh connection.
 * @param database Exclusively owned endpoint database.
 * @param operation Non-yielding transition to commit atomically.
 * @param mode SQLite write-lock mode.
 * @returns The committed transition result.
 */
export function transaction<Value>(
  database: DatabaseSync,
  operation: () => Value,
  mode: "IMMEDIATE" | "EXCLUSIVE" = "IMMEDIATE",
): Value {
  let commitAttempted = false;
  try {
    database.exec(`BEGIN ${mode}`);
    const value = operation();
    commitAttempted = true;
    database.exec("COMMIT");
    return value;
  } catch (failure) {
    const rolledBack = database.isTransaction && rollback(database);
    const error = mapStoreFailure(failure, "persistence");
    if (error.reason !== "persistence") {
      throw error;
    }
    throw new EndpointStoreError({
      reason: error.reason,
      commitOutcome:
        rolledBack || (!commitAttempted && !database.isTransaction)
          ? "not-committed"
          : undefined,
    });
  }
}

/** Creates protocol tables inside the caller's initial schema transaction. */
export function createCommunicationTables(database: DatabaseSync): void {
  database.exec(schemaSql);
  database.exec(collectiveSchemaSql);
  database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

/** Rollback failure preserves the original error and forces conservative recovery. */
function rollback(database: DatabaseSync): boolean {
  try {
    database.exec("ROLLBACK");
    return true;
    // eslint-disable-next-line agent-code-guard/bare-catch -- Rollback failure is outcome evidence, never a replacement diagnostic.
  } catch {
    return false;
  }
}

function initializeStoreState(
  stateDirectory: string,
  liveWireVersions: readonly string[],
): StoreState {
  requireText(stateDirectory);
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  const databasePath = resolve(stateDirectory, DATABASE_NAME);
  const expected = inspectExistingDatabase(databasePath);
  let database: DatabaseSync | undefined;
  try {
    database = openWritableDatabase(databasePath);
    database.exec("PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT");
    const disposition = preflightDatabase(database);
    requireExpectedOpening(disposition, expected);
    if (disposition !== "create") {
      requireLiveOutbox(database, liveWireVersions);
    }
    chmodSync(stateDirectory, 0o700);
    chmodSync(databasePath, 0o600);
    configureDatabase(database);
    return {
      database,
      opening: disposition,
      snapshots: new Map(),
      closed: false,
    };
  } catch (failure) {
    try {
      database?.close();
      // eslint-disable-next-line agent-code-guard/bare-catch, no-empty -- Failed acquisition closes best-effort without replacing the startup failure.
    } catch {}
    throw failure;
  }
}

function requireExpectedOpening(
  disposition: StoreOpening,
  expected?: StoreOpening,
): void {
  if (expected !== undefined && expected !== disposition) {
    throw new StoreSignal("incompatible");
  }
}

function inspectExistingDatabase(databasePath: string): StoreOpening {
  if (!existsSync(databasePath)) {
    return "create";
  }
  const database = new DatabaseSync(databasePath, {
    readOnly: true,
    enableForeignKeyConstraints: false,
    enableDoubleQuotedStringLiterals: false,
    allowExtension: false,
    timeout: 0,
  });
  try {
    return preflightDatabase(database);
  } finally {
    database.close();
  }
}

function openWritableDatabase(databasePath: string): DatabaseSync {
  return new DatabaseSync(databasePath, {
    enableForeignKeyConstraints: true,
    enableDoubleQuotedStringLiterals: false,
    allowExtension: false,
    timeout: 0,
  });
}

function preflightDatabase(database: DatabaseSync): StoreOpening {
  const version = readSchemaVersion(database);
  if (version === 0 && !hasUserSchemaObjects(database)) {
    requireHealthyDatabase(database);
    return "create";
  }
  if (version !== SCHEMA_VERSION) {
    throw new StoreSignal("incompatible");
  }
  requireHealthyDatabase(database);
  return "reopen";
}

function readSchemaVersion(database: DatabaseSync): number {
  const row = database.prepare("PRAGMA user_version").get();
  if (row === undefined) {
    throw new StoreSignal("corrupt");
  }
  return readInteger(row, "user_version");
}

/** Pending envelopes must remain live before startup changes retained state. */
function requireLiveOutbox(
  database: DatabaseSync,
  liveWireVersions: readonly string[],
): void {
  const rows = database
    .prepare(
      "SELECT wire_version FROM outbound_messages WHERE disposition = 'pending'",
    )
    .all();
  for (const row of rows) {
    if (!liveWireVersions.includes(readText(row, "wire_version"))) {
      throw new OutboxTooOldError();
    }
  }
}

function hasUserSchemaObjects(database: DatabaseSync): boolean {
  return (
    database
      .prepare(
        `SELECT 1 AS retained FROM sqlite_schema
         WHERE type IN ('table', 'index', 'view', 'trigger')
           AND name NOT LIKE 'sqlite_%'
         LIMIT 1`,
      )
      .get() !== undefined
  );
}

function requireHealthyDatabase(database: DatabaseSync): void {
  const check = database.prepare("PRAGMA quick_check").all();
  const checkRow = check[0];
  if (
    check.length !== 1 ||
    checkRow === undefined ||
    readText(checkRow, "quick_check") !== "ok"
  ) {
    throw new StoreSignal("corrupt");
  }
}

function configureDatabase(database: DatabaseSync): void {
  database.exec("PRAGMA busy_timeout = 0");
  database.exec("PRAGMA foreign_keys = ON");
  const journal = database.prepare("PRAGMA journal_mode = WAL").get();
  const locking = database.prepare("PRAGMA locking_mode = EXCLUSIVE").get();
  database.exec("PRAGMA synchronous = FULL");
  const foreignKeys = database.prepare("PRAGMA foreign_keys").get();
  const synchronous = database.prepare("PRAGMA synchronous").get();
  requireTextPragma("journal_mode", "wal", journal);
  requireTextPragma("locking_mode", "exclusive", locking);
  requireIntegerPragma("foreign_keys", 1, foreignKeys);
  requireIntegerPragma("synchronous", 2, synchronous);
}

function requireTextPragma(
  key: string,
  expected: string,
  row?: Readonly<Record<string, unknown>>,
): void {
  if (row === undefined) {
    throw new StoreSignal("persistence");
  }
  if (readText(row, key) !== expected) {
    throw new StoreSignal("persistence");
  }
}

function requireIntegerPragma(
  key: string,
  expected: number,
  row?: Readonly<Record<string, unknown>>,
): void {
  if (row === undefined) {
    throw new StoreSignal("persistence");
  }
  if (readInteger(row, key) !== expected) {
    throw new StoreSignal("persistence");
  }
}
