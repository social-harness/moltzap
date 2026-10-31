/** @file Policy-owned tables share the daemon database lifetime. */

import * as SqlClient from "@effect/sql/SqlClient";
import { Effect } from "effect";
import { storeOperation } from "../../communication/store/database/index.js";
const firewallSchemaSql = `
  CREATE TABLE firewall_checks (
    check_id TEXT PRIMARY KEY,
    direction TEXT NOT NULL CHECK (direction IN ('incoming', 'outgoing')),
    canonical_candidate BLOB NOT NULL,
    canonical_input BLOB NOT NULL,
    canonical_result BLOB NOT NULL,
    decided_at INTEGER NOT NULL,
    disposition TEXT NOT NULL CHECK(disposition IN ('admitted','withheld'))
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
      .filter((part) => part.length > 0)) {
      yield* sql.unsafe<Readonly<Record<string, unknown>>>(statement);
    }
  }).pipe(storeOperation, Effect.withSpan("createFirewallTables"));
}
