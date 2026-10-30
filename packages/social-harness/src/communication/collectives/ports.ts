/**
 * @file The ports the collective layer runs on: what it needs from the
 * daemon and the protocol operations it offers.
 */

import { type Effect, type Option, Schema, type Scope } from "effect";
import type { AgentView } from "../../identity/cards.js";
import type { SendError } from "../conversations/errors.js";
import type {
  EndpointEngine,
  EngineSendInput,
  EngineSentMessage,
} from "../conversations/index.js";
import type { InboundMessage } from "../conversations/message.js";
import type {
  DeliveryToken,
  EndpointStore,
  EndpointStoreError,
} from "../store/index.js";
import type {
  CollectiveEmitError,
  CollectiveError,
  CollectiveSendOutcome,
  SendInput,
} from "./contracts.js";
import type { InboundItem } from "./inbound.js";
import type { PreparedCollective } from "./prepared.js";
import { exactStruct } from "../../encoding/exact.js";
import { type MsgId, RecordHash } from "../records/index.js";
import { AgentAddress } from "../records/values.js";

// safer-arch-ignore file-implicit-boundary-module: The operation layer and its received-request state run on these ports; communication/collectives/index.ts is the one boundary that exposes them.

/** The engine's message vocabulary the ports exchange. */
export type { BindHold, EngineSendInput } from "../conversations/index.js";

/** How binding an authored message fails: before it binds, or by its caller's hold. */
export type AuthoredMessageError<E> = SendError | E;

/** A collective send may fail during preparation, protocol selection or certification. */
export type CollectiveSendError = AuthoredMessageError<CollectiveError>;

/* eslint-disable @typescript-eslint/naming-convention, @typescript-eslint/no-redeclare -- The provenance Schema shares its domain name with the value it decodes. */

/**
 * Certified provenance of an emitted result: the certified record of each counted answer but the endpoint's
 * own, in member order, and, at a member, the certified request message it was
 * asked by. Nothing outside Client reads them.
 */
export const ResultProvenance = exactStruct({
  answers: Schema.Array(
    exactStruct({ member: AgentAddress, recordHash: RecordHash }),
  ),
  request: Schema.optionalWith(RecordHash, { exact: true }),
});
/** One result's provenance. */
export type ResultProvenance = typeof ResultProvenance.Type;

/* eslint-enable @typescript-eslint/naming-convention, @typescript-eslint/no-redeclare -- Restore naming after the Schema/type pair. */

/** Ordinary protocol traffic completes after local certification. */
export type MessageSender = (
  input: EngineSendInput,
) => Effect.Effect<EngineSentMessage, SendError>;
/** A bound intent preserves custody while its caller waits for certification. */
export interface AcceptedMessage {
  readonly certified: Effect.Effect<EngineSentMessage, SendError>;
}

/** What the collective layer needs from the daemon around it. */
export interface CollectivePorts {
  /** Preparation captures canonical bytes before the caller decides whether to accept them. */
  readonly prepareMessage: EndpointEngine["prepare"];
  readonly acceptMessage: EndpointEngine["accept"];
  readonly store: Pick<
    EndpointStore,
    | "putCollectiveOperation"
    | "readCollectiveOperation"
    | "readCollectiveOperations"
    | "readCollectiveMessages"
    | "recordCollectiveAnswer"
    | "readCollectiveAnswers"
    | "recordCollectiveRefusal"
    | "readCollectiveRefusals"
    | "finalizeCollectiveOperation"
    | "retireCollectiveOperation"
    | "readRetainedDeliveries"
  >;
  readonly observeMessage: (
    msgId: MsgId,
  ) => Effect.Effect<EngineSentMessage, SendError>;
  readonly reportStorageFault: (
    error: EndpointStoreError,
  ) => Effect.Effect<void>;

  /** The local agent: a group gather or all_gather asks every member but this one. */
  readonly self: AgentView;
  /**
   * Protocol closes certify through this port. Request fanout accepts each
   * retained preparation through `acceptMessage`.
   */
  readonly sendMessage: MessageSender;
  /**
   * Queue an item the layer emits itself: a result, with its provenance, or
   * a failure. It fails when the item cannot be kept, and only after it has
   * reported the storage failure itself, as the daemon's port does by
   * stopping the daemon. A caller may therefore discard the failure:
   * classification ends its pass on it, and a send keeps its own outcome.
   */
  readonly emit: (
    item: InboundItem,
    provenance?: ResultProvenance,
    terminal?: {
      readonly operationId: string;
      readonly deliveryToken: DeliveryToken;
    },
  ) => Effect.Effect<void, CollectiveEmitError>;
  /** Owns deadline timers and request sends that outlive their send call. */
  readonly scope: Scope.Scope;
}

/** One certified remote message with the hash of its certified record. */
export interface CertifiedMessage {
  readonly message: InboundMessage;
  readonly recordHash: RecordHash;
}

/** The daemon's collective layer for one active identity. */
export interface CollectiveOperations {
  /** Validate an operation and capture its exact destinations, content and message identities. */
  readonly prepare: (
    input: SendInput,
  ) => Effect.Effect<PreparedCollective, CollectiveSendError>;
  /** Take protocol custody of the captured operation while its request and deadline remain live. */
  readonly accept: (
    prepared: PreparedCollective,
  ) => Effect.Effect<CollectiveSendOutcome, CollectiveSendError>;
  /**
   * Classify one certified remote message. Answers are recorded and consumed,
   * every other protocol message is consumed, and each remaining message becomes
   * one item. Classifying a message again yields the same result, so the daemon
   * may run it on every pass over pending deliveries. It fails with
   * `CollectiveEmitError` when a result or failure the message completes cannot
   * be kept, which ends the pass classifying it.
   */
  readonly classify: (
    message: CertifiedMessage,
  ) => Effect.Effect<Option.Option<InboundItem>, CollectiveEmitError>;
}
