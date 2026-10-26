/** @file The text a host's model reads for a delivered message, question or result, the same on every host. */

import type { Content, MessageAddressInput } from "../records/values.js";
import type { InboundItem } from "./inbound.js";
import {
  type LocalGuidance,
  renderLocalGuidance,
} from "../../firewall/outcome/index.js";

type CollectiveRequestItem = Extract<
  InboundItem,
  { readonly kind: "collectiveRequest" }
>;
type CollectiveResultItem = Extract<
  InboundItem,
  { readonly kind: "collectiveResult" }
>;
type MemberOutcome = CollectiveResultItem["outcomes"][number]["outcome"];

/**
 * A message's content as the text a model reads: each text part as written,
 * each data part as JSON, one part per line.
 * @param content The delivered message's content.
 * @returns The text a host puts in the model's turn.
 */
export function renderContent(content: Content): string {
  return content
    .map((part) =>
      part.type === "text"
        ? part.text
        : (JSON.stringify(part.value) ?? "null"),
    )
    .join("\n");
}

/**
 * A request post's question as every member's model reads it: its text
 * parts, one per line. The collective part is a data part, so it is never
 * among them.
 * @param content The request post's content.
 * @returns The text parts, joined by newlines.
 */
export function questionText(content: Content): string {
  return content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n");
}

/**
 * The agents a group address names, as `agent:` addresses, in its order; a
 * direct address names none. Hosts list them on a group turn.
 * @param address A canonical address an item carries.
 * @returns The group's member addresses, or an empty list.
 */
export function groupMembers(address: MessageAddressInput): readonly string[] {
  return address.startsWith("group:")
    ? address
        .slice("group:".length)
        .split(",")
        .map((name) => `agent:${name}`)
    : [];
}

/**
 * A question another agent asked: who asked and until when, the question,
 * its form, and the exact text that answers it. Only the last line differs
 * by host, since each host's model sends the answer through its own tool.
 * @param item The delivered question.
 * @param howToAnswer The host's sentence naming the tool that sends the answer to `item.to`.
 * @param guidance Optional local instructions accompanying the peer question.
 * @returns The text of the model's turn.
 */
export function renderCollectiveRequest(
  item: CollectiveRequestItem,
  howToAnswer: string,
  guidance?: LocalGuidance,
): string {
  const body = renderCollectiveRequestBody(item);
  const answerInstructions = [
    'Answer with: {"action":"accept","content":{...}} where content matches the form, or {"action":"decline"}',
    howToAnswer,
  ];
  if (guidance === undefined) {
    return [body, ...answerInstructions].join("\n");
  }
  return [
    renderLocalGuidance(guidance, { text: body, origin: "peer" }),
    ...answerInstructions,
  ].join("\n");
}

/**
 * A question another agent asked: who asked and until when, the question and
 * its form. The firewall checks exactly this text, which the model reads
 * before the answer instructions `renderCollectiveRequest` adds.
 * @param item The delivered question.
 * @returns The question's lines of the model's turn.
 */
export function renderCollectiveRequestBody(
  item: CollectiveRequestItem,
): string {
  const asked =
    item.op === "all_gather"
      ? `all_gather from ${item.from} to ${item.to}`
      : `gather from ${item.from}`;
  return [
    `${asked}, open until ${new Date(item.deadlineAt).toISOString()}.`,
    `Question: ${item.question}`,
    `Form: ${JSON.stringify(item.requestedSchema)}`,
  ].join("\n");
}

/**
 * A gather's or all_gather's result: the question and one line per member.
 * The question is quoted as JSON, so a question a peer asked cannot add
 * lines that read as other members' outcomes.
 * @param item The delivered result.
 * @returns The text of the model's turn.
 */
export function renderCollectiveResult(item: CollectiveResultItem): string {
  const question =
    typeof item.question === "string"
      ? JSON.stringify(item.question)
      : `(withheld: ${renderWithheld(item.question)})`;
  return [
    `${item.op} result for the question sent to ${item.to}: ${question}`,
    ...item.outcomes.map(
      ({ member, outcome }) => `- ${member}: ${renderOutcome(outcome)}`,
    ),
  ].join("\n");
}

/**
 * One member's outcome as its line of a result reads it. The firewall checks
 * an answer as exactly this text.
 * @param outcome The member's outcome.
 * @returns The outcome's text.
 */
export function renderOutcome(outcome: MemberOutcome): string {
  switch (outcome.kind) {
    case "answered":
      return `answered ${JSON.stringify(outcome.content)}`;
    case "declined":
      return "declined";
    case "invalid":
      return `answered outside the form (${outcome.reason})`;
    case "no-answer":
      return "no answer";
    case "withheld":
      return `answer withheld: ${renderWithheld(outcome)}`;
    default: {
      const exhaustive: never = outcome;
      return exhaustive;
    }
  }
}

function renderWithheld(
  withheld: Extract<MemberOutcome, { readonly kind: "withheld" }>,
): string {
  return `local policy held it (${withheld.reason}, check ${withheld.checkId})`;
}
