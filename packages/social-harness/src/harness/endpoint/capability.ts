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

/** @inline */
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

/**
 * A classified item retained until its host acknowledges it. A delivery may
 * replay after an ambiguous handoff, so host acceptance must tolerate replay.
 */
export interface InboundDelivery {
  /**
   * Opaque reference for authenticated `read_event`, stable across redelivery
   * and readable after acknowledgement. It grants no delivery or send authority.
   */
  readonly eventId: string;
  readonly item: InboundItem;
  readonly guidance?: LocalGuidance;
  /**
   * Run after the host accepts the item. A failed host callback leaves it pending.
   * Closing this subscription invalidates the receipt even if remote cleanup fails.
   */
  readonly acknowledge: Effect.Effect<void, DeliveryAcknowledgeError>;
}

/** A runtime credential selects authenticated polling instead of trusted-local push. */
export interface HarnessEndpointOptions {
  readonly credential: Redacted.Redacted;
  /**
   * Runs after consumer acquisition and renewal start, including for an empty
   * inbox. Recovery and processing may still be pending. Failure or interruption
   * closes the consumer, and renewal continues independently of host callbacks.
   */
  readonly onReady?: Effect.Effect<void>;
}

/**
 * Connects one configured agent to a host for the connection's scope. Each send
 * creates a new invocation. Retrying an unknown outcome can create another post.
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
  /**
   * One active subscription per endpoint. Closing it leaves unacknowledged
   * items available to the next subscription and invalidates its receipts.
   */
  readonly messages: Stream.Stream<InboundDelivery, ListenError>;
}
