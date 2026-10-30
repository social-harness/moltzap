/** @file Real checker outputs for retained-check decoding tests. */

import { Effect, Schema } from "effect";
import { MessageIntent } from "../communication/records/index.js";
import { encodeRuntimeValue } from "../communication/store/index.js";
import { Message, MessageContext } from "../firewall/check.js";
import { makeFirewall } from "../firewall/index.js";
import { decodeFirewallAuditEntry } from "../firewall/store/index.js";
import { WIRE_VERSION } from "../identity/wire-version.js";
import { digest, identifier, testAgentView } from "./agent-card-fixtures.js";
import { stateDirectory, withDaemonStore } from "./store-schema-fixtures.js";

const policy = {
  id: "owner",
  revision: "privacy-v1",
  rules: [{ id: "privacy" }],
  check: () =>
    Effect.succeed({
      findings: [{ ruleId: "privacy", outcome: "violation" as const }],
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

const candidate = Schema.decodeUnknown(MessageIntent)({
  sharnessVersion: WIRE_VERSION,
  kind: "message_intent",
  conversationId: digest("cnv_", 1),
  membershipHash: digest("mbr_", 2),
  authorAgentId: identifier("agt_", 1),
  msgId: digest("msg_", 3),
  content: [{ type: "text", text: "private meeting" }],
});

/** A shadow refusal retains private diagnostics even though Client may admit it. */
export const makeRetainedCheckFixture = Effect.suspend(() =>
  withDaemonStore(stateDirectory(), (store) =>
    Effect.gen(function* () {
      const installed = yield* makeFirewall(policyOptions);
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
      const canonicalCandidate = yield* encodeRuntimeValue(outgoing);
      const checks = yield* installed.check([
        {
          direction: "outgoing",
          canonicalCandidate,
          context,
          agents: [testAgentView("alice"), testAgentView("bob")],
          message,
        },
      ]);
      const checked = yield* Effect.fromNullable(checks[0]);
      yield* store.saveCheckDecision(checked.completion);
      const entry = yield* Effect.fromNullable(
        (yield* store.readFirewallDecisions())[0],
      );
      const retained = yield* decodeFirewallAuditEntry(entry);

      return {
        input: retained.input,
        result: checked.result,
        canonicalCandidate,
      };
    }),
  ),
).pipe(Effect.withSpan("makeRetainedCheckFixture"));
