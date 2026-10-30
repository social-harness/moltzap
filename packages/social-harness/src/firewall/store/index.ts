/** @file Completed policy decisions and editable rule persistence. */

/** Stored policy and decision values are interpreted by their domain owners. */
export type {
  FirewallActivation,
  FirewallCompletion,
  FirewallEvidence,
  FirewallEvidenceRange,
  FirewallEvidenceSlice,
  FirewallEvidenceSlices,
  FirewallHistoryEntry,
  FirewallInboxEntry,
  FirewallLocalAdmission,
  FirewallLocalEntry,
  FirewallRequestAdmission,
  ItemProjection,
} from "./types.js";
/** Rules and completed checks share the daemon's SQL client. */
export {
  decodeFirewallAuditEntry,
  queueFirewallItem,
  readDecisions,
  readFirewallActivations,
  readFirewallDecisions,
  readFirewallPolicy,
  readNextPendingMessages,
  readPendingFirewallItems,
  saveCheckDecision,
  withoutTraces,
  writeFirewallPolicy,
} from "./firewall.js";
