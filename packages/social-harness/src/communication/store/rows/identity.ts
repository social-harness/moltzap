/** @file The authenticated local identity shared by durable row checks. */

import type { DatabaseSync } from "node:sqlite";
import type { IdentityBinding } from "../types.js";
import { readBytes, readText } from "../database/index.js";

/**
 * Reads the optional singleton identity binding.
 *
 * @param database Exclusively owned endpoint database.
 * @returns The detached identity binding when one is committed.
 */
export function readStoredIdentity(
  database: DatabaseSync,
): IdentityBinding | undefined {
  const row = database
    .prepare(
      "SELECT agent_id, canonical_agent_card FROM identity_binding WHERE singleton = 1",
    )
    .get();
  return row === undefined
    ? undefined
    : Object.freeze({
        agentId: readText(row, "agent_id"),
        canonicalAgentCard: readBytes(row, "canonical_agent_card"),
      });
}
