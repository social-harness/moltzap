/** @file The structural capability one scoped endpoint connection gives its host. */

import { Data, type Effect, type Redacted, type Stream } from "effect";
import type {
  CollectiveError,
  FailureDelivery,
  SendInput,
  SendResult,
} from "../../communication/collectives/forms.js";
import type { InboundItem } from "../../communication/collectives/inbound.js";
import type {
  DeliveryAcknowledgeError,
  ListenError,
  SendError,
} from "../../communication/conversations/errors.js";
import type {
  FirewallSendError,
  LocalGuidance,
} from "../../firewall/outcome/index.js";

type ConnectFailure =
  | "transport-failed"
  | "decode-failed"
  | "incompatible-daemon";

/** Acquiring the endpoint connection failed. */
export class ConnectError extends Data.TaggedError("ConnectError")<{
  readonly reason: ConnectFailure;
}> {
  override get message(): string {
    return `connect failed: ${this.reason}`;
  }
}

/** One inbound item plus its transport-only acknowledgment. */
export interface InboundDelivery {
  /** Opaque, stable reference for native wakeups and authenticated `read_event`. */
  readonly eventId: string;
  readonly item: InboundItem;
  readonly guidance?: LocalGuidance;
  /** Valid only while this subscription owns receiving, including after cleanup fails. */
  readonly acknowledge: Effect.Effect<void, DeliveryAcknowledgeError>;
}

/** Authenticated polling uses the runtime credential without exposing MCP details. */
export interface HarnessEndpointOptions {
  readonly credential: Redacted.Redacted;
  /** Runs after consumer acquisition and renewal start, even when the inbox is empty. */
  readonly onReady?: Effect.Effect<void>;
}

/**
 * Structural runtime capability owned by one scoped endpoint connection.
 * Every send is one operation or one collective response; the stream yields
 * inbound items.
 *
 * A host whose tool returns before the send completes passes
 * `failureDelivery: "inbound"`: a refused gather, all_gather or response
 * then completes and its error arrives as an `operationFailed` item on the
 * stream. A multicast has no operation id, so its failure is always returned.
 * A firewall refusal always returns on the send call before creating an intent,
 * including when inbound failure delivery was requested.
 */
export interface HarnessEndpoint {
  readonly send: (
    input: SendInput,
    options?: Readonly<{
      failureDelivery?: FailureDelivery;
    }>,
  ) => Effect.Effect<
    SendResult,
    SendError | CollectiveError | FirewallSendError
  >;
  readonly messages: Stream.Stream<InboundDelivery, ListenError>;
}
