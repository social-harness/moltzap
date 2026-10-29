/** @file Private typed facade for one daemon-owned endpoint store. */

/** Closed error value and scoped store acquisition. */
export {
  EndpointStoreError,
  inspectEndpointStore,
  openEndpointStore,
} from "./store.js";
/** Closed non-diagnostic persistence failure categories, and how a store opens. */
export type { EndpointStoreFailure, StoreOpening } from "./database/index.js";
/** Canonical private DTOs and the EndpointStore capability. */
export type {
  CertifiedRecord,
  CompletedReanchor,
  ConversationFoundation,
  ConversationPage,
  ConversationPosition,
  DisseminationObligation,
  EmptyConversationRestart,
  EndpointRecovery,
  EndpointStore,
  FirewallActivation,
  FirewallAttempt,
  FirewallAuditEntry,
  FirewallCommit,
  FirewallCompletion,
  FirewallEvidence,
  FirewallEvidenceSlices,
  FirewallEvidenceSnapshot,
  FirewallHistoryEntry,
  FirewallInboxEntry,
  FirewallLocalAdmission,
  FirewallLocalEntry,
  FirewallRequestAdmission,
  HistoryPage,
  IdentityBinding,
  InboundDeliveryInput,
  InboxEntry,
  InboxPage,
  InboxSummary,
  OutboundAttempt,
  OutboundMessageInput,
  PendingDelivery,
  PostIntent,
  PostIntentBinding,
  ProposalLock,
  ProtocolEvidence,
  RecoveredReanchor,
  RestartedEmptyConversation,
  StagedReanchor,
  StagedRecord,
  StoredAnchor,
  StoredMembership,
  StoredOutboundMessage,
  StoreMutation,
} from "./types.js";
/** Stable opaque durable-delivery identity. */
export { DeliveryToken, MAXIMUM_RUNTIME_ITEM_BYTES } from "./types.js";
/** Whether a store error refuses its input rather than reporting a failed store. */
export { isSemanticStoreRejection } from "./types.js";

/** Canonical runtime persistence shares the store error vocabulary. */
export { decodeRuntimeValue, encodeRuntimeValue } from "./runtime-codec.js";

/** Pending envelopes cannot be re-signed when their live window expires. */
export { OutboxTooOldError } from "./database/values.js";
