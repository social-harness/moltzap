/** @file Initial PostgreSQL schema for Registry metadata, cards, operations, and replay nonces. */

import { SqlClient } from "@effect/sql/SqlClient";
import { Effect } from "effect";

/** Canonical initial Registry schema exercised by Effect Migrator. */
export const registryMigration = Effect.gen(function* () {
  const sql = yield* SqlClient;
  yield* sql.unsafe(`
    CREATE TABLE sharness_registry_metadata (
      singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
      signer_thumbprint text NOT NULL
    );
    CREATE TABLE sharness_registry_agents (
      agent_id text PRIMARY KEY,
      principal_id text NOT NULL,
      agent_name text NOT NULL UNIQUE,
      public_key_thumbprint text NOT NULL UNIQUE,
      agent_card_bytes bytea NOT NULL
    );
    CREATE TABLE sharness_registry_operations (
      public_key_thumbprint text NOT NULL,
      operation_id text NOT NULL,
      request_bytes bytea NOT NULL,
      result_bytes bytea NOT NULL,
      PRIMARY KEY (public_key_thumbprint, operation_id)
    );
    CREATE TABLE sharness_registry_nonces (
      nonce text PRIMARY KEY,
      expires_at bigint NOT NULL
    );
    CREATE INDEX sharness_registry_nonces_expiry
      ON sharness_registry_nonces (expires_at);
  `);
}).pipe(Effect.withSpan("registryMigration"));
