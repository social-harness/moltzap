/** @file Real checker outputs for retained-audit persistence and lifecycle tests. */

import { Effect, Schema } from "effect";
import { createHash } from "node:crypto";
import { InboundItem } from "../communication/collectives/inbound.js";
import { PostIntent } from "../communication/records/index.js";
import { encodeRuntimeValue } from "../communication/store/index.js";
import { FirewallAuditRecord } from "../daemon/index.js";
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

const candidates = Effect.all({
  outgoing: Schema.decodeUnknown(PostIntent)({
    sharnessVersion: WIRE_VERSION,
    kind: "post_intent",
    conversationId: digest("cnv_", 1),
    membershipHash: digest("mbr_", 2),
    authorAgentId: identifier("agt_", 1),
    postId: digest("pst_", 3),
    content: [{ type: "text", text: "private meeting" }],
  }),
  incoming: Schema.decodeUnknown(InboundItem)({
    kind: "multicast",
    message: {
      kind: "direct",
      postId: digest("pst_", 3),
      address: "agent:alice",
      sender: "agent:alice",
      content: [{ type: "text", text: "private meeting" }],
    },
  }),
});

/** A shadow refusal retains private diagnostics even though Client may admit it. */
export const makeAuditFixture = Effect.gen(function* () {
  const installed = yield* installFirewall(policyOptions);
  const candidate = yield* candidates;
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
    authorization: { kind: "absent" },
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
    options: policyOptions,
    post: {
      authorAgentId: candidate.outgoing.authorAgentId,
      postId: candidate.outgoing.postId,
    },
    input,
    result,
    canonicalInput: yield* encodeRuntimeValue(input),
    canonicalCandidate: yield* encodeRuntimeValue(candidate.outgoing),
    canonicalIncomingCandidate: yield* encodeRuntimeValue(candidate.incoming),
    canonicalResult: yield* encodeRuntimeValue(result),
  };
}).pipe(Effect.withSpan("makeAuditFixture"));

/** Public consumers decode each exact line and independently verify the footer digest. */
export function decodeAudit(text: string) {
  const lines = text.trimEnd().split("\n");
  const records = lines.map((line) =>
    Schema.decodeUnknownSync(Schema.parseJson(FirewallAuditRecord))(line),
  );
  const digest = createHash("sha256");
  for (const [index, record] of records.entries()) {
    if (record.kind === "check" || record.kind === "activation") {
      digest.update(`${lines[index]}\n`);
    }
  }
  return { records, sha256: digest.digest("hex") };
}
