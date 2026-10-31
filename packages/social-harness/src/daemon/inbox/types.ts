/** @file The daemon retains assessment history and pending host delivery beside policy decisions. */

import type { Message, MessageReference } from "../../communication/message.js";
import type { DeliveryToken } from "../../communication/store/index.js";
import type { FirewallCompletion } from "../../firewall/store/types.js";
/** Immutable bytes offered to the host under one delivery identity. */
export interface ItemProjection {
  readonly deliveryToken: DeliveryToken;
  readonly canonicalItem: Uint8Array;
  readonly canonicalGuidance?: Uint8Array;
}
/** A verified message retains its attribution and the visibility the host granted it. */
export interface FirewallHistoryEntry {
  readonly message: Message;
  readonly visible: boolean;
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
/** Recent conversation evidence captured for one candidate. */
export interface FirewallEvidence {
  readonly pendingOutgoing: boolean;
  readonly history: ReadonlyArray<FirewallHistoryEntry | FirewallLocalEntry>;
  readonly overflow: boolean;
  readonly earlierHistoryOmitted: boolean;
}
/** A candidate's participants select its history; its identity excludes it from that history. */
export interface FirewallEvidenceRange {
  readonly message?: Pick<Message, "msgId" | "author" | "recipients">;
  readonly conversationId?: string;
  readonly conversation?: string;
}
/** Several windows read in one synchronous capture, one per checked text of a result. */
export interface FirewallEvidenceSlices {
  readonly slices: readonly FirewallEvidence[];
}
/** A received item waiting for its turn to be checked. */
export interface IncomingEntry {
  readonly deliveryToken: DeliveryToken;
  readonly conversation: string;
  readonly canonicalItem: Uint8Array;
  /** Original messages remain private while the projected item is presented to the host. */
  readonly canonicalSources?: Uint8Array;
  readonly message?: MessageReference;
  readonly sequence: number;
}
/**
 * One local item's admission: the queued bytes it was checked as, the
 * projection and guidance the runtime reads, the checks of its texts, the
 * answer records those checks showed or withheld, and the evidence later
 * checks read.
 */
export interface LocalAdmission {
  readonly queuedItem: Uint8Array;
  readonly item: ItemProjection;
  readonly completions: readonly FirewallCompletion[];
  readonly visibility: ReadonlyArray<{
    readonly message: MessageReference;
    readonly admitted: boolean;
  }>;
  readonly evidence: FirewallLocalEvidence;
}
