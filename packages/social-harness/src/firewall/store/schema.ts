/** @file Policy-owned tables share the daemon database lifetime. */

import type { DatabaseSync } from "node:sqlite";

/** Called only inside the daemon's initial schema transaction. */
export function createFirewallTables(database: DatabaseSync): void {
  database.exec(`
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
    canonical_candidate BLOB NOT NULL,
    canonical_input BLOB NOT NULL,
    canonical_result BLOB,
    decided_at INTEGER,
    disposition TEXT NOT NULL DEFAULT 'checking'
      CHECK (disposition IN ('checking', 'interrupted', 'admitted', 'withheld'))
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
  CREATE INDEX firewall_decisions_time ON firewall_checks(decided_at)
    WHERE decided_at IS NOT NULL;
`);
}

/** Interrupted inference has no result or authority after restart. */
export function interruptFirewallAttempts(database: DatabaseSync): void {
  database.exec(
    "UPDATE firewall_checks SET disposition = 'interrupted' WHERE disposition = 'checking'",
  );
}
