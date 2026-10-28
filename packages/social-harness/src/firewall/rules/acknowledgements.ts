/**
 * @file The one `no-acknowledgement-posts` rule both the `acknowledgements`
 * built-in and the collective norm bundle register, and the bounded
 * acknowledgement vocabulary it assesses with.
 */

import { type CodeRule, revisionOutcome } from "./outcome.js";

/**
 * Words that thank or acknowledge receipt; a message needs one to count as an
 * acknowledgement.
 */
const ACKNOWLEDGEMENT_WORDS: ReadonlySet<string> = new Set([
  "ack",
  "acknowledged",
  "appreciate",
  "appreciated",
  "cheers",
  "got",
  "noted",
  "received",
  "roger",
  "thank",
  "thanks",
  "thx",
  "ty",
  "understood",
]);

/**
 * Words that may accompany an acknowledgement without adding information.
 * Consent and approval words such as "ok", "sounds good", "great" or
 * "perfect" answer a proposal, so a message carrying one is never an
 * acknowledgement, even with a thanks.
 */
const ACKNOWLEDGEMENT_FILLER: ReadonlySet<string> = new Set([
  "a",
  "again",
  "all",
  "and",
  "both",
  "confirmation",
  "everybody",
  "everyone",
  "folks",
  "for",
  "heads",
  "hey",
  "hi",
  "info",
  "it",
  "just",
  "know",
  "letting",
  "lot",
  "much",
  "organizing",
  "really",
  "so",
  "team",
  "that",
  "the",
  "this",
  "update",
  "updates",
  "us",
  "very",
  "you",
]);

/**
 * A plain post to two or more members that only thanks or acknowledges asks
 * for revision. Its statement, which the collective norm bundle's edition
 * records, names the whole vocabulary, so a vocabulary change moves the
 * bundle's revision.
 */
export const noAcknowledgementPosts: CodeRule = {
  description: {
    id: "no-acknowledgement-posts",
    kind: "norm",
    feedback: {
      text: "Do not post a message that only thanks or acknowledges to several members. Send nothing, or send only a question or new information.",
      nextAction: "stop",
    },
  },
  statement: `An agent does not post to two or more members a plain message with no question mark, digit, symbol or link whose every word, once addresses and mentions are removed, is an acknowledgement word (${[...ACKNOWLEDGEMENT_WORDS].join(", ")}) or a filler word (${[...ACKNOWLEDGEMENT_FILLER].join(", ")}), with at least one acknowledgement word.`,
  assess: (message) =>
    message.operation === undefined && message.recipients.length > 1
      ? revisionOutcome(isAcknowledgementOnly(message.text))
      : "not-applicable",
};

/**
 * Whether a plain message only thanks or acknowledges: no question mark,
 * digit, symbol or link, and, once addresses and mentions are removed, every
 * word an acknowledgement or filler word, with at least one acknowledgement.
 * An emoji may consent or object, and a name is not filler, so "👍",
 * "Thanks 👎" and "Thanks, Bob" are not acknowledgement-only: the rule
 * refuses only what certainly is.
 */
function isAcknowledgementOnly(text: string): boolean {
  if (/[?\d\p{S}]|https?:\/\//u.test(text)) {
    return false;
  }
  const remainder = text.replace(/(?:@|\b(?:agent|group):)\S+/gu, " ");
  const words = remainder.toLowerCase().match(/\p{L}+(?:'\p{L}+)?/gu) ?? [];
  return (
    words.length > 0 &&
    words.every(
      (word) =>
        ACKNOWLEDGEMENT_WORDS.has(word) || ACKNOWLEDGEMENT_FILLER.has(word),
    ) &&
    words.some((word) => ACKNOWLEDGEMENT_WORDS.has(word))
  );
}
