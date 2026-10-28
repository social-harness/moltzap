/** @file The closed errors of sending, listening and acknowledging delivery. */

import { Data } from "effect";

/** Every reason one addressed send can fail, in a fixed order. */
export const sendFailureReasons = [
  "invalid-address",
  "unknown-agent",
  "membership-invalid",
  "content-invalid",
  "not-registered",
  "version-mismatch",
  "certification-unavailable",
  "persistence-failed",
  "network-unavailable",
  "delivery-pending",
  "outcome-unknown",
] as const;

/** Why one addressed send failed. */
export type SendFailure = (typeof sendFailureReasons)[number];

/**
 * What each failure means, in words a model reads as a tool error. The text
 * states only the cause. A failed send was not sent, except `outcome-unknown`,
 * where the message may have gone out, and `delivery-pending`, whose post's
 * intent is durably bound and still proposed and delivered once the Router
 * answers or the daemon restarts, so a resend posts the message twice.
 */
export const sendFailureText: Readonly<Record<SendFailure, string>> = {
  "invalid-address": "the address is not a valid agent: or group: address",
  "unknown-agent": "an agent the address names is not a known agent",
  "membership-invalid": "the address does not name a valid set of agents",
  "content-invalid": "the message content is invalid",
  "not-registered": "this agent is not registered with Social Harness",
  "version-mismatch": "Social Harness is unavailable (version mismatch)",
  "certification-unavailable":
    "Social Harness is unavailable (certification unavailable)",
  "persistence-failed":
    "Social Harness is unavailable (the message could not be stored)",
  "network-unavailable": "Social Harness is unavailable (network unavailable)",
  "delivery-pending":
    "the message is pending and Social Harness will still deliver it",
  "outcome-unknown":
    "the send did not complete; the message may or may not have been sent",
};

/** One field that failed validation: where it is and what it should be. */
export interface ValidationIssue {
  readonly path: ReadonlyArray<string | number>;
  readonly message: string;
}

/**
 * Validation issues as one line an agent can act on, each field's path
 * before what it expected, such as `input.to: Expected an agent name`.
 * @param issues The issues, in the order the schema reported them.
 * @returns The issues joined with semicolons.
 */
export function issuesText(issues: readonly ValidationIssue[]): string {
  return issues
    .map(({ path, message }) =>
      path.length === 0 ? message : `${path.join(".")}: ${message}`,
    )
    .join("; ");
}

/**
 * An addressed send failed before local certification completed. `detail`
 * names the specific cause when the failing step knows it, such as which
 * agent is unknown; the message is what a host hands its model, and names
 * each invalid field. Validation issues expose only field paths and schema
 * expectations.
 */
export class SendError extends Data.TaggedError("SendError")<{
  readonly reason: SendFailure;
  readonly detail?: string;
  readonly issues?: readonly ValidationIssue[];
}> {
  override get message(): string {
    const cause = this.detail ?? sendFailureText[this.reason];
    return this.issues === undefined || this.issues.length === 0
      ? `send failed: ${cause}`
      : `send failed: ${cause}: ${issuesText(this.issues)}`;
  }
}

type ListenFailure =
  | "already-listening"
  | "consumer-revoked"
  | "incompatible-daemon"
  | "transport-failed"
  | "decode-failed";

/** The endpoint's sole inbound subscription failed. */
export class ListenError extends Data.TaggedError("ListenError")<{
  readonly reason: ListenFailure;
}> {
  override get message(): string {
    return this.reason === "consumer-revoked"
      ? "listen failed: consumer-revoked. Reacquire the subscription. Docs: https://github.com/social-harness/moltzap/blob/main/docs/spec/harness/ingress.md#polling-consumer"
      : `listen failed: ${this.reason}`;
  }
}

/** Every reason one delivery acknowledgment can fail, in a fixed order. */
export const deliveryAcknowledgeFailureReasons = [
  "consumer-revoked",
  "unknown-delivery",
  "delivery-conflict",
  "persistence-failed",
  "transport-failed",
] as const;

/** Why one delivery acknowledgment failed. */
export type DeliveryAcknowledgeFailure =
  (typeof deliveryAcknowledgeFailureReasons)[number];

/** Transport acknowledgment could not complete for one delivery. */
export class DeliveryAcknowledgeError extends Data.TaggedError(
  "DeliveryAcknowledgeError",
)<{
  readonly reason: DeliveryAcknowledgeFailure;
}> {
  override get message(): string {
    return this.reason === "consumer-revoked"
      ? "delivery acknowledgment failed: consumer-revoked. Recover unread work through a new subscription. Docs: https://github.com/social-harness/moltzap/blob/main/docs/spec/harness/ingress.md#polling-consumer"
      : `delivery acknowledgment failed: ${this.reason}`;
  }
}
