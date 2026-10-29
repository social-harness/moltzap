/**
 * @file What an all_gather member keeps between the request and the close,
 * and how a close's list selects from it.
 *
 * A member records each member's first answer certified in the group
 * conversation, its own included, under the record hash the requester's
 * close lists it by. The close names answers only by hash, so a member builds
 * its result from exactly the answers it holds under the listed hashes. The
 * requester's result uses the same member ordering.
 */

import type { PostId, RecordHash } from "../records/index.js";
import { agentAddressOf, type AgentAddress } from "../records/values.js";
import type { CollectiveClosure, Members } from "./contracts.js";
import type {
  CollectiveMemberOutcome,
  CollectiveResultItem,
} from "./inbound.js";
import type { ResponseValue } from "./wire/index.js";

// safer-arch-ignore file-implicit-boundary-module: A received all_gather request keeps these answers and the operation layer selects them by its close; nothing outside communication/collectives reads them.

/** One answer certified in an all_gather's group conversation. */
export interface CertifiedAnswer {
  readonly recordHash: RecordHash;
  readonly response: ResponseValue;
}

/** A close whose listed answers wait for this member's own answer to certify. */
export interface HeldClose extends CollectiveClosure {
  readonly postId: PostId;
  readonly included: readonly RecordHash[];
}

/**
 * What a member of an all_gather keeps until the close: each member's first
 * answer certified in the group conversation, its own included, with the
 * record hash a close lists it by.
 */
export interface SharedAnswers {
  readonly members: Members;
  readonly answers: Map<AgentAddress, CertifiedAnswer>;
  heldClose?: HeldClose;
}

/**
 * Keep `sender`'s answer if it is an asked member without one yet. Answers
 * arrive in the conversation's chain order, so the kept one is the first
 * that every endpoint, the requester included, sees from that member.
 * @param shared The answers kept for one all_gather.
 * @param sender The certified author of the answer post.
 * @param answer The answer and the hash of its certified record.
 */
export function keepFirstAnswer(
  shared: SharedAnswers,
  sender: AgentAddress,
  answer: CertifiedAnswer,
): void {
  if (
    shared.members.some((member) => agentAddressOf(member) === sender) &&
    !shared.answers.has(sender)
  ) {
    shared.answers.set(sender, answer);
  }
}

/**
 * The kept answers a close lists, in its order. `missing` says a listed hash
 * names no kept answer, and `repeated` that two listed hashes name answers
 * from one member; either means the close does not describe this endpoint's
 * history.
 * @param shared The answers kept for one all_gather.
 * @param included The record hashes the close lists.
 * @returns The listed answers with their members and records, and whether the list is whole.
 */
export function listedAnswers(
  shared: SharedAnswers,
  included: readonly RecordHash[],
) {
  const byHash = new Map(
    [...shared.answers].map(([member, answer]) => [
      answer.recordHash,
      { member, recordHash: answer.recordHash, response: answer.response },
    ]),
  );
  const answers = included.flatMap((hash) => {
    const answer = byHash.get(hash);
    return answer === undefined ? [] : [answer];
  });
  return {
    answers,
    missing: answers.length < included.length,
    repeated:
      new Set(answers.map((answer) => answer.member)).size < answers.length,
  };
}

/**
 * Each member's outcome in member order; a member without one had no answer.
 * @param members The members the operation asked.
 * @param outcomes The outcome of each member that answered.
 * @returns One outcome per member.
 */
export function memberOutcomes(
  members: Members,
  outcomes: ReadonlyMap<AgentAddress, CollectiveMemberOutcome>,
): CollectiveResultItem["outcomes"] {
  const outcome = (member: Members[number]) => ({
    member,
    outcome: outcomes.get(agentAddressOf(member)) ?? {
      kind: "no-answer" as const,
    },
  });
  const [first, ...rest] = members;
  return [outcome(first), ...rest.map(outcome)];
}
