/** @file Shared finding and revision helpers of the built-in code middleware. */

import { createHash } from "node:crypto";
import type {
  Message,
  MessageContext,
  RuleDescription,
} from "../evaluator/index.js";

/**
 * One deterministic rule a built-in and the collective norm bundle both
 * register: its description, the statement the bundle's edition records in
 * place of English text, and its finding on one send.
 */
export interface CodeRule {
  readonly description: RuleDescription;
  readonly statement: string;
  readonly assess: (
    message: Message,
    context: MessageContext,
  ) => "pass" | "not-applicable" | "revise";
}

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
