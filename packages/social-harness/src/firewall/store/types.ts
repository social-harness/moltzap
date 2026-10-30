/** @file Policy decisions and the persistence operations required by local assessment. */

import type { Effect } from "effect";
import type {
  DeliveryToken,
  EndpointStoreError,
} from "../../communication/store/index.js";

/** Immutable bytes offered to the host under one delivery identity. */
export interface ItemProjection {
  readonly deliveryToken: DeliveryToken;
  readonly canonicalItem: Uint8Array;
  readonly canonicalGuidance?: Uint8Array;
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

/** One conversation's evidence window before one candidate. */
export interface FirewallEvidenceSlice {
  readonly pendingOutgoing: boolean;
  readonly history: ReadonlyArray<FirewallHistoryEntry | FirewallLocalEntry>;
  readonly overflow: boolean;
  readonly earlierHistoryOmitted: boolean;
  readonly candidate?: FirewallHistoryEntry;
}

/** The captured evidence used by one assessment. */
export type FirewallEvidence = FirewallEvidenceSlice;

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

/** Several windows read in one synchronous capture, one per checked text of a result. */
export interface FirewallEvidenceSlices {
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
  readonly item: ItemProjection;
  readonly completions: readonly FirewallCompletion[];
  readonly deterministic?: FirewallAttempt & {
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
  readonly canonicalCandidate: Uint8Array;
  readonly canonicalInput: Uint8Array;
}

/** One retained attempt, including a missing result when inference did not finish. */
export interface FirewallAuditEntry extends FirewallAttempt {
  readonly sequence: number;
  readonly disposition: "checking" | "interrupted" | "admitted" | "withheld";
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
}

/** The disposition retained for a completed local assessment. */
export type FirewallCommit = "admitted" | "withheld";

/** Assessment owns these requirements; daemon composition supplies cross-owner settlement. */
export interface FirewallStore {
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
  readonly admitFirewallItem: (
    item: ItemProjection,
    completion: FirewallCompletion,
  ) => Effect.Effect<FirewallCommit, EndpointStoreError>;
  readonly admitFirewallLocalItem: (
    admission: FirewallLocalAdmission,
  ) => Effect.Effect<FirewallCommit, EndpointStoreError>;
  readonly retireFirewallItem: (
    deliveryToken: DeliveryToken,
  ) => Effect.Effect<void, EndpointStoreError>;
  /** Completes a retained assessment of the same captured candidate. */
  readonly completeFirewallAttempt: (
    completion: FirewallCompletion,
    direction: FirewallAttempt["direction"],
    canonicalCandidate: Uint8Array,
  ) => Effect.Effect<FirewallCommit, EndpointStoreError>;
}
