import * as SqlClient from "@effect/sql/SqlClient";
import { EndpointStoreError, storeOperation } from "../database/index.js";
import { Effect } from "effect";
/** @file Detached endpoint state used by store mutations and recovery reads. */
import type { IdentityBinding } from "../types.js";
import { readBytes, readText } from "../database/index.js";
/** First-candidate locks are selected against one durable predecessor. */
export {
  findProposalLock,
  FIRST_MESSAGE_PREDECESSOR,
  lockProposalInTransaction,
  readConversationPosition,
  readProposalLock,
  readStoredPosition,
  releaseProposalLock,
} from "./proposals.js";
/** Complete records retain distinct action and durability evidence maps. */
export {
  findStagedRecord,
  readCertifiedRecord,
  readProtocolEvidence,
  readStagedRecord,
  requireSameRecord,
} from "./records.js";
/** Re-anchor identity and completed bytes remain separate from certified records. */
export {
  findStagedReanchor,
  readRecoveredReanchor,
  requireSameReanchor,
} from "./reanchors.js";
/**
 * Reads the optional singleton identity binding.
 *
 * @returns The detached identity binding when one is committed.
 */
export function readStoredIdentity(): Effect.Effect<
  IdentityBinding | undefined,
  EndpointStoreError,
  SqlClient.SqlClient
> {
  return Effect.gen(function* () {
    const database = yield* SqlClient.SqlClient;
    const row = (yield* database.unsafe<Readonly<Record<string, unknown>>>(
      "SELECT agent_id, canonical_agent_card FROM identity_binding WHERE singleton = 1",
      [],
    ))[0];
    return row === undefined
      ? undefined
      : Object.freeze({
          agentId: readText(row, "agent_id"),
          canonicalAgentCard: readBytes(row, "canonical_agent_card"),
        });
  }).pipe(storeOperation);
}
