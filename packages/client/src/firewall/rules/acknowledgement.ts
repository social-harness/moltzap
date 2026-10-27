/** @file The one acknowledgement vocabulary the built-in check and the collective norm bundle share. */

/** Words that thank or acknowledge receipt; a message needs one to count as an acknowledgement. */
export const ACKNOWLEDGEMENT_WORDS: ReadonlySet<string> = new Set([
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
export const ACKNOWLEDGEMENT_FILLER: ReadonlySet<string> = new Set([
  "a",
  "again",
  "all",
  "and",
  "both",
  "confirmation",
  "confirming",
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
  "up",
  "update",
  "updates",
  "us",
  "very",
  "you",
]);

/**
 * Whether a plain message only thanks or acknowledges: no question mark,
 * digit or link, and, once addresses and mentions are removed, every word an
 * acknowledgement or filler word, with at least one acknowledgement. An
 * emoji-only reply may consent to a proposal and a name is not filler, so
 * "👍" and "Thanks, Bob" are not acknowledgement-only: the rule refuses only
 * what certainly is.
 */
export function isAcknowledgementOnly(text: string): boolean {
  if (/[?\d]|https?:\/\//u.test(text)) {
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
