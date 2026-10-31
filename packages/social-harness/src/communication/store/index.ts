/** @file Communication state operations using the daemon’s shared SQL client. */
// safer-arch-ignore no-inventory-barrel: Named SQL operations expose the communication state contract through one boundary without a second store interface.

/** Failures exposed by communication persistence. */
export { EndpointStoreError } from "./database/values.js";
/** How a daemon opens its exclusive store. */
export type { StoreOpening } from "./database/index.js";
/** Saved communication records and recovery state. */
export type {
  CertifiedRecord,
  ConversationFoundation,
  DisseminationObligation,
  EmptyConversationRestart,
  EndpointRecovery,
  HistoryPage,
  IdentityBinding,
  InboundDeliveryInput,
  MessageIntent,
  OutboundMessageInput,
  ProposalLock,
  ProtocolEvidence,
  RestartedEmptyConversation,
  StagedReanchor,
  StagedRecord,
  StoredMembership,
  StoredOutboundMessage,
  StoreMutation,
} from "./types.js";
/** Stable opaque durable-delivery identity. */
export { DeliveryToken } from "./types.js";
/** Whether a store error refuses its input rather than reporting a failed store. */
export { isSemanticStoreRejection } from "./types.js";
/** Canonical runtime persistence shares the store error vocabulary. */
export { decodeRuntimeValue, encodeRuntimeValue } from "./runtime-codec.js";
/** Pending envelopes cannot be re-signed when their live window expires. */
export { OutboxTooOldError } from "./database/values.js";
/** Immutable collective ownership, existing message claims, and terminal delivery. */
export type {
  CollectiveMessageBinding,
  CollectiveOperationInput,
  CollectiveRequestRefusal,
  StoredCollectiveMessage,
  StoredCollectiveOperation,
} from "./types.js";
/** Protocol writes and reads use the caller's shared SQL environment. */
export {
  applyCatchUpReanchor,
  bindIdentity,
  bindMessageIntent,
  completeReanchor,
  lockFirstMessageProposal,
  lockProposal,
  putConversationFoundation,
  restartEmptyConversation,
  stageReanchor,
} from "./anchors.js";
/** The saved identity is independent of the registered network services. */
export { readStoredIdentity as readIdentity } from "./rows/index.js";
/** Collective identities and accepted claims survive process interruption. */
export {
  finalizeCollectiveOperation,
  putCollectiveOperation,
  readCollectiveAnswers,
  readCollectiveMessages,
  readCollectiveOperation,
  readCollectiveOperations,
  readCollectiveRefusals,
  recordCollectiveAnswer,
  recordCollectiveRefusal,
  retireCollectiveOperation,
} from "./collectives.js";
/** Accepted work, certified history and network retry obligations share SQL transactions. */
export {
  acknowledgeDelivery,
  beginOutbound,
  completeOutbound,
  discardOutbound,
  enqueueDisseminationOutbound,
  enqueueOutbound,
  readPendingDeliveries,
  readRetainedDeliveries,
} from "./queues/index.js";
/** History pages remain anchored while later records are appended. */
export {
  readCertifiedMemberships,
  readStoredConversation as readConversation,
  recoverStoredState as recover,
} from "./reads.js";
/** Record acceptance retains exact bytes and separately attributed evidence. */
export {
  applyCertifiedRecord,
  mergeEvidence,
  promoteRecord,
  stageRecordForDissemination,
  supersedeProposalLock,
} from "./records.js";
