/** @file SQLite ownership, version preflight, and closed persistence primitives. */

import { Effect } from "effect";
// eslint-disable-next-line agent-code-guard/prefer-effect-platform -- Ownership requires synchronous permission changes before the database escapes acquisition.
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CertifiedRecord } from "../types.js";
import {
  migrateStore,
  migrations,
  type MigrationSteps,
  RESET_SCHEMA,
} from "./migrations.js";
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
export interface HistorySnapshot {
  readonly records: readonly CertifiedRecord[];
  readonly offset: number;
}

/** Exclusive SQLite state retained for one Effect scope. */
export interface StoreState {
  readonly database: DatabaseSync;
  readonly snapshots: Map<string, HistorySnapshot>;
  closed: boolean;
}

const DATABASE_NAME = "sharnessd.sqlite3";

/** An empty database is created, the current schema reopens, and an admitted older schema migrates. */
export type StoreOpening = "create" | "reopen" | "migrate";

/**
 * Acquires one endpoint database and finishes admitted upgrades before use.
 * @param stateDirectory Exclusive persistent state directory.
 * @param options Explicit live window and optional injected forward migration steps.
 * @param options.liveWireVersions Versions accepted for pending outbound envelopes.
 * @param options.migrations Destination-indexed forward steps, defaulting to the binary's table.
 * @returns Acquired database state after integrity and compatibility checks.
 */
export const openStoreState = (
  stateDirectory: string,
  options: {
    readonly liveWireVersions: readonly string[];
    readonly migrations?: MigrationSteps;
  },
): Effect.Effect<StoreState, EndpointStoreError | OutboxTooOldError> =>
  Effect.try({
    try: () =>
      initializeStoreState(
        stateDirectory,
        options.liveWireVersions,
        options.migrations,
      ),
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
      requireResetDirectory(stateDirectory);
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
  steps: MigrationSteps = migrations,
): StoreState {
  requireText(stateDirectory);
  requireResetDirectory(stateDirectory);
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  const databasePath = resolve(stateDirectory, DATABASE_NAME);
  const expected = inspectExistingDatabase(databasePath, steps);
  let database: DatabaseSync | undefined;
  try {
    database = openWritableDatabase(databasePath);
    database.exec("PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT");
    const disposition = preflightDatabase(database, steps);
    requireExpectedOpening(disposition, expected);
    if (disposition !== "create") {
      requireLiveOutbox(database, liveWireVersions);
    }
    if (disposition === "migrate") {
      upgradeDatabase(database, liveWireVersions, databasePath, steps);
    }
    chmodSync(stateDirectory, 0o700);
    chmodSync(databasePath, 0o600);
    configureDatabase(database);
    if (disposition === "create") {
      createStore(database, steps);
    }
    database.exec(
      "UPDATE firewall_checks SET disposition = 'interrupted' WHERE disposition = 'checking'",
    );
    return { database, snapshots: new Map(), closed: false };
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

function upgradeDatabase(
  database: DatabaseSync,
  liveWireVersions: readonly string[],
  databasePath: string,
  steps: MigrationSteps,
): void {
  requireLiveOutbox(database, liveWireVersions);
  migrateStore(database, readSchemaVersion(database), databasePath, steps);
  requireHealthyDatabase(database);
}

function inspectExistingDatabase(
  databasePath: string,
  steps: MigrationSteps = migrations,
): StoreOpening {
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
    return preflightDatabase(database, steps);
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

function preflightDatabase(
  database: DatabaseSync,
  steps: MigrationSteps,
): StoreOpening {
  const version = readSchemaVersion(database);
  if (version > schemaVersion(steps)) {
    throw new StoreSignal("newer-schema");
  }
  if (version === 0) {
    if (hasUserSchemaObjects(database)) {
      throw new StoreSignal("pre-reset");
    }
    requireHealthyDatabase(database);
    return "create";
  }
  if (version < RESET_SCHEMA) {
    throw new StoreSignal("pre-reset");
  }
  requireHealthyDatabase(database);
  return version === schemaVersion(steps) ? "reopen" : "migrate";
}

function readSchemaVersion(database: DatabaseSync): number {
  const row = database.prepare("PRAGMA user_version").get();
  if (row === undefined) {
    throw new StoreSignal("corrupt");
  }
  return readInteger(row, "user_version");
}

/** The highest registered destination is the schema created by this binary. */
function schemaVersion(steps: MigrationSteps): number {
  return Math.max(RESET_SCHEMA, ...Object.keys(steps).map(Number));
}

/** Pending envelopes must remain live before any schema step or backup is written. */
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

const runtimeSchemaSql = `
  CREATE TABLE runtime_inbox (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    delivery_token TEXT NOT NULL UNIQUE,
    canonical_item BLOB NOT NULL,
    canonical_guidance BLOB,
    acknowledged INTEGER NOT NULL DEFAULT 0 CHECK (acknowledged IN (0, 1))
  ) STRICT;
  CREATE INDEX runtime_inbox_unread ON runtime_inbox(sequence) WHERE acknowledged = 0;
  CREATE TABLE runtime_events (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    canonical_state BLOB NOT NULL
  ) STRICT;
`;

const firewallSchemaSql = `
  CREATE TABLE firewall_evidence (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    revision INTEGER NOT NULL CHECK (revision >= 0)
  ) STRICT;
  INSERT INTO firewall_evidence (singleton, revision) VALUES (1, 0);
  CREATE TABLE firewall_incoming (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    delivery_token TEXT NOT NULL UNIQUE,
    conversation TEXT NOT NULL,
    canonical_item BLOB NOT NULL,
    canonical_provenance BLOB,
    anchor INTEGER NOT NULL CHECK (anchor >= 0),
    check_id TEXT,
    disposition TEXT NOT NULL DEFAULT 'pending'
      CHECK (disposition IN ('pending', 'admitted', 'withheld'))
  ) STRICT;
  CREATE INDEX firewall_frontiers ON firewall_incoming(conversation, sequence)
    WHERE disposition = 'pending';
  CREATE INDEX firewall_pending_sequence ON firewall_incoming(sequence)
    WHERE disposition = 'pending';
  CREATE TABLE firewall_checks (
    check_id TEXT PRIMARY KEY,
    direction TEXT NOT NULL CHECK (direction IN ('incoming', 'outgoing')),
    revision INTEGER NOT NULL,
    canonical_candidate BLOB NOT NULL,
    canonical_input BLOB NOT NULL,
    canonical_result BLOB,
    disposition TEXT NOT NULL DEFAULT 'checking'
      CHECK (disposition IN ('checking', 'interrupted', 'stale', 'admitted', 'withheld'))
  ) STRICT;
  CREATE TABLE firewall_local_evidence (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation TEXT NOT NULL,
    anchor INTEGER NOT NULL CHECK (anchor >= 0),
    canonical_entry BLOB NOT NULL
  ) STRICT;
  CREATE INDEX firewall_local_evidence_window
    ON firewall_local_evidence(conversation, anchor);
  CREATE TABLE firewall_answers (
    conversation_id TEXT NOT NULL,
    record_hash TEXT NOT NULL,
    admitted INTEGER NOT NULL CHECK (admitted IN (0, 1)),
    PRIMARY KEY (conversation_id, record_hash),
    FOREIGN KEY (conversation_id, record_hash)
      REFERENCES certified_records(conversation_id, record_hash)
  ) STRICT;
  CREATE TRIGGER firewall_local_evidence_changed AFTER INSERT ON firewall_local_evidence BEGIN
    UPDATE firewall_evidence SET revision = revision + 1 WHERE singleton = 1;
  END;
  CREATE TRIGGER firewall_answers_changed AFTER INSERT ON firewall_answers BEGIN
    UPDATE firewall_evidence SET revision = revision + 1 WHERE singleton = 1;
  END;
  CREATE TRIGGER firewall_history_changed AFTER INSERT ON certified_records BEGIN
    UPDATE firewall_evidence SET revision = revision + 1 WHERE singleton = 1;
  END;
  CREATE TRIGGER firewall_intent_changed AFTER INSERT ON post_intents BEGIN
    UPDATE firewall_evidence SET revision = revision + 1 WHERE singleton = 1;
  END;
  CREATE TRIGGER firewall_visibility_changed AFTER INSERT ON runtime_inbox BEGIN
    UPDATE firewall_evidence SET revision = revision + 1 WHERE singleton = 1;
  END;
`;

const schemaSql = `
  CREATE TABLE identity_binding (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    agent_id TEXT NOT NULL,
    canonical_agent_card BLOB NOT NULL
  ) STRICT;
  CREATE TABLE post_intents (
    author_agent_id TEXT NOT NULL,
    post_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    membership_hash TEXT NOT NULL,
    canonical_intent BLOB NOT NULL,
    completed_record_hash TEXT,
    PRIMARY KEY (author_agent_id, post_id),
    FOREIGN KEY (conversation_id, membership_hash)
      REFERENCES memberships(conversation_id, membership_hash)
  ) STRICT;
  CREATE INDEX post_intents_unresolved ON post_intents(conversation_id)
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
    post_id TEXT NOT NULL,
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
    message_id TEXT NOT NULL UNIQUE,
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
    message_id TEXT UNIQUE,
    UNIQUE (conversation_id, record_hash),
    FOREIGN KEY (conversation_id, record_hash)
      REFERENCES staged_records(conversation_id, record_hash),
    FOREIGN KEY (message_id) REFERENCES outbound_messages(message_id)
  ) STRICT;
`;

const editablePolicySql = `
  CREATE TABLE firewall_policy (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    canonical_rules BLOB NOT NULL
  ) STRICT;
  CREATE TABLE firewall_activations (
    sequence INTEGER PRIMARY KEY,
    activated_at INTEGER NOT NULL,
    active_revision TEXT NOT NULL,
    added_rule_ids TEXT NOT NULL,
    removed_rule_ids TEXT NOT NULL
  ) STRICT;
  CREATE INDEX firewall_activations_time ON firewall_activations(activated_at);
  ALTER TABLE firewall_checks ADD COLUMN decided_at INTEGER;
  CREATE INDEX firewall_decisions_time ON firewall_checks(decided_at)
    WHERE decided_at IS NOT NULL;
`;

/** Creates the current schema atomically in an empty database. */
function createStore(database: DatabaseSync, steps: MigrationSteps): void {
  transaction(
    database,
    () => {
      database.exec(schemaSql);
      database.exec(runtimeSchemaSql);
      database.exec(firewallSchemaSql);
      database.exec(editablePolicySql);
      database.exec(`PRAGMA user_version = ${schemaVersion(steps)}`);
    },
    "EXCLUSIVE",
  );
}

/** Legacy state must never silently create a fresh identity beside its old database. */
function requireResetDirectory(stateDirectory: string): void {
  if (existsSync(resolve(stateDirectory, "moltzapd.sqlite3"))) {
    throw new StoreSignal("pre-reset");
  }
}
