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

const expectationGuidance = testGuidance("mon");
const registeredInstruction = {
  middlewareId: "owner",
  ruleId: "participants",
  instruction: "Check participants before sending.",
};

/** Tool results retain each registered instruction without synthesizing an expectation. */
export const replyGuidanceCases = [
  {
    name: "response expectations",
    guidance: expectationGuidance,
    instructions: [
      {
        ruleId: "participants",
        expectation: "required",
        subjects: ["candidate"],
        instruction: "Include Carol in the scheduling reply.",
      },
    ],
  },
  {
    name: "registered advice",
    guidance: { ...expectationGuidance, instructions: [registeredInstruction] },
    instructions: [
      {
        ruleId: registeredInstruction.ruleId,
        instruction: registeredInstruction.instruction,
      },
    ],
  },
] as const;
