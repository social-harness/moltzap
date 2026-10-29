/**
 * @file The ports the collective layer runs on: what it needs from the
 * daemon, what an installed firewall adds, and the operations it offers.
 */

import { type Effect, type Option, Schema, type Scope } from "effect";
import type {
  CheckedGuidance,
  FirewallSendError,
} from "../../firewall/outcome/index.js";
import type { AgentView } from "../../identity/cards.js";
import type { SendError } from "../conversations/errors.js";
import type {
  BindHold,
  EndpointEngine,
  EngineSendInput,
  EngineSentMessage,
} from "../conversations/index.js";
import type { InboundMessage } from "../conversations/message.js";
import type {
  CollectiveOperationInput,
  DeliveryToken,
  EndpointStore,
  EndpointStoreError,
} from "../store/index.js";
import type {
  CollectiveEmitError,
  CollectiveError,
  CollectiveId,
  CollectiveSendOutcome,
  SendInput,
} from "./contracts.js";
import type { InboundItem } from "./inbound.js";
import { exactStruct } from "../../encoding/exact.js";
import { type MsgId, RecordHash } from "../records/index.js";
import { AgentAddress, type MessageAddressInput } from "../records/values.js";

// safer-arch-ignore file-implicit-boundary-module: The operation layer and its received-request state run on these ports; communication/collectives/index.ts is the one boundary that exposes them.

/** The engine's message vocabulary the ports exchange. */
export type { BindHold, EngineSendInput } from "../conversations/index.js";

/** How binding an authored message fails: before it binds, or by its caller's hold. */
export type AuthoredMessageError<E> = SendError | FirewallSendError | E;

/** Every way a collective send fails: before sending, by a collective refusal, or by the firewall. */
export type CollectiveSendError = AuthoredMessageError<CollectiveError>;

/* eslint-disable @typescript-eslint/naming-convention, @typescript-eslint/no-redeclare -- The provenance Schema shares its domain name with the value it decodes. */

/**
 * Private facts about an emitted result that the endpoint's firewall checks
 * it with: the certified record of each counted answer but the endpoint's
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

/** A gather the firewall checks once, before any of its request messages. */
export interface GatherCandidate {
  readonly to: MessageAddressInput;
  readonly content: InboundMessage["content"];
  readonly operation?: CollectiveOperationInput;
}

/** Certify one message and complete once it is stored locally. */
export type MessageSender = (
  input: EngineSendInput,
) => Effect.Effect<EngineSentMessage, SendError>;

/**
 * A bound message the agent authored: the advice its admitting check gave,
 * known once the check admits it, and the effect that completes once the
 * message is certified.
 */
export interface AdmittedMessage {
  readonly certified: Effect.Effect<EngineSentMessage, SendError>;
  readonly guidance?: CheckedGuidance;
}

/** The only sender an admitted gather's request messages bind through, with the advice its check gave. */
export interface AdmittedGather {
  readonly sendRequest: MessageSender;
  readonly guidance?: CheckedGuidance;
}

/**
 * What an installed firewall adds to the layer: every message the agent
 * authors is checked before it binds, and a gather once before its request
 * messages. Without it the engine takes each hold through `bindMessage`.
 */
export interface CollectiveAdmission {
  /**
   * Check and bind one message the agent authored: a multicast, an all_gather
   * request or an answer. `hold` is taken after the check, just before the
   * bind, and given up when nothing binds.
   */
  readonly bindMessage: <E>(
    input: EngineSendInput,
    hold: BindHold<E>,
  ) => Effect.Effect<AdmittedMessage, AuthoredMessageError<E>>;
  /**
   * Check a gather, then return the only sender its request messages bind
   * through, each against the admitted check of exactly this content, with
   * the advice that check gave.
   */
  readonly admitGather: (
    gather: GatherCandidate,
  ) => Effect.Effect<
    AdmittedGather,
    SendError | FirewallSendError | EndpointStoreError
  >;
}

/** What the collective layer needs from the daemon around it. */
export interface CollectivePorts {
  /** Plain authored messages take their hold at the same durable bind boundary as checked messages. */
  readonly bindMessage: EndpointEngine["bind"];
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
    | "readFirewallRequestAdmission"
    | "readRetainedDeliveries"
  >;
  readonly observeMessage: (
    msgId: MsgId,
  ) => Effect.Effect<EngineSentMessage, SendError>;
  readonly sendAdmitted: (
    input: EngineSendInput,
    checkId: string,
  ) => Effect.Effect<EngineSentMessage, SendError>;
  readonly reportStorageFault: (
    error: EndpointStoreError,
  ) => Effect.Effect<void>;

  /** The local agent: a group gather or all_gather asks every member but this one. */
  readonly self: AgentAddress;
  /**
   * Resolve and retain one verified identity before accepting a collecting
   * operation. Results use this view even when later delivery fails.
   */
  readonly lookupMember: (
    member: AgentAddress,
  ) => Effect.Effect<AgentView, SendError>;
  /**
   * Protocol closes and unchecked gather fanout certify through this port.
   * Authored messages use `bindMessage` or the installed admission boundary.
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
  /**
   * The installed firewall's checks. With it a received request waits
   * `unadmitted`, unanswerable, until `settleRequest`.
   */
  readonly admission?: CollectiveAdmission;
}

/** One certified remote message with the hash of its certified record. */
export interface CertifiedMessage {
  readonly message: InboundMessage;
  readonly recordHash: RecordHash;
}

/** The daemon's collective layer for one active identity. */
export interface CollectiveOperations {
  /**
   * Return a gather's id after the bounded request wait; pending messages keep
   * certifying. An all_gather waits for its group message to certify unless
   * its deadline already completed the operation. Multicasts and responses
   * wait for their message's certification. A response must match an open
   * request in its conversation and satisfy that request's schema.
   */
  readonly send: (
    input: SendInput,
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
  /**
   * Settle the admission of a request the firewall checked: answerable when
   * the runtime was shown it, otherwise never answerable, though an
   * all_gather member still applies its close. Only an `unadmitted` request
   * changes.
   */
  readonly settleRequest: (
    id: CollectiveId,
    presented: boolean,
  ) => Effect.Effect<void>;
}

/**
 * Bind one message the agent authored, holding `hold` across the bind: through
 * the firewall's check when one is installed, otherwise through the engine
 * bind port. Both return only after the intent is durable.
 */
export function bindAuthoredMessage<E>(
  ports: CollectivePorts,
  input: EngineSendInput,
  hold: BindHold<E>,
): Effect.Effect<AdmittedMessage, AuthoredMessageError<E>> {
  const { admission } = ports;
  return admission === undefined
    ? ports.bindMessage(input, hold)
    : admission.bindMessage(input, hold);
}
