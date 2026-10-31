/** @file Detached endpoint state used by store mutations and recovery reads. */

import { Effect } from "effect";
import { readIdentityBinding } from "../../../identity/local-store.js";
import { EndpointStoreError } from "../database/index.js";
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
/** Protocol recovery reads the identity-owned binding without re-verifying its card. */
export function readStoredIdentity() {
  return readIdentityBinding().pipe(
    Effect.catchTag(
      "IdentityError",
      (error) =>
        new EndpointStoreError({
          reason:
            error.reason === "incompatible-daemon" ? "corrupt" : "persistence",
        }),
    ),
  );
}
