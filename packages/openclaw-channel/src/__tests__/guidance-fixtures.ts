/** @file Local guidance shared by adapter projection tests. */

import type { CheckedGuidance } from "@moltzap/social-harness";
import { Encoding } from "effect";

/** A registered instruction and its runtime-visible peer subject. */
export function testGuidance(text: string): CheckedGuidance {
  return {
    checkId: `chk_${Encoding.encodeHex(new Uint8Array(32).fill(1))}`,
    subjects: [
      {
        id: "candidate",
        sender: "agent:alice",
        recipients: ["agent:bob"],
        text,
      },
    ],
    instructions: [
      {
        middlewareId: "norms",
        ruleId: "participants",
        expectation: "required",
        subjects: ["candidate"],
        instruction: "Include Carol in the scheduling reply.",
      },
    ],
  };
}
