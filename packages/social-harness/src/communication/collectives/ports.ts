/**
 * @file The ports the collective layer runs on: what it needs from the
 * daemon, what an installed firewall adds, and the operations it offers.
 */

import { type Effect, type Option, Schema, type Scope } from "effect";
import type {
  CheckedGuidance,
  FirewallSendError,
} from "../../firewall/outcome/index.js";
import type { SendError } from "../conversations/errors.js";
import type {
  BindHold,
  EngineSendInput,
  EngineSentPost,
} from "../conversations/index.js";
import type { InboundMessage } from "../conversations/message.js";
import type {
  CollectiveEmitError,
  CollectiveError,
  CollectiveId,
  CollectiveSendOutcome,
  FailureDelivery,
  SendInput,
} from "./forms.js";
import type { InboundItem } from "./inbound.js";
import { exactStruct } from "../../encoding/exact.js";
import { RecordHash } from "../records/index.js";
import { AgentAddress, type MessageAddressInput } from "../records/values.js";

// safer-arch-ignore file-implicit-boundary-module: The operation layer and its received-request state run on these ports; communication/collectives/index.ts is the one boundary that exposes them.

/** The engine's post vocabulary the ports exchange. */
export type { BindHold, EngineSendInput } from "../conversations/index.js";

/** How binding an authored post fails: before it binds, or by its caller's hold. */
export type AuthoredPostError<E> = SendError | FirewallSendError | E;

/** Every way a collective send fails: before posting, by a collective refusal, or by the firewall. */
export type CollectiveSendError = AuthoredPostError<CollectiveError>;

/* eslint-disable @typescript-eslint/naming-convention, @typescript-eslint/no-redeclare -- The provenance Schema shares its domain name with the value it decodes. */

/**
 * Private facts about an emitted result that the endpoint's firewall checks
 * it with: the certified record of each counted answer but the endpoint's
 * own, in member order, and, at a member, the certified request post it was
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

/** A gather the firewall checks once, before any of its request posts. */
export interface GatherCandidate {
  readonly to: MessageAddressInput;
  readonly content: InboundMessage["content"];
}

/** Certify one post and complete once it is stored locally. */
export type PostSender = (
  input: EngineSendInput,
) => Effect.Effect<EngineSentPost, SendError>;

/**
 * A bound post the agent authored: the advice its admitting check gave,
 * known once the check admits it, and the effect that completes once the
 * post is certified.
 */
export interface AdmittedPost {
  readonly certified: Effect.Effect<EngineSentPost, SendError>;
  readonly guidance?: CheckedGuidance;
}

/** The only sender an admitted gather's request posts bind through, with the advice its check gave. */
export interface AdmittedGather {
  readonly sendRequest: PostSender;
  readonly guidance?: CheckedGuidance;
}

/**
 * What an installed firewall adds to the layer: every post the agent
 * authors is checked before it binds, and a gather once before its request
 * posts. Without it the layer takes each hold and sends through `sendPost`.
 */
export interface CollectiveAdmission {
  /**
   * Check and bind one post the agent authored: a multicast, an all_gather
   * request or an answer. `hold` is taken after the check, just before the
   * bind, and given up when nothing binds.
   */
  readonly bindPost: <E>(
    input: EngineSendInput,
    hold: BindHold<E>,
  ) => Effect.Effect<AdmittedPost, AuthoredPostError<E>>;
  /**
   * Check a gather, then return the only sender its request posts bind
   * through, each against the admitted check of exactly this content, with
   * the advice that check gave.
   */
  readonly admitGather: (
    gather: GatherCandidate,
  ) => Effect.Effect<AdmittedGather, SendError | FirewallSendError>;
}

/** What the collective layer needs from the daemon around it. */
export interface CollectivePorts {
  /** The local agent: a group gather or all_gather asks every member but this one. */
  readonly self: AgentAddress;
  /**
   * Resolve one member's Registry card without sending, so a collecting
   * operation refuses an address error before any post.
   */
  readonly lookupMember: (
    member: AgentAddress,
  ) => Effect.Effect<void, SendError>;
  /**
   * Without a firewall every post goes through it; with one, only a close
   * does, and the agent's own posts go through `admission`.
   */
  readonly sendPost: PostSender;
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
  ) => Effect.Effect<void, CollectiveEmitError>;
  /** Owns deadline timers and request sends that outlive their send call. */
  readonly scope: Scope.Scope;
  /**
   * The installed firewall's checks. With it a received request waits
   * `unadmitted`, unanswerable, until `settleRequest`.
   */
  readonly admission?: CollectiveAdmission;
}

/** One certified remote post with the hash of its certified record. */
export interface CertifiedPost {
  readonly message: InboundMessage;
  readonly recordHash: RecordHash;
}

/** The daemon's collective layer for one active identity. */
export interface CollectiveOperations {
  /**
   * Return a gather's id after the bounded request wait; pending posts keep
   * certifying. An all_gather waits for its group post to certify unless
   * its deadline already completed the operation. Multicasts and responses
   * wait for their post's certification. A response must match an open
   * request in its conversation and satisfy that request's schema.
   */
  readonly send: (
    input: SendInput,
    failureDelivery: FailureDelivery,
  ) => Effect.Effect<CollectiveSendOutcome, CollectiveSendError>;
  /**
   * Classify one certified remote post. Answers are recorded and consumed,
   * every other protocol post is consumed, and each remaining post becomes
   * one item. Classifying a post again yields the same result, so the daemon
   * may run it on every pass over pending deliveries. It fails with
   * `CollectiveEmitError` when a result or failure the post completes cannot
   * be kept, which ends the pass classifying it.
   */
  readonly classify: (
    post: CertifiedPost,
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
