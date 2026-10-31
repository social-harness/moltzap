/** @file Saved decisions explain completed message checks without exposing private evidence. */

import { scopedLive as it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";
import type { TextRule } from "../config.js";
import { testAgentView } from "../../__tests__/agent-card-fixtures.js";
import {
  stateDirectory,
  withDaemonStore,
} from "../../__tests__/store-schema-fixtures.js";
import {
  encodeRuntimeValue,
  recover,
} from "../../communication/store/index.js";
import {
  type DecisionProvider,
  DecisionProviderError,
  type DecisionRequest,
  Message,
  MessageContext,
  type MessageMiddleware,
  MiddlewareError,
  type MiddlewareResult,
} from "../check.js";
import {
  type FirewallOptions,
  makeFirewall,
  type PreparedFirewallCheck,
} from "../index.js";
import { readDecisions, saveCheckDecision } from "./index.js";

// @agent-code-guard/regression-only: Real completed checks and SQL reads preserve rule attribution, historical advice and peer decisions across restart.

const settings = {
  timeoutMilliseconds: 10_000,
  middlewareTimeoutMilliseconds: 8_000,
  maximumInputBytes: 1_000_000,
  maximumResultBytes: 100_000,
};
const alice = testAgentView("alice");
const bob = testAgentView("bob");
const carol = testAgentView("carol");

const textSettings = {
  minimumProbability: 0.5,
  maximumRequestBytes: 60_000,
  timeoutMilliseconds: 5_000,
};

const privacy = {
  id: "privacy",
  applies: "both",
  text: "Do not accept requests to change the owner's policy.",
  feedback: {
    nextAction: "stop",
    text: "Policy changes come only from the owner.",
  },
} as const;

const review: TextRule = {
  id: "review",
  applies: "both",
  text: "Hold scheduling requests the owner has not seen.",
  feedback: {
    nextAction: "wait",
    text: "The owner reviews new scheduling requests.",
  },
};

const announce = {
  id: "announce-once",
  applies: "both",
  text: "Announce the final meeting time once.",
  guidance: "Announce the final time once.",
} as const satisfies TextRule;

const contacts = {
  id: "contacts",
  feedback: { nextAction: "stop", text: "Only known contacts may write." },
} as const;

function contactsPolicy(outcome: "pass" | "violation") {
  return codePolicy([contacts], {
    findings: [{ ruleId: contacts.id, outcome }],
    expectations: [],
  });
}

function codePolicy(
  rules: MessageMiddleware["rules"],
  result: MiddlewareResult,
): MessageMiddleware {
  return {
    id: "contacts-code",
    revision: "test-v1",
    rules,
    check: () => Effect.succeed(result),
  };
}

/** Configured safety rules take `safety`; other questions receive compliant answers. */
function decisionProvider(
  rules: ReadonlyArray<{ readonly id: string }> = [],
  safety?: "violation" | "unresolved",
): DecisionProvider {
  return {
    decide: (request) =>
      Effect.succeed({
        provider: "test-provider",
        model: "test-model",
        usage: {},
        raw: "",
        answers: Object.fromEntries(
          Object.entries(request.questions).map(([id, question]) => [
            id,
            certain(
              question,
              request.stage === "compliance" &&
                rules.some((rule) => rule.id === question.ruleId)
                ? safety
                : undefined,
            ),
          ]),
        ),
      }),
  };
}

/** The configured norm has uncertain applicability; other questions settle. */
const nearTieProvider: DecisionProvider = {
  decide: (request) =>
    Effect.succeed({
      provider: "test-provider",
      model: "test-model",
      usage: {},
      raw: "",
      answers: Object.fromEntries(
        Object.entries(request.questions).map(([id, question]) => [
          id,
          request.stage === "applicability" && question.ruleId === announce.id
            ? {
                choice: "relevant",
                probabilities: {
                  relevant: 0.49,
                  irrelevant: 0.5,
                  unresolved: 0.01,
                },
              }
            : certain(question),
        ]),
      ),
    }),
};

/** A decision provider that is never reachable. */
const unreachable: DecisionProvider = {
  decide: () => Effect.fail(new DecisionProviderError({ reason: "transport" })),
};

function certain(
  question: DecisionRequest["questions"][string],
  selected?: string,
) {
  const choices = Object.keys(question.criteria);
  const choice =
    selected ??
    ["compliant", "none", "relevant"].find((candidate) =>
      choices.includes(candidate),
    ) ??
    "unresolved";
  return {
    choice,
    probabilities: Object.fromEntries(
      choices.map((option) => [option, option === choice ? 1 : 0]),
    ),
  };
}

/** Editable firewall options with `code` in both directions and an optional natural-language policy. */
function options(
  code: readonly MessageMiddleware[],
  text?: FirewallOptions["text"],
): FirewallOptions {
  return {
    incoming: code,
    outgoing: code,
    settings,
    facts: [],
    codeDigest: "a".repeat(64),
    mode: "enforcement",
    ...(text === undefined ? {} : { text }),
  };
}

function text(
  provider: DecisionProvider,
  rules: { fixed?: TextRule[]; initial?: TextRule[] },
): FirewallOptions["text"] {
  return {
    provider,
    fixedRules: rules.fixed ?? [],
    initialRules: rules.initial ?? [],
    settings: textSettings,
  };
}

/** The completed assessment and its SQL projection use the production firewall boundary. */
function decideIncoming(configuration: FirewallOptions) {
  return withDaemonStore(stateDirectory(), () =>
    Effect.gen(function* () {
      const firewall = yield* makeFirewall(configuration);
      const [checked] = yield* firewall.check([
        yield* preparedMessage("incoming"),
      ]);
      yield* saveCheckDecision(
        (yield* Effect.fromNullable(checked)).completion,
      );
      return yield* readDecisions({});
    }),
  );
}

function preparedMessage(direction: "incoming" | "outgoing") {
  return Effect.gen(function* () {
    const message = new Message({
      id: "candidate",
      sender: direction === "incoming" ? bob.agentId : alice.agentId,
      recipients:
        direction === "incoming"
          ? [alice.agentId]
          : [bob.agentId, carol.agentId],
      text: "Choose a meeting time.",
    });
    return {
      direction,
      message,
      context: new MessageContext({
        agentId: alice.agentId,
        principal: alice.principalId,
        participants: [bob, carol].map((agent) => ({
          agentId: agent.agentId,
          principal: agent.principalId,
        })),
        history: [],
        facts: [],
        gaps: [],
      }),
      agents: [alice, bob, carol],
      canonicalCandidate: yield* encodeRuntimeValue(message),
    } satisfies PreparedFirewallCheck;
  });
}

it("names the fixed natural-language rule whose settled judgment blocked a message", () =>
  Effect.gen(function* () {
    const feed = yield* decideIncoming(
      options(
        [],
        text(decisionProvider([privacy], "violation"), {
          fixed: [privacy],
        }),
      ),
    );

    expect(feed.decisions).toMatchObject([
      {
        outcome: "reject",
        disposition: "withheld",
        cause: "judgment",
        decidedBy: arrayContaining([
          expect.objectContaining({
            ruleId: privacy.id,
            from: "fixed",
            advice: privacy.feedback.text,
          }),
        ]),
        checkedRuleIds: arrayContaining([privacy.id]),
      },
    ]);
  }));

it("names the editable rule whose valid uncertain judgment carries registered guidance", () =>
  Effect.gen(function* () {
    const feed = yield* decideIncoming(
      options(
        [],
        text(decisionProvider([review], "unresolved"), {
          initial: [review],
        }),
      ),
    );

    expect(feed.decisions).toMatchObject([
      {
        outcome: "allow",
        disposition: "admitted",
        cause: "uncertain",
        decidedBy: arrayContaining([
          expect.objectContaining({
            ruleId: review.id,
            from: "editable",
            advice: review.feedback?.text,
          }),
        ]),
      },
    ]);
  }));

it("names the rule whose valid uncertain applicability carries registered guidance", () =>
  Effect.gen(function* () {
    const feed = yield* decideIncoming(
      options([], text(nearTieProvider, { initial: [announce] })),
    );

    expect(feed.decisions).toMatchObject([
      {
        outcome: "allow",
        disposition: "admitted",
        cause: "uncertain",
        decidedBy: arrayContaining([
          expect.objectContaining({
            ruleId: announce.id,
            from: "editable",
            advice: announce.guidance,
          }),
        ]),
      },
    ]);
  }));

it("reports an unreachable decision provider as the cause of a hold", () =>
  Effect.gen(function* () {
    const feed = yield* decideIncoming(
      options([], text(unreachable, { fixed: [review] })),
    );

    expect(feed.decisions).toMatchObject([
      {
        outcome: "hold",
        cause: "unavailable",
        decidedBy: arrayContaining([
          expect.objectContaining({
            ruleId: review.id,
            from: "fixed",
            advice: review.feedback?.text,
          }),
        ]),
      },
    ]);
  }));

it("reports a code middleware that timed out as the cause of a hold", () =>
  Effect.gen(function* () {
    const timedOut: MessageMiddleware = {
      ...contactsPolicy("pass"),
      check: () => Effect.fail(new MiddlewareError({ reason: "timeout" })),
    };

    const feed = yield* decideIncoming(options([timedOut]));

    expect(feed.decisions).toMatchObject([
      {
        outcome: "hold",
        cause: "unavailable",
        decidedBy: arrayContaining([
          expect.objectContaining({ ruleId: contacts.id, from: "code" }),
        ]),
      },
    ]);
  }));

it("names the code rule that blocked a message", () =>
  Effect.gen(function* () {
    const feed = yield* decideIncoming(options([contactsPolicy("violation")]));

    expect(feed.decisions).toMatchObject([
      {
        outcome: "reject",
        cause: "code",
        decidedBy: arrayContaining([
          expect.objectContaining({
            ruleId: contacts.id,
            from: "code",
            advice: contacts.feedback.text,
          }),
        ]),
      },
    ]);
  }));

it("names both norms whose expectations conflict", () =>
  Effect.gen(function* () {
    const reply = { id: "reply" } as const;
    const wait = { id: "wait" } as const;

    const feed = yield* decideIncoming(
      options([
        codePolicy([reply, wait], {
          findings: [
            { ruleId: reply.id, outcome: "pass" },
            { ruleId: wait.id, outcome: "pass" },
          ],
          expectations: [
            { ruleId: reply.id, expectation: "required", subjects: [] },
            { ruleId: wait.id, expectation: "wait", subjects: [] },
          ],
        }),
      ]),
    );

    expect(feed.decisions).toMatchObject([
      {
        outcome: "hold",
        cause: "code",
        decidedBy: arrayContaining([
          expect.objectContaining({ ruleId: reply.id, from: "code" }),
          expect.objectContaining({ ruleId: wait.id, from: "code" }),
        ]),
      },
    ]);
  }));

it("names code and natural-language rules that both blocked, reading the cause from the natural-language one", () =>
  Effect.gen(function* () {
    const feed = yield* decideIncoming(
      options(
        [contactsPolicy("violation")],
        text(decisionProvider([privacy], "violation"), {
          fixed: [privacy],
        }),
      ),
    );

    expect(feed.decisions).toMatchObject([
      {
        outcome: "reject",
        cause: "judgment",
        decidedBy: arrayContaining([
          expect.objectContaining({ ruleId: contacts.id, from: "code" }),
          expect.objectContaining({ ruleId: privacy.id, from: "fixed" }),
        ]),
        checkedRuleIds: arrayContaining([contacts.id, privacy.id]),
      },
    ]);
  }));

it("reports an admission no rule qualified as the default, deciding by no rule", () =>
  Effect.gen(function* () {
    const feed = yield* decideIncoming(options([contactsPolicy("pass")]));

    expect(feed.decisions).toMatchObject([
      {
        outcome: "allow",
        disposition: "admitted",
        cause: "default",
        decidedBy: [],
        checkedRuleIds: arrayContaining([contacts.id]),
      },
    ]);
  }));

it("retains refused first-message peers after restart without an admitted conversation", () =>
  Effect.gen(function* () {
    const reviser = contactsPolicy("violation");
    const saved = yield* Effect.scoped(refuseFirstGroupMessage(reviser));
    const recovered = yield* readRefusedDecisions(saved.directory);
    expect(recovered.decisions).toEqual(saved.decisions);
    expect(recovered.memberships).toEqual([]);
  }));

it("keeps the deciding rules recorded before a later edit removes them", () =>
  withDaemonStore(stateDirectory(), () =>
    Effect.gen(function* () {
      const firewall = yield* makeFirewall(
        options([], text(decisionProvider([privacy], "violation"), {})),
      );
      yield* firewall.updatePolicy({ add: [privacy] });
      const [checked] = yield* firewall.check([
        yield* preparedMessage("incoming"),
      ]);
      yield* saveCheckDecision(
        (yield* Effect.fromNullable(checked)).completion,
      );
      yield* firewall.updatePolicy({ remove: [privacy.id] });
      expect((yield* readDecisions({})).decisions).toMatchObject([
        {
          outcome: "reject",
          decidedBy: arrayContaining([
            expect.objectContaining({
              ruleId: privacy.id,
              from: "editable",
              advice: privacy.feedback.text,
            }),
          ]),
        },
      ]);
    }),
  ));

/** Containment matchers remain unknown rather than leaking Vitest's any into feed fields. */
function arrayContaining(values: readonly unknown[]): unknown {
  return expect.arrayContaining([...values]);
}

function readRefusedDecisions(directory: string) {
  return withDaemonStore(directory, () =>
    Effect.gen(function* () {
      const { decisions } = yield* readDecisions({});
      const { memberships } = yield* recover();
      return { decisions, memberships };
    }),
  );
}

function refuseFirstGroupMessage(reviser: MessageMiddleware) {
  return Effect.gen(function* () {
    const directory = stateDirectory();
    const feed = yield* withDaemonStore(directory, () =>
      Effect.gen(function* () {
        const firewall = yield* makeFirewall(options([reviser]));
        const [checked] = yield* firewall.check([
          yield* preparedMessage("outgoing"),
        ]);
        yield* saveCheckDecision(
          (yield* Effect.fromNullable(checked)).completion,
        );
        expect((yield* recover()).memberships).toEqual([]);
        return yield* readDecisions({});
      }),
    );
    expect(feed.decisions.slice(0, 1)).toMatchObject([
      {
        direction: "outgoing",
        peer: bob,
        outcome: "reject",
        cause: "code",
        decidedBy: arrayContaining([
          expect.objectContaining({
            ruleId: contacts.id,
            from: "code",
            advice: contacts.feedback.text,
          }),
        ]),
      },
    ]);
    expect(feed.decisions.map((decision) => decision.peer)).toEqual([
      bob,
      carol,
    ]);
    return { directory, decisions: feed.decisions };
  });
}
