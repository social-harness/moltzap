/** @file Policy-owned tables share the daemon database lifetime. */

import * as SqlClient from "@effect/sql/SqlClient";
import { Effect } from "effect";
import { storeOperation } from "../../communication/store/database/index.js";

const firewallSchemaSql = `
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
    canonical_result BLOB NOT NULL,
    decided_at INTEGER NOT NULL,
    disposition TEXT NOT NULL CHECK(disposition IN ('admitted','withheld'))
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
    delivery_token TEXT NOT NULL,
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
`;

/** Policy tables are created alongside protocol and inbox tables in one startup transaction. */
export function createFirewallTables() {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const statement of firewallSchemaSql
      .split(";")
      .map((part) => part.trim())
      .filter((part) => part.length > 0))
      yield* sql.unsafe<Readonly<Record<string, unknown>>>(statement);
  }).pipe(storeOperation);
}
