/** @file Forward-only SQLite upgrades and durable, replaceable pre-upgrade backups. */

import type { DatabaseSync } from "node:sqlite";
import {
  closeSync,
  fchmodSync,
  fsyncSync,
  openSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname } from "node:path";
import { StoreSignal } from "./values.js";

/** Lowest schema admitted to forward upgrades; raising it establishes a reset boundary. */
export const RESET_SCHEMA = 10;

/** Destination schema numbers map to the one step from their immediate predecessor. */
export type MigrationSteps = Readonly<
  Record<number, (database: DatabaseSync) => void>
>;

/**
 * Forward steps available to the production binary. Retired state is dropped,
 * and unresolved intents are indexed by the conversation their evidence affects.
 */
export const migrations: MigrationSteps = Object.freeze({
  11: (database: DatabaseSync) => {
    database.exec("DROP TABLE IF EXISTS runtime_sends");
  },
  12: (database: DatabaseSync) => {
    database.exec(
      "CREATE INDEX IF NOT EXISTS post_intents_unresolved ON post_intents(conversation_id) WHERE completed_record_hash IS NULL",
    );
  },
});

/**
 * Publishes a fresh backup before committing each numbered step independently.
 * Missing steps fail before backup publication, and failed steps retain their predecessor.
 * @param database Exclusively owned endpoint database.
 * @param from Persisted schema number already admitted by preflight.
 * @param databasePath Absolute database filename used for adjacent backups.
 * @param steps Destination-indexed steps, injectable for isolated migration exercises.
 */
export function migrateStore(
  database: DatabaseSync,
  from: number,
  databasePath: string,
  steps: MigrationSteps = migrations,
): void {
  const target = Math.max(RESET_SCHEMA, ...Object.keys(steps).map(Number));
  for (let version = from + 1; version <= target; version += 1) {
    if (steps[version] === undefined) {
      throw new StoreSignal("incompatible");
    }
  }
  writeBackup(database, from, databasePath);
  for (let version = from + 1; version <= target; version += 1) {
    const step = steps[version];
    if (step === undefined) {
      throw new StoreSignal("incompatible");
    }
    database.exec("BEGIN EXCLUSIVE");
    try {
      step(database);
      database.exec(`PRAGMA user_version = ${version}`);
      database.exec("COMMIT");
    } catch (failure) {
      database.exec("ROLLBACK");
      throw failure;
    }
  }
}

function writeBackup(
  database: DatabaseSync,
  from: number,
  databasePath: string,
): void {
  const backup = `${databasePath}.schema-${from}.backup`;
  const temporary = `${backup}.tmp`;
  rmSync(temporary, { force: true });
  const descriptor = openSync(temporary, "wx", 0o600);
  try {
    database.prepare("VACUUM INTO ?").run(temporary);
    fchmodSync(descriptor, 0o600);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, backup);
  const directory = openSync(dirname(backup), "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}
