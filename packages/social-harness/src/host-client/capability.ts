/** @file The structural capability one scoped endpoint connection gives its host. */

import { Data, type Effect, type Redacted, type Stream } from "effect";
import type {
  CollectiveError,
  SendInput,
  SendResult,
} from "../communication/collectives/contracts.js";
import type { InboundItem } from "../communication/collectives/inbound.js";
import type {
  DeliveryAcknowledgeError,
  ListenError,
  SendError,
} from "../communication/conversations/errors.js";
import type {
  FirewallSendError,
  LocalGuidance,
} from "../firewall/outcome/index.js";

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
 * creates a new invocation. Retrying an unknown outcome can create another message.
 *
 * Every host receives the invocation's result or typed refusal. The host
 * presents refusals through its supported tool or message callback. The daemon
 * inbox retains received messages and outcomes of operations that started.
 */
export interface HarnessEndpoint {
  readonly send: (
    input: SendInput,
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
