/** @file Real checker outputs for retained-check decoding tests. */

import { Effect, Schema } from "effect";
import { MessageIntent } from "../communication/records/index.js";
import { encodeRuntimeValue } from "../communication/store/index.js";
import {
  installEditableFirewall,
  Message,
  MessageContext,
} from "../firewall/index.js";
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
      const installed = yield* installEditableFirewall(policyOptions, store);
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
        agents: [testAgentView("alice"), testAgentView("bob")],
        message,
      };
      const result = yield* installed.firewall.checkOutgoing(message, context);
      return {
        input,
        result,
        canonicalCandidate: yield* encodeRuntimeValue(outgoing),
      };
    }),
  ),
).pipe(Effect.withSpan("makeRetainedCheckFixture"));
