/** @file Detached endpoint state used by store mutations and recovery reads. */

/** Local principal bound to this database. */
export { readStoredIdentity } from "./identity.js";

/** First-candidate locks are selected against one durable predecessor. */
export {
  findProposalLock,
  GENESIS_PREDECESSOR,
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

/** Collective identity and post ownership checks used inside existing transactions. */
export {
  bindCollectivePostInTransaction,
  findCollective,
  readCollective,
  retainCollectiveInTransaction,
} from "./collectives.js";
