/** @file The one `one-open-request` rule both the `open-requests` built-in and the collective norm bundle register. */

import type { Message, MessageContext } from "../evaluator/index.js";
import { type CodeRule, revisionOutcome } from "./outcome.js";

/** A request is refused while the agent's earlier request in this conversation is still open. */
export const oneOpenRequest: CodeRule = {
  description: {
    id: "one-open-request",
    kind: "norm",
    feedback: {
      text: "Your earlier request in this conversation is still open. Wait for its result or its deadline before asking again; a member can answer only one open request in a conversation.",
      nextAction: "wait",
    },
  },
  statement:
    "An agent does not open a request in a conversation where an earlier request of its own is still open: no result or failure has arrived for it, its deadline has not passed, and, for a gather, its member has not answered it.",
  assess: (message, context) =>
    message.operation?.kind === "request"
      ? revisionOutcome(hasOpenRequest(context))
      : "not-applicable",
};

/**
 * Whether the window holds a request of the agent's own that is still open
 * in this conversation, assessed at the context's capture time. A gather's
 * answer closes its request, since its conversation has one member; an
 * all_gather stays open until its result. A group-addressed gather's request
 * posts sit in each member's direct conversation, outside the window its
 * check reads, so this rule cannot see them.
 */
function hasOpenRequest(context: MessageContext): boolean {
  const closed = new Set(
    context.history.flatMap((entry) => closedRequest(entry.operation)),
  );
  return context.history.some(
    (entry) =>
      entry.sender === context.agentId &&
      isOpenRequest(entry.operation, closed, context.now),
  );
}

function isOpenRequest(
  operation: Message["operation"],
  closed: ReadonlySet<string>,
  now?: number,
): boolean {
  return (
    operation?.kind === "request" &&
    !closed.has(operation.id) &&
    (now === undefined || operation.deadlineAt > now)
  );
}

function closedRequest(operation: Message["operation"]): readonly string[] {
  switch (operation?.kind) {
    case "result":
    case "failure":
      return [operation.id];
    case "answer":
      return operation.op === "gather" ? [operation.id] : [];
    case "request":
    case undefined:
      return [];
    default:
      return operation satisfies never;
  }
}
