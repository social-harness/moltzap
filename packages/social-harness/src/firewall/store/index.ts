/** @file Completed policy decisions and editable rule persistence. */

/** Stored policy and decision values are interpreted by their domain owners. */
export type {
  FirewallActivation,
  FirewallCompletion,
  FirewallEvidence,
  FirewallEvidenceRange,
  FirewallEvidenceSlices,
  FirewallEvidenceSlice,
  FirewallHistoryEntry,
  FirewallInboxEntry,
  FirewallLocalAdmission,
  FirewallLocalEntry,
  FirewallRequestAdmission,
  ItemProjection,
} from "./types.js";
/** Rules and completed checks share the daemon's SQL client. */
export {
  readFirewallPolicy,
  writeFirewallPolicy,
  readFirewallActivations,
  readFirewallDecisions,
  saveCheckDecision,
  readNextPendingMessages,
  readPendingFirewallItems,
  queueFirewallItem,
  decodeFirewallAuditEntry,
  readDecisions,
  withoutTraces,
} from "./firewall.js";
