/**
 * @file What an all_gather member keeps between the request and the close,
 * and how a close's list selects from it.
 *
 * Members retain each participant's first answer in the group conversation.
 * The close selects those answers by author and message id. Private record
 * hashes remain evidence pointers for result presentation.
 */

import type { MessageReference } from "../message.js";
import type { MsgId, RecordHash } from "../records/index.js";
import type { CollectiveClosure, Members } from "./contracts.js";
import type {
  CollectiveMemberOutcome,
  CollectiveResultItem,
} from "./inbound.js";
import type { ResponseValue } from "./wire/index.js";
import { type AgentAddress, agentAddressOf } from "../records/values.js";

// safer-arch-ignore file-implicit-boundary-module: A received all_gather request keeps these answers and the operation layer selects them by its close; nothing outside communication/collectives reads them.

/** A counted message identity with the retained evidence used for result presentation. */
export interface CountedAnswer extends MessageReference {
  readonly recordHash: RecordHash;
}

/** One participant's retained answer before the requester selects a result. */
export interface RecordedAnswer extends CountedAnswer {
  readonly response: ResponseValue;
}

/** A close whose listed answers wait for this member's own answer to certify. */
export interface HeldClose extends CollectiveClosure {
  readonly msgId: MsgId;
  readonly included: readonly MessageReference[];
}

/**
 * What a member of an all_gather keeps until the close: each member's first
 * answer certified in the group conversation, its own included, with the
 * message identity a close lists it by.
 */
export interface SharedAnswers {
  readonly members: Members;
  readonly answers: Map<AgentAddress, RecordedAnswer>;
  heldClose?: HeldClose;
}

/**
 * Keep `author`'s answer if it is an asked member without one yet. Answers
 * arrive in the conversation's chain order, so the kept one is the first
 * that every endpoint, the requester included, sees from that member.
 * @param shared The answers kept for one all_gather.
 * @param author The certified author of the answer message.
 * @param answer The answer with its message identity and private evidence pointer.
 */
export function keepFirstAnswer(
  shared: SharedAnswers,
  author: AgentAddress,
  answer: RecordedAnswer,
): void {
  if (
    shared.members.some((member) => agentAddressOf(member) === author) &&
    !shared.answers.has(author)
  ) {
    shared.answers.set(author, answer);
  }
}

/**
 * Select retained answers by both author and message id. Missing identities
 * and repeated authors make the close invalid.
 * @param shared The answers retained for one all_gather.
 * @param included The answer identities selected by the requester.
 * @returns The selected answers and whether the close names unavailable or repeated authors.
 */
export function listedAnswers(
  shared: SharedAnswers,
  included: readonly MessageReference[],
) {
  const byAuthor = new Map(
    [...shared.answers].map(([member, answer]) => [
      answer.authorAgentId,
      { member, ...answer },
    ]),
  );
  const answers = included.flatMap((reference) => {
    const answer = byAuthor.get(reference.authorAgentId);
    return answer?.msgId === reference.msgId ? [answer] : [];
  });
  return {
    answers,
    missing: answers.length < included.length,
    repeated:
      new Set(included.map((reference) => reference.authorAgentId)).size <
      included.length,
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
