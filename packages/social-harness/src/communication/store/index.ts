/** @file Private typed facade for one daemon-owned endpoint store. */

/** Closed error value and scoped store acquisition. */
export {
  EndpointStoreError,
  inspectEndpointStore,
  openEndpointStore,
} from "./store.js";
/** How a daemon opens its exclusive store. */
export type { StoreOpening } from "./database/index.js";
/** Canonical private DTOs and the EndpointStore capability. */
export type {
  CertifiedRecord,
  ConversationFoundation,
  DisseminationObligation,
  EmptyConversationRestart,
  EndpointRecovery,
  EndpointStore,
  FirewallActivation,
  FirewallAuditEntry,
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
  OutboundMessageInput,
  PostIntent,
  PostIntentBinding,
  ProposalLock,
  ProtocolEvidence,
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

/** Immutable collective ownership, existing post claims, and terminal delivery. */
export type {
  CollectiveOperationInput,
  CollectivePostBinding,
  CollectiveRequestRefusal,
  StoredCollectiveOperation,
  StoredCollectivePost,
} from "./types.js";
