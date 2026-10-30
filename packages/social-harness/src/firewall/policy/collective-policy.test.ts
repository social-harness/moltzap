/** @file Collective behavior documents use the complete ordinary code and text chain. */

import { scopedLive as it } from "@effect/vitest";
import { Deferred, Effect, Schema } from "effect";
// eslint-disable-next-line agent-code-guard/prefer-effect-platform -- Tests read the shipped behavior inputs assessed by the public policy API.
import { readFileSync } from "node:fs";
import { expect } from "vitest";
import {
  auditChecks,
  destination,
  fixture,
  outgoingThrough,
} from "../../__tests__/firewall-runtime-fixtures.js";
import {
  type DecisionProvider,
  DecisionProviderError,
  type DecisionRequest,
  decodeMessagePolicy,
  type Message,
  type MessageContext,
  messagePolicyFirewall,
} from "../../daemon/index.js";
import { decodeBehavior } from "./document/index.js";
import { installEditableFirewall } from "./index.js";

// @agent-code-guard/regression-only: Proves full-chain treatment and durable guidance admission with deterministic provider stubs.

/* eslint-disable agent-code-guard/no-hardcoded-assertion-literals -- These cases pin the published rule inventory, findings and admission behavior. */

const behaviorNames = [
  "empty-acknowledgement",
  "one-gather",
  "announce-once",
  "result-settles",
  "facilitator",
];
const context = {
  agentId: "alice",
  principal: "owner-alice",
  participants: [],
  history: [],
  facts: [],
  gaps: [],
} satisfies MessageContext;
const acknowledgement = {
  id: "candidate",
  sender: "alice",
  recipients: ["bob", "carol"],
  text: "Thanks",
} satisfies Message;
const policyState = Schema.parseJson(
  Schema.Struct({
    policy: Schema.Struct({
      rules: Schema.Array(Schema.Struct({ id: Schema.String })),
    }),
  }),
);
const facilitatorFact = {
  id: "conversation-facilitator",
  source: "owner",
  text: "AgentId alice is the facilitator of these conversations.",
  visibility: "assessor",
} as const;

it.each([false, true])(
  "completes text assessment after a code refusal with provider unavailable=%s",
  (unavailable) =>
    Effect.gen(function* () {
      const selected = provider({ unavailable });
      const { installed, options } = yield* installedFixture(selected.provider);
      const result = yield* installed.firewall.checkOutgoing(acknowledgement, {
        ...context,
        facts: options.facts,
      });
      expect(result.judgment).toBe("reject");
      expect(
        result.checks
          .flatMap((check) => check.findings)
          .map((finding) => finding.ruleId),
      ).toContain("no-acknowledgement-messages");
      const first = yield* Effect.fromNullable(selected.requests[0]);
      const stated = yield* Schema.decodeUnknown(policyState)(first.state);
      expect(stated.policy.rules.map((rule) => rule.id)).toEqual([
        ...behaviorNames.filter((name) => name !== "empty-acknowledgement"),
      ]);
      expect(first.state).toContain(facilitatorFact.text);
    }),
);

it("admits a send in guidance mode when text assessment is unavailable", () =>
  Effect.gen(function* () {
    const subject = yield* fixture;
    const options = yield* installation(
      provider({ unavailable: true }).provider,
    );
    const installed = yield* installEditableFirewall(
      { ...options, mode: "guidance" },
      subject.store,
    );
    const outgoing = yield* outgoingThrough(subject, installed);
    yield* outgoing.operations
      .send({
        input: { to: destination, text: "A new proposal" },
      })
      .pipe(Effect.forkScoped);
    yield* Deferred.await(subject.outbound);
    expect(
      (yield* auditChecks(subject)).map((check) => ({
        disposition: check.disposition,
        judgment: check.result?.judgment,
      })),
    ).toEqual([{ disposition: "admitted", judgment: "hold" }]);
  }));

/** The provider records contract inputs; its fixed answers make no claim about linguistic accuracy. */
function provider(options: { readonly unavailable: boolean }) {
  const requests: DecisionRequest[] = [];
  return {
    requests,
    provider: {
      decide: (request: DecisionRequest) =>
        Effect.gen(function* () {
          requests.push(request);
          if (options.unavailable) {
            return yield* new DecisionProviderError({ reason: "transport" });
          }
          return {
            provider: "fixture",
            model: "fixture",
            usage: {},
            raw: "",
            answers: answers(request),
          };
        }),
    } satisfies DecisionProvider,
  };
}

function answers(request: DecisionRequest) {
  return Object.fromEntries(
    Object.entries(request.questions).map(([id, question]) => {
      const choices = Object.keys(question.criteria);
      const choice =
        ["relevant", "compliant", "permitted"].find((value) =>
          choices.includes(value),
        ) ?? "unresolved";
      return [
        id,
        {
          choice,
          probabilities: Object.fromEntries(
            choices.map((value) => [value, value === choice ? 1 : 0]),
          ),
        },
      ];
    }),
  );
}

function installedFixture(selected: DecisionProvider) {
  return Effect.gen(function* () {
    const subject = yield* fixture;
    const options = yield* installation(selected);
    const installed = yield* installEditableFirewall(options, subject.store);
    return { installed, options };
  });
}

function installation(selected: DecisionProvider) {
  return Effect.gen(function* () {
    const fixedRules = yield* Effect.forEach(
      behaviorNames,
      (name) =>
        decodeBehavior(
          readFileSync(
            new URL(
              `../../../behaviors/collectives/${name}/BEHAVIOR.md`,
              import.meta.url,
            ),
          ),
          (problem) => new Error(problem),
        ),
      { concurrency: 1 },
    );
    const document = yield* decodeMessagePolicy(
      JSON.stringify({
        format: "org.social-harness/message-policy/v2",
        mode: "enforcement",
        incoming: [{ use: "acknowledgements" }],
        outgoing: [{ use: "acknowledgements" }],
        text: { fixedRules },
        facts: [facilitatorFact],
        decisionProvider: { kind: "jev", model: "fixture" },
      }),
    );
    return yield* messagePolicyFirewall(document, selected);
  });
}

/* eslint-enable agent-code-guard/no-hardcoded-assertion-literals -- Restore repository defaults. */
