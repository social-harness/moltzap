/** @file Shared finding and revision helpers of the built-in code middleware. */

import { createHash } from "node:crypto";

/**
 * A code rule's finding for one candidate: a violation asks the agent to
 * revise, since the middleware never rewrites a send.
 * @param violating Whether the candidate violates the rule.
 * @returns `revise` for a violation, otherwise `pass`.
 */
export function revisionOutcome(violating: boolean): "revise" | "pass" {
  return violating ? "revise" : "pass";
}

/**
 * The lowercase hexadecimal SHA-256 digest a registration's revision uses.
 * @param text The edition text the revision identifies.
 * @returns Its 64-character digest.
 */
export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
