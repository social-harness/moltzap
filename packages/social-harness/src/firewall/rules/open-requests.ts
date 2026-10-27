/** @file Whether a conversation's history window holds an open request of the agent's own. */

import type { Message, MessageContext } from "../evaluator/index.js";

/**
 * Whether the window holds a request of the agent's own that is still open
 * in this conversation, assessed at the context's capture time. A gather's
 * answer closes its request, since its conversation has one member; an
 * all_gather stays open until its result. A group-addressed gather's request
 * posts sit in each member's direct conversation, outside the window its
 * check reads, so this rule cannot see them.
 */
export function hasOpenRequest(context: MessageContext): boolean {
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
