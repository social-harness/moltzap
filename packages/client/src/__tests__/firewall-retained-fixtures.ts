/** @file Real checker outputs for retained-check decoding tests. */

import { Effect, Schema } from "effect";
import { PostIntent } from "../communication/records/index.js";
import { encodeRuntimeValue } from "../communication/store/index.js";
import { installFirewall, Message, MessageContext } from "../firewall/index.js";
import { WIRE_VERSION } from "../identity/wire-version.js";
import { digest, identifier } from "./agent-card-fixtures.js";

const policy = {
  id: "owner",
  revision: "privacy-v1",
  rules: [{ id: "privacy", kind: "safety" as const }],
  check: () =>
    Effect.succeed({
      findings: [{ ruleId: "privacy", outcome: "block" as const }],
      expectations: [],
      trace: {
        format: "test-provider/v1",
        data: "private provider response",
      },
    }),
};

const policyOptions = {
  mode: "guidance",
  incoming: [policy],
  outgoing: [policy],
  facts: [],
  codeDigest: "a".repeat(64),
  settings: {
    timeoutMilliseconds: 1000,
    middlewareTimeoutMilliseconds: 1000,
    maximumInputBytes: 10000,
    maximumResultBytes: 10000,
  },
} as const;

const candidate = Schema.decodeUnknown(PostIntent)({
  sharnessVersion: WIRE_VERSION,
  kind: "post_intent",
  conversationId: digest("cnv_", 1),
  membershipHash: digest("mbr_", 2),
  authorAgentId: identifier("agt_", 1),
  postId: digest("pst_", 3),
  content: [{ type: "text", text: "private meeting" }],
});

/** A shadow refusal retains private diagnostics even though Client may admit it. */
export const makeRetainedCheckFixture = Effect.gen(function* () {
  const installed = yield* installFirewall(policyOptions);
  const outgoing = yield* candidate;
  const message = new Message({
    id: "candidate",
    sender: identifier("agt_", 1),
    recipients: [identifier("agt_", 2)],
    text: "private meeting",
  });
  const context = new MessageContext({
    agentId: identifier("agt_", 1),
    principal: "alice-owner",
    participants: [],
    history: [],
    facts: [],
    gaps: [],
  });
  const input = {
    configurationDigest: installed.configurationDigest,
    installation: installed.metadata,
    context,
    message,
    terminal: false,
  };
  const result = yield* installed.firewall.checkOutgoing(message, context);
  return {
    input,
    result,
    canonicalCandidate: yield* encodeRuntimeValue(outgoing),
  };
}).pipe(Effect.withSpan("makeRetainedCheckFixture"));
