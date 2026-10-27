/**
 * @file Certified history: the records the engine builds from its folds, and
 * the stored rows it reads back and verifies.
 */

/** Records and store rows built from an in-memory fold. */
export {
  anchorHashAtHead,
  inboundDelivery,
  makeActionCertifiedRecord,
  makeCertifiedRecord,
  protocolEvidence,
  recordAnchorHash,
  stagedRecord,
  storedCertifiedRecord,
} from "./build.js";
/** Signer order, shared with the re-anchor certificate. */
export { orderedSignatures } from "./certificates/index.js";
/** Stored rows read back, verified, and queried. */
export {
  anchorRouterInstanceId,
  decodeStoredAnchor,
  durablePosition,
  durableRouterInstanceId,
  observedAnchorIsResolved,
  observedHeadIsResolved,
  readStoredHistory,
  readStoredRecord,
  recordFromStore,
  stagedSuccessor,
  type StoredRowError,
  storedRowMatchesCore,
  verifyRecoveredHistory,
  verifyStoredMembership,
  verifyStoredMemberships,
  verifyStoredOutbounds,
} from "./stored.js";
