/** @file The exact acknowledgement phrase and the one `no-acknowledgement-posts` rule both the `acknowledgements` built-in and the collective norm bundle register. */

import type { Message } from "../evaluator/index.js";
import { type CodeRule, revisionOutcome } from "./outcome.js";

/** An acknowledgement and nothing else, such as "Thanks" or "Got it". */
const EXACT_ACKNOWLEDGEMENT =
  /^(?:thanks|thank you|got it|noted|ack|acknowledged)[.!\s]*$/iu;

/**
 * Whether a message's whole text is one exact acknowledgement phrase, with
 * trailing punctuation. Anything else, such as an emoji, a name or a time,
 * keeps the message's ordinary meaning.
 * @param text The message text.
 * @returns Whether the text is only an acknowledgement.
 */
export function isAcknowledgement(text: string): boolean {
  return EXACT_ACKNOWLEDGEMENT.test(text);
}

/** A plain post to two or more members whose whole text is an exact acknowledgement asks for revision. */
export const noAcknowledgementPosts: CodeRule = {
  description: {
    id: "no-acknowledgement-posts",
    kind: "norm",
    feedback: {
      text: "Do not post a message that only thanks or acknowledges to several members. Send nothing, or send only a question or new information.",
      nextAction: "stop",
    },
  },
  statement:
    'An agent does not post to two or more members a plain message whose whole text is "thanks", "thank you", "got it", "noted", "ack" or "acknowledged".',
  assess: (message: Message) =>
    message.operation === undefined && message.recipients.length > 1
      ? revisionOutcome(isAcknowledgement(message.text))
      : "not-applicable",
};
