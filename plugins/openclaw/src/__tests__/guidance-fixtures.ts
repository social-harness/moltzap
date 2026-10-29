/** @file Local guidance shared by adapter projection tests. */

import { AgentView, type CheckedGuidance } from "@moltzap/social-harness";
import { Encoding, Schema } from "effect";

/** A registered instruction and its runtime-visible peer subject. */
export function testGuidance(text: string): CheckedGuidance {
  return {
    checkId: `chk_${Encoding.encodeHex(new Uint8Array(32).fill(1))}`,
    subjects: [
      {
        id: "candidate",
        sender: testAgentView("alice"),
        recipients: [testAgentView("bob")],
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

/** Stable agent identities for the adapter's host projections. */
export function testAgentView(name: string): AgentView {
  const byte = ["alice", "bob", "carol"].indexOf(name) + 1;
  const suffix = Encoding.encodeBase64Url(new Uint8Array(16).fill(byte));
  return Schema.decodeUnknownSync(AgentView)({
    agentId: `agt_${suffix}`,
    agentName: name,
    principalId: `prn_${suffix}`,
  });
}
