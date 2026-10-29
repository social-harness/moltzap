/**
 * @file Staged successors in recovery: a record some members staged and voted
 * durable before a Router discontinuity, extending the head a recovering
 * conversation holds. Holders send it in their catch-up answers. Recovery
 * certifies it at `q(n)` durability votes, and a member that did not stage it
 * converts to it, staging the record and voting for it once enough members
 * vouch for it.
 */

import { Effect } from "effect";
import type { AgentId } from "../../../identity/agents.js";
import type { SignedMessage } from "../../../identity/envelope/signed-message.js";
import type {
  RouterIngressDisposition,
  RouterWorkerIngress,
  RouterWorkerPersistenceError,
} from "../../router/index.js";
import type {
  EngineActionFold,
  EngineConversation,
  EngineRuntime,
} from "../engine-context.js";
import {
  type ActionCertifiedRecord,
  type ActionCore,
  type AnchorHash,
  type ConversationId as ConversationIdValue,
  type DecodedOuterBody,
  type EvidenceStatement,
  quorumThreshold,
  type RecordHash as RecordHashValue,
  type VerifiedMembership,
  verifyActionCertifiedRecord,
  verifyDeliveredEvidence,
  verifyOuterMessage,
} from "../../records/index.js";
import { anchorHashAtHead } from "../history/index.js";

/** A conversation's certified head and the anchor its next record binds. */
interface HeadPosition {
  readonly head: RecordHashValue;
  readonly anchorHash: AnchorHash;
}

/** A held delivery and the record it carries or votes for. */
interface HeldDelivery {
  readonly recordHash: RecordHashValue;
  readonly ingress: RouterWorkerIngress<DecodedOuterBody>;
}

/**
 * What a re-anchoring member holds toward converting to a successor of its
 * head: the one verified action-certified record extending that head under
 * the current anchor, and each other member's latest durability vote for
 * it. A member that voted for a successor of the head under an anchor the
 * conversation has since left votes again under the new one, so a later
 * vote replaces an earlier one, and one vote per member keeps a faulty
 * member from growing the hold. A hold belongs to one position and is
 * dropped once the head or the anchor moves, by whatever path.
 */
interface PendingSuccessor {
  readonly position: HeadPosition;
  record?: HeldDelivery;
  readonly votes: Map<
    AgentId,
    HeldDelivery & { readonly statement: EvidenceStatement }
  >;
  /** Set once the endpoint has tried to stage the held record. */
  settled: boolean;
}

/** What staged-successor handling needs from the recovery run it belongs to. */
export interface SuccessorRun {
  readonly runtime: EngineRuntime;
  /** The successor each re-anchoring conversation holds toward converting. */
  readonly pending: Map<ConversationIdValue, PendingSuccessor>;
  /** The run's verified membership of a conversation. */
  readonly membership: (
    conversationId: ConversationIdValue,
  ) => VerifiedMembership | undefined;
  /** Whether the run re-anchors the conversation after a Router restart. */
  readonly reanchoring: (conversationId: ConversationIdValue) => boolean;
}

const acceptedDisposition: RouterIngressDisposition = "accepted";
const ignoredDisposition: RouterIngressDisposition = "ignored";

/**
 * Take a member's action-certified record for a recovering conversation when
 * it extends the conversation's head. Outside a re-anchor the record alone
 * is enough, so the protocol phases verify it, stage it and vote for it at
 * once. During a re-anchor this endpoint verifies and holds it, and converts
 * to it only once more than `n − q(n)` members have voted it durable.
 * @param run Recovery run that holds the conversation.
 * @param ingress Verified Router delivery carrying the record.
 * @param record The member's action-certified record.
 * @returns Whether the record was taken or ignored.
 */
export function acceptSuccessorRecord(
  run: SuccessorRun,
  ingress: RouterWorkerIngress<DecodedOuterBody>,
  record: ActionCertifiedRecord,
): Effect.Effect<RouterIngressDisposition, RouterWorkerPersistenceError> {
  const { conversationId } = record.recordCore.action;
  const extended = headExtendedBy(run, record.recordCore.action);
  if (
    extended === undefined ||
    run.runtime.recordFolds.has(record.recordHash)
  ) {
    return Effect.succeed(ignoredDisposition);
  }
  if (!run.reanchoring(conversationId)) {
    return run.runtime.phases.acceptIngress(run.runtime, ingress);
  }
  const { position, membership } = extended;
  const pending = pendingFor(run.pending, conversationId, position);
  if (pending.settled || pending.record?.recordHash === record.recordHash) {
    return Effect.succeed(ignoredDisposition);
  }
  return holdTowardConversion(
    run,
    membership,
    verifyHeldRecord(membership, ingress, record),
    () => {
      pending.record = { recordHash: record.recordHash, ingress };
    },
  ).pipe(Effect.withSpan("acceptSuccessorRecord"));
}

/**
 * Take a member's durability vote for a recovering conversation's staged
 * successor. A successor this endpoint has staged takes the vote in the
 * protocol phases, which certify it at `q(n)` votes. During a re-anchor, a
 * vote for a successor it has not staged is held toward converting to it.
 * @param run Recovery run that holds the conversation.
 * @param ingress Verified Router delivery carrying the vote.
 * @param vote The vote's evidence message and its decoded statement.
 * @param vote.message The vote's evidence message.
 * @param vote.statement The vote's decoded statement.
 * @returns Whether the vote was taken or ignored.
 */
export function acceptSuccessorVote(
  run: SuccessorRun,
  ingress: RouterWorkerIngress<DecodedOuterBody>,
  vote: Readonly<{
    message: SignedMessage;
    statement: Extract<EvidenceStatement, { readonly kind: "durability_vote" }>;
  }>,
): Effect.Effect<RouterIngressDisposition, RouterWorkerPersistenceError> {
  const { conversationId, recordHash, signerAgentId } = vote.statement;
  const conversation = run.runtime.conversations.get(conversationId);
  const membership = run.membership(conversationId);
  if (conversation === undefined || membership === undefined) {
    return Effect.succeed(ignoredDisposition);
  }
  const fold = run.runtime.recordFolds.get(recordHash);
  if (fold !== undefined) {
    return acceptStagedSuccessorVote(
      run,
      { conversation, fold },
      ingress,
      vote.statement,
    );
  }
  const position = headPosition(conversation);
  if (!run.reanchoring(conversationId) || position === undefined) {
    return Effect.succeed(ignoredDisposition);
  }
  const pending = pendingFor(run.pending, conversationId, position);
  if (!takesVote(pending, signerAgentId, recordHash)) {
    return Effect.succeed(ignoredDisposition);
  }
  return holdTowardConversion(
    run,
    membership,
    verifyHeldVote(run, membership, ingress, vote),
    () => {
      pending.votes.set(signerAgentId, {
        recordHash,
        ingress,
        statement: vote.statement,
      });
    },
  ).pipe(Effect.withSpan("acceptSuccessorVote"));
}

/**
 * Hand a member's vote for a successor this endpoint has staged to the
 * protocol phases, which certify it at `q(n)` votes.
 * @param run Recovery run that holds the conversation.
 * @param target The conversation the vote names and the voted record's fold.
 * @param target.conversation The conversation whose head the record extends.
 * @param target.fold The fold of the record the member voted for.
 * @param ingress Verified Router delivery carrying the vote.
 * @param statement The member's durability vote.
 * @returns Whether the vote was taken or ignored.
 */
function acceptStagedSuccessorVote(
  run: SuccessorRun,
  target: Readonly<{
    conversation: EngineConversation;
    fold: EngineActionFold;
  }>,
  ingress: RouterWorkerIngress<DecodedOuterBody>,
  statement: Extract<EvidenceStatement, { readonly kind: "durability_vote" }>,
): Effect.Effect<RouterIngressDisposition, RouterWorkerPersistenceError> {
  const { conversation, fold } = target;
  const position = headPosition(conversation);
  const staged =
    !fold.certified &&
    position !== undefined &&
    extendsHead(position, fold.action);
  const { signerAgentId } = statement;
  return staged && !fold.durabilityEvidence.has(signerAgentId)
    ? run.runtime.phases.acceptIngress(run.runtime, ingress, statement)
    : Effect.succeed(ignoredDisposition);
}

/**
 * Hold a member's verified record or vote toward converting, then convert if
 * the hold is now complete.
 * @param run Recovery run that holds the conversation.
 * @param membership Verified membership of the successor's conversation.
 * @param verified Whether the delivery verified for this conversation.
 * @param hold Records the delivery in the conversation's pending successor.
 * @returns Accepted once held, ignored when the delivery did not verify.
 */
function holdTowardConversion(
  run: SuccessorRun,
  membership: VerifiedMembership,
  verified: Effect.Effect<boolean>,
  hold: () => void,
): Effect.Effect<RouterIngressDisposition, RouterWorkerPersistenceError> {
  return verified.pipe(
    Effect.flatMap((held) => {
      if (!held) {
        return Effect.succeed(ignoredDisposition);
      }
      hold();
      return maybeConvert(run, membership).pipe(Effect.as(acceptedDisposition));
    }),
  );
}

function verifyHeldRecord(
  membership: VerifiedMembership,
  ingress: RouterWorkerIngress<DecodedOuterBody>,
  record: ActionCertifiedRecord,
): Effect.Effect<boolean> {
  return verifyOuterMessage({ message: ingress.message, membership }).pipe(
    Effect.zipRight(
      verifyActionCertifiedRecord({
        record,
        membership,
      }),
    ),
    Effect.as(true),
    Effect.catchTag("ClientRepresentationError", () => Effect.succeed(false)),
  );
}

function verifyHeldVote(
  run: SuccessorRun,
  membership: VerifiedMembership,
  ingress: RouterWorkerIngress<DecodedOuterBody>,
  vote: Readonly<{ message: SignedMessage; statement: EvidenceStatement }>,
): Effect.Effect<boolean> {
  return verifyDeliveredEvidence({
    outer: ingress.message,
    evidence: vote.message,
    statement: vote.statement,
    membership,
  }).pipe(
    Effect.map(
      ({ statement }) =>
        statement.kind === "durability_vote" &&
        statement.membershipHash === membership.hash &&
        statement.signerAgentId !== run.runtime.input.localAgentCard.agentId,
    ),
    Effect.catchTag("ClientRepresentationError", () => Effect.succeed(false)),
  );
}

/**
 * Convert to the held successor once more than `n − q(n)` other members have
 * voted it durable: more than the members that can be faulty, so at least one
 * correct member staged it. The protocol phases stage the record and sign
 * this endpoint's vote, then take the held votes. The store refuses the
 * record when this endpoint has staged a re-anchor candidate away from its
 * anchor, and the endpoint tries once.
 * @param run Recovery run that holds the conversation.
 * @param membership Verified membership of the successor's conversation.
 * @returns Completion once the endpoint has converted or keeps waiting.
 */
function maybeConvert(
  run: SuccessorRun,
  membership: VerifiedMembership,
): Effect.Effect<void, RouterWorkerPersistenceError> {
  return Effect.suspend(() => {
    const conversationId = membership.descriptor.conversationId;
    const pending = run.pending.get(conversationId);
    const record = pending?.record;
    if (pending === undefined || record === undefined || pending.settled) {
      return Effect.void;
    }
    const votes = [...pending.votes.values()].filter(
      (vote) => vote.recordHash === record.recordHash,
    );
    const memberCount = membership.members.length;
    if (votes.length < memberCount - quorumThreshold(memberCount) + 1) {
      return Effect.void;
    }
    pending.settled = true;
    return run.runtime.phases
      .acceptIngress(run.runtime, record.ingress)
      .pipe(
        Effect.zipRight(
          Effect.forEach(
            votes,
            (vote) =>
              run.runtime.phases.acceptIngress(
                run.runtime,
                vote.ingress,
                vote.statement,
              ),
            { concurrency: 1, discard: true },
          ),
        ),
      );
  });
}

/**
 * The position an action extends in the run's conversation, with the run's
 * membership of that conversation.
 * @param run Recovery run that holds the conversation.
 * @param action The action a member's record carries.
 * @returns The position and membership, or nothing when the action extends
 *     no held head under the conversation's current anchor.
 */
function headExtendedBy(
  run: SuccessorRun,
  action: ActionCore,
):
  | Readonly<{ position: HeadPosition; membership: VerifiedMembership }>
  | undefined {
  const conversation = run.runtime.conversations.get(action.conversationId);
  const position =
    conversation === undefined ? undefined : headPosition(conversation);
  const membership = run.membership(action.conversationId);
  return position !== undefined &&
    membership !== undefined &&
    extendsHead(position, action)
    ? { position, membership }
    : undefined;
}

function headPosition(
  conversation: EngineConversation,
): HeadPosition | undefined {
  const { head } = conversation;
  return head === undefined
    ? undefined
    : {
        head: head.recordHash,
        anchorHash: anchorHashAtHead(conversation, head),
      };
}

/**
 * Whether an action is the next MESSAGE at a position. A record that names the
 * head from an anchor the conversation has left can never be staged.
 * @param position The conversation's head and current anchor.
 * @param action The action a record carries.
 * @returns Whether the action extends the position.
 */
function extendsHead(position: HeadPosition, action: ActionCore): boolean {
  return (
    action.kind === "MESSAGE" &&
    action.previousRecordHash === position.head &&
    action.anchorHash === position.anchorHash
  );
}

/**
 * Whether a hold takes a member's vote: one for the held record, or for any
 * record while none is held, that the member has not already sent.
 * @param pending The hold at the conversation's head.
 * @param signerAgentId The member that voted.
 * @param recordHash The record the member voted for.
 * @returns Whether the vote may replace the member's held one.
 */
function takesVote(
  pending: PendingSuccessor,
  signerAgentId: AgentId,
  recordHash: RecordHashValue,
): boolean {
  const heldRecord = pending.record?.recordHash ?? recordHash;
  return (
    !pending.settled &&
    heldRecord === recordHash &&
    pending.votes.get(signerAgentId)?.recordHash !== recordHash
  );
}

function pendingFor(
  pending: SuccessorRun["pending"],
  conversationId: ConversationIdValue,
  position: HeadPosition,
): PendingSuccessor {
  const held = pending.get(conversationId);
  if (
    held?.position.head === position.head &&
    held.position.anchorHash === position.anchorHash
  ) {
    return held;
  }
  const created: PendingSuccessor = {
    position,
    votes: new Map(),
    settled: false,
  };
  pending.set(conversationId, created);
  return created;
}
