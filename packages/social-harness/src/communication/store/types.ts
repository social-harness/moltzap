/** @file Private typed contract for endpoint persistence operations. */

import { type Effect, Schema } from "effect";
import type { EndpointStoreError } from "./database/values.js";
import { isCanonicalIdentifier } from "../../encoding/identifier.js";

/* eslint-disable @typescript-eslint/naming-convention, @typescript-eslint/no-redeclare -- The private Effect Schema and decoded nominal value intentionally share one domain name. */

/** Stable opaque identity for one durable inbound delivery. */
export const DeliveryToken = Schema.String.pipe(
  Schema.filter((value) => isCanonicalIdentifier("dlv_", value)),
  Schema.brand("DeliveryToken"),
);

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

/** Immutable classified item retained until the host accepts its delivery. */
export interface InboxEntry {
  readonly deliveryToken: DeliveryToken;
  readonly canonicalItem: Uint8Array;
  readonly canonicalGuidance?: Uint8Array;
  readonly sequence: number;
}

/** A bounded view below a fixed inbox sequence, independent of later arrivals. */
export interface InboxPage {
  readonly items: readonly InboxEntry[];
  readonly through: number;
  readonly nextAfter?: number;
}

/** Wakeup bookkeeping contains no peer content or collective protocol state. */
export interface InboxSummary {
  readonly pendingCount: number;
  readonly newestSequence: number;
}

/**
 * A certified evidence row retains its original bytes and local visibility.
 * `answer` says whether an admitted result showed this answer record to the
 * runtime or withheld it; it is absent for every other record.
 */
export interface FirewallHistoryEntry {
  readonly canonicalRecordCore: Uint8Array;
  readonly canonicalMembership: Uint8Array;
  readonly visible: boolean;
  readonly answer?: "admitted" | "withheld";
}

/**
 * Evidence of a local item the runtime was shown, such as a collective
 * result, which no certified record carries. Its entry bytes are the
 * delivery layer's own history projection.
 */
export interface FirewallLocalEntry {
  readonly canonicalEntry: Uint8Array;
}

/** One local item's evidence: the conversation address it belongs to and its entry. */
interface FirewallLocalEvidence extends FirewallLocalEntry {
  readonly conversation: string;
}

/** One retained runtime item, including its local guidance, fits in an inbox page. */
export const MAXIMUM_RUNTIME_ITEM_BYTES = 2 * 1024 * 1024;

/** One conversation's evidence window before one candidate. */
export interface FirewallEvidenceSlice {
  readonly pendingOutgoing: boolean;
  readonly history: ReadonlyArray<FirewallHistoryEntry | FirewallLocalEntry>;
  readonly overflow: boolean;
  readonly earlierHistoryOmitted: boolean;
  readonly candidate?: FirewallHistoryEntry;
}

/** Older records outside the window are distinct from a byte-bound evidence gap. */
export interface FirewallEvidence extends FirewallEvidenceSlice {
  readonly snapshot: FirewallEvidenceSnapshot;
}

/**
 * Where one evidence window ends and which conversation it reads: before an
 * incoming delivery's record, before a certified record, or the whole recent
 * window of a conversation for an outgoing candidate. `conversation` is the
 * conversation's canonical address, under which local evidence is kept.
 */
export interface FirewallEvidenceRange {
  readonly beforeDelivery?: DeliveryToken;
  readonly beforeRecord?: string;
  readonly conversationId?: string;
  readonly conversation?: string;
}

/** Bounded conversation queries and their observed facts are compared atomically at admission. */
export interface FirewallEvidenceSnapshot {
  readonly ranges: readonly FirewallEvidenceRange[];
  readonly maximumRecords: number;
  readonly digest: string;
}

/** Several windows read in one synchronous capture, one per checked text of a result. */
export interface FirewallEvidenceSlices {
  readonly snapshot: FirewallEvidenceSnapshot;
  readonly slices: readonly FirewallEvidenceSlice[];
}

/** A private classified item waiting for its conversation's admission frontier. */
export interface FirewallInboxEntry {
  readonly deliveryToken: DeliveryToken;
  readonly conversation: string;
  readonly canonicalItem: Uint8Array;
  /** Private facts the item's producer kept beside it, such as which records a result's answers came from. */
  readonly canonicalProvenance?: Uint8Array;
  readonly sequence: number;
}

/**
 * How a received request's admission settled: whether the runtime was shown
 * it, and the check that decided, when one ran. A request never queued, or
 * retired without a check, has neither.
 */
export interface FirewallRequestAdmission {
  readonly presented: boolean;
  readonly canonicalResult?: Uint8Array;
  readonly checkId?: string;
}

/**
 * One local item's admission: the queued bytes it was checked as, the
 * projection and guidance the runtime reads, the checks of its texts, the
 * answer records those checks showed or withheld, and the evidence later
 * checks read. `deterministic` records the one check of an item admitted
 * without inference, begun and completed inside the commit.
 */
export interface FirewallLocalAdmission {
  readonly queuedItem: Uint8Array;
  readonly item: Omit<InboxEntry, "sequence">;
  readonly completions: readonly FirewallCompletion[];
  readonly deterministic?: Omit<FirewallAttempt, "snapshot"> & {
    readonly canonicalResult: Uint8Array;
  };
  readonly answers: ReadonlyArray<{
    readonly recordHash: string;
    readonly admitted: boolean;
  }>;
  readonly evidence: FirewallLocalEvidence;
}

/** Candidate and evidence bytes are immutable before inference starts. */
export interface FirewallAttempt {
  readonly checkId: string;
  readonly direction: "incoming" | "outgoing";
  readonly snapshot: FirewallEvidenceSnapshot;
  readonly canonicalCandidate: Uint8Array;
  readonly canonicalInput: Uint8Array;
}

/** One retained attempt, including a missing result when inference did not finish. */
export interface FirewallAuditEntry extends FirewallAttempt {
  readonly sequence: number;
  readonly disposition:
    | "checking"
    | "interrupted"
    | "stale"
    | "admitted"
    | "withheld";
  readonly canonicalResult?: Uint8Array;
}

/** Successful owner edits retain metadata even when no check uses the installation. */
export interface FirewallActivation {
  readonly time: number;
  readonly activeRevision: string;
  readonly addedRuleIds: readonly string[];
  readonly removedRuleIds: readonly string[];
}

/** The store records applied disposition separately from the policy judgment. */
export interface FirewallCompletion {
  readonly checkId: string;
  readonly canonicalResult: Uint8Array;
  readonly admit: boolean;
  /** A terminal guidance-only observation admits without using any stale advice. */
  readonly shadow?: true;
}

/** A stale check has no execution authority and remains in private audit. */
export type FirewallCommit = "admitted" | "withheld" | "stale";

/** Canonical bytes bound to the one local identity. */
export interface IdentityBinding {
  readonly agentId: string;
  readonly canonicalAgentCard: Uint8Array;
}

/** One locally authored immutable post intent and its completion. */
export interface PostIntent {
  readonly conversationId: string;
  readonly membershipHash: string;
  readonly authorAgentId: string;
  readonly postId: string;
  readonly canonicalIntent: Uint8Array;
  readonly completedRecordHash?: string;
}

/** Atomic binding for a post in either retained or newly founded history. */
export type PostIntentBinding = {
  readonly collective?: CollectivePostBinding;
} & (
  | Readonly<{
      kind: "existing-conversation";
      intent: PostIntent;
    }>
  | Readonly<{
      kind: "new-conversation";
      foundation: ConversationFoundation;
      intent: PostIntent;
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
  readonly postId: string;
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
  readonly messageId: string;
  readonly canonicalSignedMessage: Uint8Array;
}

/** One immutable signed envelope retained under its message identity. */
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
  readonly postIntents: readonly PostIntent[];
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
  readonly postIntents: readonly PostIntent[];
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
  readonly readCollectiveOperations: () => Effect.Effect<
    readonly StoredCollectiveOperation[],
    EndpointStoreError
  >;
  readonly readCollectivePosts: () => Effect.Effect<
    readonly StoredCollectivePost[],
    EndpointStoreError
  >;
  readonly finalizeCollectiveOperation: (
    operationId: string,
    canonicalSelection: Uint8Array,
  ) => Effect.Effect<StoreMutation, EndpointStoreError>;
  readonly publishCollectiveItem: (
    delivery: CollectiveDelivery,
  ) => Effect.Effect<void, EndpointStoreError>;

  readonly queueFirewallItem: (
    item: Omit<FirewallInboxEntry, "sequence">,
  ) => Effect.Effect<void, EndpointStoreError>;
  readonly readFirewallFrontiers: () => Effect.Effect<
    readonly FirewallInboxEntry[],
    EndpointStoreError
  >;
  readonly readPendingFirewallItems: (
    after: number,
  ) => Effect.Effect<readonly FirewallInboxEntry[], EndpointStoreError>;
  readonly readFirewallEvidence: (
    input: FirewallEvidenceRange & { readonly maximumRecords: number },
  ) => Effect.Effect<FirewallEvidence, EndpointStoreError>;
  readonly readFirewallEvidenceSlices: (input: {
    readonly ranges: readonly FirewallEvidenceRange[];
    readonly maximumRecords: number;
  }) => Effect.Effect<FirewallEvidenceSlices, EndpointStoreError>;
  readonly readFirewallRequestAdmission: (
    recordHash: string,
  ) => Effect.Effect<FirewallRequestAdmission | undefined, EndpointStoreError>;
  readonly beginFirewallAttempt: (
    attempt: FirewallAttempt,
  ) => Effect.Effect<void, EndpointStoreError>;
  /** Editable documents are opaque to storage and interpreted by delivery. */
  readonly readFirewallPolicy: () => Effect.Effect<
    Uint8Array | undefined,
    EndpointStoreError
  >;
  readonly writeFirewallPolicy: (
    rules: Uint8Array,
    activation?: FirewallActivation,
  ) => Effect.Effect<void, EndpointStoreError>;
  /** Recent edits ordered by activation time, newest first. */
  readonly readFirewallActivations: (request: {
    readonly since?: number;
  }) => Effect.Effect<
    ReadonlyArray<{
      readonly sequence: number;
      readonly activation: FirewallActivation;
    }>,
    EndpointStoreError
  >;
  /** Bounded recent completed checks, ordered by completion time. */
  readonly readFirewallDecisions: (
    since?: number,
  ) => Effect.Effect<
    ReadonlyArray<FirewallAuditEntry & { readonly time: number }>,
    EndpointStoreError
  >;
  /** Store test seam for retained attempts, including checks in progress. */
  readonly readFirewallAuditPage: (
    after: number,
  ) => Effect.Effect<readonly FirewallAuditEntry[], EndpointStoreError>;
  readonly admitFirewallItem: (
    item: Omit<InboxEntry, "sequence">,
    completion: FirewallCompletion,
  ) => Effect.Effect<FirewallCommit, EndpointStoreError>;
  readonly admitFirewallLocalItem: (
    admission: FirewallLocalAdmission,
  ) => Effect.Effect<FirewallCommit, EndpointStoreError>;
  readonly retireFirewallItem: (
    deliveryToken: DeliveryToken,
  ) => Effect.Effect<void, EndpointStoreError>;
  readonly admitFirewallOperation: (
    completion: FirewallCompletion,
    canonicalCandidate: Uint8Array,
    collective?: CollectiveOperationInput,
  ) => Effect.Effect<FirewallCommit, EndpointStoreError>;
  readonly bindCheckedPostIntent: (
    binding: PostIntentBinding,
    completion: FirewallCompletion,
  ) => Effect.Effect<FirewallCommit, EndpointStoreError>;
  readonly bindAdmittedPostIntent: (
    binding: PostIntentBinding,
    operation: Pick<FirewallAttempt, "checkId" | "canonicalCandidate">,
  ) => Effect.Effect<FirewallCommit, EndpointStoreError>;
  readonly readInboxItem: (
    deliveryToken: DeliveryToken,
  ) => Effect.Effect<
    (InboxEntry & { readonly acknowledged: boolean }) | undefined,
    EndpointStoreError
  >;
  readonly completeWebhookDelivery: (
    deliveryToken: DeliveryToken,
    canonicalState: Uint8Array,
  ) => Effect.Effect<void, EndpointStoreError>;
  readonly putInboxItem: (
    item: Omit<InboxEntry, "sequence">,
  ) => Effect.Effect<StoreMutation, EndpointStoreError>;
  readonly readInbox: (input?: {
    readonly after?: number;
    readonly through?: number;
    readonly limit?: number;
  }) => Effect.Effect<InboxPage, EndpointStoreError>;
  readonly readInboxSummary: () => Effect.Effect<
    InboxSummary,
    EndpointStoreError
  >;
  readonly acknowledgeInboxItem: (
    deliveryToken: DeliveryToken,
  ) => Effect.Effect<void, EndpointStoreError>;
  readonly replaceInboxItem: (
    deliveryToken: DeliveryToken,
    replacement: Omit<InboxEntry, "sequence">,
    pendingConversation?: string,
  ) => Effect.Effect<void, EndpointStoreError>;
  readonly readEventState: () => Effect.Effect<
    Uint8Array | undefined,
    EndpointStoreError
  >;
  readonly writeEventState: (
    canonicalState: Uint8Array,
  ) => Effect.Effect<void, EndpointStoreError>;
  readonly readIdentity: () => Effect.Effect<
    IdentityBinding | undefined,
    EndpointStoreError
  >;
  readonly bindIdentity: (
    binding: IdentityBinding,
  ) => Effect.Effect<StoreMutation, EndpointStoreError>;
  readonly bindPostIntent: (
    binding: PostIntentBinding,
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
    messageId: string,
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
export type CollectiveOrigin =
  | { readonly kind: "local" }
  | {
      readonly kind: "remote";
      readonly recordHash: string;
      readonly requiresAdmission: boolean;
    };

/** Immutable request identity and the descriptor its collective owner interprets. */
export interface CollectiveOperationInput {
  readonly operationId: string;
  readonly origin: CollectiveOrigin;
  readonly canonicalRequest: Uint8Array;
  readonly canonicalDescriptor: Uint8Array;
  readonly admittedCheckId?: string;
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

/** A collective owns one immutable post per role and destination. */
export interface CollectivePostBinding {
  readonly operationId: string;
  readonly role: "request" | "response" | "close";
  readonly destination: string;
  readonly operation?: CollectiveOperationInput;
}

/** Existing post intents own retries and certified completion across restart. */
export interface StoredCollectivePost extends CollectivePostBinding {
  readonly intent: PostIntent;
}

/** The terminal payload and collective phase become durable in one transaction. */
export interface CollectiveDelivery {
  readonly operationId: string;
  readonly deliveryToken: DeliveryToken;
  readonly canonicalItem: Uint8Array;
  readonly conversation: string;
  readonly canonicalProvenance?: Uint8Array;
  readonly firewall: boolean;
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
