/** @file Private typed contract for endpoint persistence operations. */

import type { Effect } from "effect";
import type { EndpointStoreError } from "./database/values.js";
import { canonicalIdentifier } from "../../encoding/identifier.js";

/* eslint-disable @typescript-eslint/naming-convention, @typescript-eslint/no-redeclare -- The private Effect Schema and decoded nominal value intentionally share one domain name. */

/** Stable opaque identity for one durable inbound delivery. */
export const DeliveryToken = canonicalIdentifier("DeliveryToken", "dlv_", 32);

/** Strictly decoded private durable delivery identity. */
export type DeliveryToken = typeof DeliveryToken.Type;

/* eslint-enable @typescript-eslint/naming-convention, @typescript-eslint/no-redeclare -- Restore defaults after the private Schema/type pair. */

/** Whether an idempotent mutation inserted state or observed the same state. */
export type StoreMutation = "inserted" | "existing";

/**
 * Whether a store error refuses the input itself, because it conflicts with
 * durable state or is invalid, rather than reporting a failed store.
 * @param error A closed endpoint-store error.
 * @returns Whether the store refused the input.
 */
export function isSemanticStoreRejection(error: EndpointStoreError): boolean {
  return error.reason === "conflict" || error.reason === "invalid-input";
}

/** Canonical bytes bound to the one local identity. */
export interface IdentityBinding {
  readonly agentId: string;
  readonly canonicalAgentCard: Uint8Array;
}

/** One locally authored immutable message intent and its completion. */
export interface MessageIntent {
  readonly conversationId: string;
  readonly membershipHash: string;
  readonly authorAgentId: string;
  readonly msgId: string;
  readonly canonicalIntent: Uint8Array;
  readonly completedRecordHash?: string;
}

/** Atomic binding for a message in either retained or newly founded history. */
export type MessageIntentBinding = {
  readonly collective?: CollectiveMessageBinding;
} & (
  | Readonly<{
      kind: "existing-conversation";
      intent: MessageIntent;
    }>
  | Readonly<{
      kind: "new-conversation";
      foundation: ConversationFoundation;
      intent: MessageIntent;
    }>
);

/** Immutable membership and initial Router anchor for one conversation. */
export interface ConversationFoundation {
  readonly conversationId: string;
  readonly membershipHash: string;
  readonly canonicalMembership: Uint8Array;
  readonly anchorHash: string;
  readonly canonicalAnchor: Uint8Array;
}

/** One immutable membership descriptor recovered independently of anchors. */
export interface StoredMembership {
  readonly conversationId: string;
  readonly membershipHash: string;
  readonly canonicalMembership: Uint8Array;
}

/** One initial or completed Router-epoch anchor in the retained chain. */
export interface StoredAnchor {
  readonly conversationId: string;
  readonly anchorHash: string;
  readonly previousAnchorHash?: string;
  readonly selectedRecordHash?: string;
  readonly canonicalAnchor: Uint8Array;
}

/** The first Router-ordered action selected for one predecessor. */
export interface ProposalLock {
  readonly conversationId: string;
  readonly previousRecordHash?: string;
  readonly actionHash: string;
  readonly canonicalActionCore: Uint8Array;
}

/** One exact record core staged before a durability vote. */
export interface StagedRecord {
  readonly conversationId: string;
  readonly recordHash: string;
  readonly previousRecordHash?: string;
  readonly membershipHash: string;
  readonly anchorHash: string;
  readonly actionHash: string;
  readonly authorAgentId: string;
  readonly msgId: string;
  readonly canonicalRecordCore: Uint8Array;
}

/** Mergeable protocol evidence addressed by its stable private identity. */
export interface ProtocolEvidence {
  readonly conversationId: string;
  readonly kind: "action" | "durability" | "catch-up" | "reanchor";
  readonly subjectId: string;
  readonly evidenceKey: string;
  readonly canonicalEvidence: Uint8Array;
}

/** One certified record with action and durability evidence kept separate. */
export interface CertifiedRecord extends StagedRecord {
  readonly actionEvidence: readonly ProtocolEvidence[];
  readonly durabilityEvidence: readonly ProtocolEvidence[];
}

/** Canonical host message inserted when a remote record becomes certified. */
export interface InboundDeliveryInput {
  readonly recipientAgentId: string;
  readonly canonicalMessage: Uint8Array;
}

/** One stable pending runtime delivery, including its retained tombstone. */
export interface PendingDelivery extends InboundDeliveryInput {
  readonly deliveryToken: DeliveryToken;
  readonly conversationId: string;
  readonly recordHash: string;
  readonly acknowledged: boolean;
}

/** Canonical complete outer message before it receives a stable outbox key. */
export interface OutboundMessageInput {
  readonly wireVersion: string;
  readonly conversationId: string;
  readonly envelopeId: string;
  readonly canonicalSignedMessage: Uint8Array;
}

/** One immutable signed envelope retained across transport retries. */
export type StoredOutboundMessage = OutboundMessageInput;

/**
 * A staged action-certified record this endpoint still owes its members,
 * until its outer envelope is attached to an outbox row.
 */
export interface DisseminationObligation {
  readonly conversationId: string;
  readonly recordHash: string;
}

/** Durable disposition chosen immediately before one Router attempt. */
export type OutboundAttempt =
  | Readonly<{ kind: "inactive" }>
  | Readonly<{
      kind: "pending";
      mode: "initial" | "retry";
      outbound: StoredOutboundMessage;
    }>;

/** Exact empty-history Router-anchor replacement guarded by the old foundation. */
export interface EmptyConversationRestart {
  readonly expectedFoundation: ConversationFoundation;
  readonly replacementFoundation: ConversationFoundation;
}

/** Durable state retained after an empty conversation changes Router instance. */
export interface RestartedEmptyConversation {
  readonly foundation: ConversationFoundation;
  readonly messageIntents: readonly MessageIntent[];
}

/** One staged Router-epoch proposal. */
export interface StagedReanchor {
  readonly conversationId: string;
  readonly anchorHash: string;
  readonly previousAnchorHash: string;
  readonly routerInstanceId: string;
  readonly selectedRecordHash: string;
  readonly canonicalBody: Uint8Array;
}

/** One completed Router-epoch proposal and its threshold evidence. */
export interface CompletedReanchor extends StagedReanchor {
  readonly canonicalCompletedReanchor: Uint8Array;
}

/** One recoverable re-anchor candidate, complete only when evidence is present. */
export interface RecoveredReanchor extends StagedReanchor {
  readonly canonicalCompletedReanchor?: Uint8Array;
}

/** One durable current position for a conversation. */
export interface ConversationPosition {
  readonly conversationId: string;
  readonly membershipHash: string;
  readonly currentAnchorHash: string;
  readonly headRecordHash?: string;
}

/** Complete private state recovered after opening the endpoint database. */
export interface EndpointRecovery {
  readonly identity?: IdentityBinding;
  readonly messageIntents: readonly MessageIntent[];
  readonly memberships: readonly StoredMembership[];
  readonly anchors: readonly StoredAnchor[];
  readonly positions: readonly ConversationPosition[];
  readonly proposalLocks: readonly ProposalLock[];
  readonly stagedRecords: readonly StagedRecord[];
  readonly evidence: readonly ProtocolEvidence[];
  readonly certifiedRecords: readonly CertifiedRecord[];
  readonly stagedReanchors: readonly RecoveredReanchor[];
  readonly pendingDeliveries: readonly PendingDelivery[];
  readonly disseminationObligations: readonly DisseminationObligation[];
  readonly outboundMessages: readonly StoredOutboundMessage[];
}

/** One management page over local conversation identifiers. */
export interface ConversationPage {
  readonly conversationIds: readonly string[];
  readonly hasMore: boolean;
}

/** One frozen management page of complete certified records. */
export interface HistoryPage {
  readonly records: readonly CertifiedRecord[];
  readonly continuation: string | null;
}

/** Private durable operations owned by one daemon process. */
export interface EndpointStore {
  readonly recordCollectiveAnswer: (
    answer: CollectiveAnswerReference,
  ) => Effect.Effect<string | undefined, EndpointStoreError>;
  readonly readCollectiveAnswers: () => Effect.Effect<
    readonly CollectiveAnswerReference[],
    EndpointStoreError
  >;
  readonly recordCollectiveRefusal: (
    refusal: CollectiveRequestRefusal,
  ) => Effect.Effect<void, EndpointStoreError>;
  readonly readCollectiveRefusals: () => Effect.Effect<
    readonly CollectiveRequestRefusal[],
    EndpointStoreError
  >;
  readonly retireCollectiveOperation: (
    operationId: string,
    canonicalSelection: Uint8Array,
  ) => Effect.Effect<void, EndpointStoreError>;

  readonly putCollectiveOperation: (
    input: CollectiveOperationInput,
  ) => Effect.Effect<StoreMutation, EndpointStoreError>;
  readonly readCollectiveOperation: (
    operationId: string,
  ) => Effect.Effect<StoredCollectiveOperation | undefined, EndpointStoreError>;
  readonly readCollectiveOperations: () => Effect.Effect<
    readonly StoredCollectiveOperation[],
    EndpointStoreError
  >;
  readonly readCollectiveMessages: (query?: {
    readonly operationId: string;
    readonly role?: StoredCollectiveMessage["role"];
  }) => Effect.Effect<readonly StoredCollectiveMessage[], EndpointStoreError>;
  readonly finalizeCollectiveOperation: (
    operationId: string,
    canonicalSelection: Uint8Array,
  ) => Effect.Effect<StoreMutation, EndpointStoreError>;
  readonly readIdentity: () => Effect.Effect<
    IdentityBinding | undefined,
    EndpointStoreError
  >;
  readonly bindIdentity: (
    binding: IdentityBinding,
  ) => Effect.Effect<StoreMutation, EndpointStoreError>;
  readonly bindMessageIntent: (
    binding: MessageIntentBinding,
  ) => Effect.Effect<StoreMutation, EndpointStoreError>;
  readonly putConversationFoundation: (
    foundation: ConversationFoundation,
  ) => Effect.Effect<StoreMutation, EndpointStoreError>;
  readonly lockProposal: (
    proposal: ProposalLock,
  ) => Effect.Effect<StoreMutation, EndpointStoreError>;
  readonly lockFirstMessageProposal: (
    foundation: ConversationFoundation,
    proposal: ProposalLock,
  ) => Effect.Effect<StoreMutation, EndpointStoreError>;
  readonly supersedeProposalLock: (
    lock: ProposalLock,
    certificate: readonly ProtocolEvidence[],
  ) => Effect.Effect<StoreMutation, EndpointStoreError>;
  readonly stageRecordForDissemination: (
    record: StagedRecord,
  ) => Effect.Effect<StoreMutation, EndpointStoreError>;
  readonly mergeEvidence: (
    evidence: ProtocolEvidence,
  ) => Effect.Effect<StoreMutation, EndpointStoreError>;
  readonly promoteRecord: (
    record: CertifiedRecord,
    delivery?: InboundDeliveryInput,
  ) => Effect.Effect<StoreMutation, EndpointStoreError>;
  /** Stage, certify and promote a record received whole, in one transaction. */
  readonly applyCertifiedRecord: (
    record: CertifiedRecord,
    delivery?: InboundDeliveryInput,
  ) => Effect.Effect<StoreMutation, EndpointStoreError>;
  readonly stageReanchor: (
    reanchor: StagedReanchor,
  ) => Effect.Effect<StoreMutation, EndpointStoreError>;
  readonly completeReanchor: (
    reanchor: CompletedReanchor,
  ) => Effect.Effect<StoreMutation, EndpointStoreError>;
  readonly applyCatchUpReanchor: (
    reanchor: CompletedReanchor,
  ) => Effect.Effect<StoreMutation, EndpointStoreError>;
  /** Replay includes acknowledged rows in their original delivery order. */
  readonly readRetainedDeliveries: () => Effect.Effect<
    readonly PendingDelivery[],
    EndpointStoreError
  >;
  readonly readPendingDeliveries: () => Effect.Effect<
    readonly PendingDelivery[],
    EndpointStoreError
  >;
  readonly acknowledgeDelivery: (
    deliveryToken: DeliveryToken,
  ) => Effect.Effect<StoreMutation, EndpointStoreError>;
  readonly enqueueOutbound: (
    message: OutboundMessageInput,
  ) => Effect.Effect<StoredOutboundMessage, EndpointStoreError>;
  readonly enqueueDisseminationOutbound: (
    obligation: DisseminationObligation,
    message: OutboundMessageInput,
  ) => Effect.Effect<StoredOutboundMessage, EndpointStoreError>;
  readonly beginOutbound: (
    envelopeId: string,
  ) => Effect.Effect<OutboundAttempt, EndpointStoreError>;
  readonly completeOutbound: (
    outbound: StoredOutboundMessage,
  ) => Effect.Effect<StoreMutation, EndpointStoreError>;
  readonly discardOutbound: (
    outbounds: readonly StoredOutboundMessage[],
  ) => Effect.Effect<StoreMutation, EndpointStoreError>;
  readonly restartEmptyConversation: (
    restart: EmptyConversationRestart,
  ) => Effect.Effect<RestartedEmptyConversation, EndpointStoreError>;
  readonly searchConversations: (input?: {
    readonly afterConversationId?: string;
  }) => Effect.Effect<ConversationPage, EndpointStoreError>;
  readonly readConversation: (
    request:
      | Readonly<{
          conversationId: string;
          afterRecordHash?: string;
        }>
      | Readonly<{ continuation: string }>,
  ) => Effect.Effect<HistoryPage, EndpointStoreError>;
  readonly releaseContinuation: (
    continuation: string,
  ) => Effect.Effect<void, EndpointStoreError>;
  /** A fresh durable snapshot, optionally restricted to one conversation. */
  readonly recover: (
    conversationId?: string,
  ) => Effect.Effect<EndpointRecovery, EndpointStoreError>;
}

/** A remote request is identified by its authenticated certified record. */
type CollectiveOrigin =
  | { readonly kind: "local" }
  | {
      readonly kind: "remote";
      readonly recordHash: string;
    };

/** Immutable request identity and the descriptor its collective owner interprets. */
export interface CollectiveOperationInput {
  readonly operationId: string;
  readonly origin: CollectiveOrigin;
  readonly canonicalRequest: Uint8Array;
  readonly canonicalDescriptor: Uint8Array;
}

/** Selection freezes before a close binds; completion commits with its one terminal item. */
export interface StoredCollectiveOperation extends CollectiveOperationInput {
  readonly creatorAgentId: string;
  readonly origin:
    | Extract<CollectiveOrigin, { readonly kind: "local" }>
    | (Extract<CollectiveOrigin, { readonly kind: "remote" }> & {
        readonly conversationId: string;
      });
  readonly phase: "collecting" | "finalizing" | "completed";
  readonly canonicalSelection?: Uint8Array;
  readonly deliveryToken: DeliveryToken;
}

/** A collective owns one immutable message per role and destination. */
export interface CollectiveMessageBinding {
  readonly operationId: string;
  readonly role: "request" | "response" | "close";
  readonly destination: string;
  readonly operation?: CollectiveOperationInput;
}

/** Existing message intents own retries and certified completion across restart. */
export interface StoredCollectiveMessage extends CollectiveMessageBinding {
  readonly intent: MessageIntent;
}

/** Counted answers retain certified references; their content remains in certified history. */
export interface CollectiveAnswerReference {
  readonly operationId: string;
  readonly member: string;
  readonly recordHash: string;
}

/** A request that bound no intent is terminal for that member of this invocation. */
export interface CollectiveRequestRefusal {
  readonly operationId: string;
  readonly destination: string;
  readonly canonicalRefusal: Uint8Array;
}
