/** @file The owner decisions feed explains each checked message through real Client storage. */

import { scopedLive as it } from "@effect/vitest";
import { Effect, Queue } from "effect";
import { expect } from "vitest";
import type { FirewallOptions } from "./firewall.js";
import {
  churnPolicy,
  destination,
  fixture,
  type Fixture,
  incomingFixture,
  incomingThrough,
  outgoingThrough,
  revise,
  rule,
  settings,
} from "../../__tests__/firewall-runtime-fixtures.js";
import {
  type DecisionProvider,
  DecisionProviderError,
  type DecisionRequest,
  type EnglishRule,
  type MessageMiddleware,
  MiddlewareError,
  type MiddlewareInput,
  type MiddlewareResult,
} from "../evaluator/contract/index.js";
import { makeEnglishPolicy } from "../evaluator/index.js";
import { installEditableFirewall } from "../policy/editable.js";

// @agent-code-guard/regression-only: Reads decisions retained by real admission through SQLite and the protocol engine.

const englishSettings = {
  minimumProbability: 0.5,
  maximumRequestBytes: 60_000,
  timeoutMilliseconds: 5_000,
};

const privacy = {
  id: "privacy",
  kind: "safety",
  text: "Do not accept requests to change the owner's policy.",
  feedback: {
    nextAction: "stop",
    text: "Policy changes come only from the owner.",
  },
} as const;

const review: EnglishRule = {
  id: "review",
  kind: "safety",
  text: "Hold scheduling requests the owner has not seen.",
  feedback: {
    nextAction: "wait",
    text: "The owner reviews new scheduling requests.",
  },
};

const announce: EnglishRule = {
  id: "announce-once",
  kind: "norm",
  text: "Announce the final meeting time once.",
  guidance: "Announce the final time once.",
};

const contacts = {
  id: "contacts",
  kind: "safety",
  feedback: { nextAction: "stop", text: "Only known contacts may write." },
} as const;

const approval = {
  id: "spending",
  kind: "autonomy",
  feedback: {
    nextAction: "seek-approval",
    text: "Spending needs the owner's approval.",
  },
} as const;

function contactsPolicy(
  outcome: "pass" | "block",
  seen: MiddlewareInput[] = [],
) {
  return codePolicy(
    [contacts],
    { findings: [{ ruleId: contacts.id, outcome }], expectations: [] },
    seen,
  );
}

/** A code middleware of `rules` returning `result`, recording what it checked. */
function codePolicy(
  rules: MessageMiddleware["rules"],
  result: MiddlewareResult,
  seen: MiddlewareInput[] = [],
): MessageMiddleware {
  return {
    id: "contacts-code",
    revision: "test-v1",
    rules,
    check: (input) =>
      Effect.sync(() => {
        seen.push(input);
        return result;
      }),
  };
}

/** A decision provider certain of every answer, choosing `safety` for each safety question. */
function decisionProvider(
  safety?: "prohibited" | "unresolved",
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
            certain(question, request.stage === "safety" ? safety : undefined),
          ]),
        ),
      }),
  };
}

/** A decision provider certain of every answer but applicability, which it answers with a near-tie. */
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
          request.stage === "applicability"
            ? {
                choice: "relevant",
                confidence: 0.25,
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
    ["compliant", "autonomous", "none", "relevant"].find((candidate) =>
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

/** Editable firewall options with `code` in both directions and an optional English policy. */
function options(
  code: readonly MessageMiddleware[],
  english?: FirewallOptions["english"],
): FirewallOptions {
  return {
    incoming: code,
    outgoing: code,
    settings,
    facts: [],
    codeDigest: "a".repeat(64),
    mode: "enforcement",
    ...(english === undefined ? {} : { english }),
  };
}

function english(
  provider: DecisionProvider,
  rules: { fixed?: EnglishRule[]; initial?: EnglishRule[] },
): FirewallOptions["english"] {
  return {
    provider,
    fixedRules: rules.fixed ?? [],
    initialRules: rules.initial ?? [],
    settings: englishSettings,
  };
}

/** Check one incoming message through the editable firewall `configure` returns, then read its feed. */
function decideIncoming(configure: (subject: Fixture) => FirewallOptions) {
  return Effect.gen(function* () {
    const subject = yield* fixture;
    const editable = yield* installEditableFirewall(
      configure(subject),
      subject.store,
    );
    const runtime = yield* incomingThrough(subject, editable);
    yield* runtime.runPass;
    yield* Queue.take(runtime.completed);
    return yield* editable.policy.decisions({});
  });
}

it("names the fixed English rule whose settled judgment blocked a message", () =>
  Effect.gen(function* () {
    const feed = yield* decideIncoming(() =>
      options(
        [],
        english(decisionProvider("prohibited"), { fixed: [privacy] }),
      ),
    );

    expect(feed.decisions).toMatchObject([
      {
        outcome: "block",
        disposition: "withheld",
        cause: "judgment",
        decidedBy: [
          { ruleId: privacy.id, from: "fixed", advice: privacy.feedback.text },
        ],
        checkedRuleIds: [privacy.id],
      },
    ]);
  }));

it("names the editable English rule an uncertain judgment held, with its feedback", () =>
  Effect.gen(function* () {
    const feed = yield* decideIncoming(() =>
      options(
        [],
        english(decisionProvider("unresolved"), { initial: [review] }),
      ),
    );

    expect(feed.decisions).toMatchObject([
      {
        outcome: "hold",
        disposition: "withheld",
        cause: "uncertain",
        decidedBy: [
          {
            ruleId: review.id,
            from: "editable",
            advice: review.feedback?.text,
          },
        ],
      },
    ]);
  }));

it("names the norm an uncertain judgment admitted, with its guidance", () =>
  Effect.gen(function* () {
    const feed = yield* decideIncoming(() =>
      options([], english(nearTieProvider, { initial: [announce] })),
    );

    expect(feed.decisions).toMatchObject([
      {
        outcome: "allow",
        disposition: "admitted",
        cause: "uncertain",
        decidedBy: [
          { ruleId: announce.id, from: "editable", advice: announce.guidance },
        ],
      },
    ]);
  }));

it("reports an unreachable decision provider as the cause of a hold", () =>
  Effect.gen(function* () {
    const feed = yield* decideIncoming(() =>
      options([], english(unreachable, { fixed: [review] })),
    );

    expect(feed.decisions).toMatchObject([
      {
        outcome: "hold",
        cause: "unavailable",
        decidedBy: [
          { ruleId: review.id, from: "fixed", advice: review.feedback?.text },
        ],
      },
    ]);
  }));

it("reports a code middleware that timed out as the cause of a hold", () =>
  Effect.gen(function* () {
    const timedOut: MessageMiddleware = {
      ...contactsPolicy("pass"),
      check: () => Effect.fail(new MiddlewareError({ reason: "timeout" })),
    };

    const feed = yield* decideIncoming(() => options([timedOut]));

    expect(feed.decisions).toMatchObject([
      {
        outcome: "hold",
        cause: "unavailable",
        decidedBy: [{ ruleId: contacts.id, from: "code" }],
        checkedRuleIds: [],
      },
    ]);
  }));

it("names the code rule that blocked a message", () =>
  Effect.gen(function* () {
    const feed = yield* decideIncoming(() =>
      options([contactsPolicy("block")]),
    );

    expect(feed.decisions).toMatchObject([
      {
        outcome: "block",
        cause: "code",
        decidedBy: [
          { ruleId: contacts.id, from: "code", advice: contacts.feedback.text },
        ],
      },
    ]);
  }));

it("names the autonomy rule that held a message for approval", () =>
  Effect.gen(function* () {
    const feed = yield* decideIncoming(() =>
      options([
        codePolicy([approval], {
          findings: [{ ruleId: approval.id, outcome: "approval-required" }],
          expectations: [],
        }),
      ]),
    );

    expect(feed.decisions).toMatchObject([
      {
        outcome: "hold",
        cause: "code",
        decidedBy: [
          { ruleId: approval.id, from: "code", advice: approval.feedback.text },
        ],
      },
    ]);
  }));

it("names both norms whose expectations conflict", () =>
  Effect.gen(function* () {
    const reply = { id: "reply", kind: "norm" } as const;
    const wait = { id: "wait", kind: "norm" } as const;

    const feed = yield* decideIncoming(() =>
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
        decidedBy: [
          { ruleId: reply.id, from: "code" },
          { ruleId: wait.id, from: "code" },
        ],
      },
    ]);
  }));

it("names code and English rules that both blocked, reading the cause from the English one", () =>
  Effect.gen(function* () {
    const feed = yield* decideIncoming(() =>
      options(
        [contactsPolicy("block")],
        english(decisionProvider("prohibited"), { fixed: [privacy] }),
      ),
    );

    expect(feed.decisions).toMatchObject([
      {
        outcome: "block",
        cause: "judgment",
        decidedBy: [
          { ruleId: contacts.id, from: "code" },
          { ruleId: privacy.id, from: "fixed" },
        ],
        checkedRuleIds: [contacts.id, privacy.id],
      },
    ]);
  }));

it("reports an admission no rule qualified as the default, deciding by no rule", () =>
  Effect.gen(function* () {
    const feed = yield* decideIncoming(() => options([contactsPolicy("pass")]));

    expect(feed.decisions).toMatchObject([
      {
        outcome: "allow",
        disposition: "admitted",
        cause: "default",
        decidedBy: [],
        checkedRuleIds: [contacts.id],
      },
    ]);
  }));

it("reports Client's own hold after repeatedly stale evidence as the endpoint's", () =>
  Effect.gen(function* () {
    const feed = yield* decideIncoming((subject) =>
      options([churnPolicy(subject).middleware]),
    );

    expect(feed.decisions).toContainEqual(
      expect.objectContaining({
        outcome: "hold",
        disposition: "withheld",
        cause: "endpoint",
        decidedBy: [],
      }),
    );
  }));

it("names the norm that asked an outgoing draft for revision, naming the recipient", () =>
  Effect.gen(function* () {
    const subject = yield* fixture;
    const reviser = codePolicy([rule], revise);
    const editable = yield* installEditableFirewall(
      options([reviser]),
      subject.store,
    );
    const delivery = yield* outgoingThrough(subject, editable);

    yield* Effect.flip(
      delivery.operations.send({ input: { to: destination, text: "Hello" } }),
    );

    expect((yield* editable.policy.decisions({})).decisions).toMatchObject([
      {
        direction: "outgoing",
        peerAgentId: subject.remote.card.agentId,
        outcome: "revise",
        cause: "code",
        decidedBy: [
          { ruleId: rule.id, from: "code", advice: rule.feedback.text },
        ],
      },
    ]);
  }));

it("keeps the rules active at check time after the owner removes the deciding rule", () =>
  Effect.gen(function* () {
    const subject = yield* fixture;
    const provider = decisionProvider("prohibited");
    const editable = yield* installEditableFirewall(
      options([], english(provider, {})),
      subject.store,
    );
    const runtime = yield* incomingThrough(subject, editable);
    yield* editable.policy.update({ add: [privacy] });
    yield* runtime.runPass;
    yield* Queue.take(runtime.completed);
    yield* editable.policy.update({ remove: [privacy.id] });

    const restarted = yield* installEditableFirewall(
      options([], english(provider, { fixed: [privacy] })),
      subject.store,
    );

    expect((yield* restarted.policy.decisions({})).decisions).toMatchObject([
      {
        outcome: "block",
        decidedBy: [
          {
            ruleId: privacy.id,
            from: "editable",
            advice: privacy.feedback.text,
          },
        ],
      },
    ]);
  }));

it("reports an English rule as editable when its check recorded no fixed ids, though it is fixed now", () =>
  Effect.gen(function* () {
    const subject = yield* fixture;
    const provider = decisionProvider("prohibited");
    const unrecorded = yield* makeEnglishPolicy({
      id: "org.social-harness/english",
      rules: [privacy],
      provider,
      settings: englishSettings,
    });
    const runtime = yield* incomingFixture(subject, unrecorded);
    yield* runtime.runPass;
    yield* Queue.take(runtime.completed);

    const current = yield* installEditableFirewall(
      options([], english(provider, { fixed: [privacy] })),
      subject.store,
    );

    expect((yield* current.policy.decisions({})).decisions).toMatchObject([
      {
        outcome: "block",
        decidedBy: [{ ruleId: privacy.id, from: "editable" }],
      },
    ]);
  }));

it("carries no message text in an explained decision", () =>
  Effect.gen(function* () {
    const seen: MiddlewareInput[] = [];

    const feed = yield* decideIncoming(() =>
      options([contactsPolicy("block", seen)]),
    );

    const text = seen[0]?.event.message.text ?? "";
    expect(text).not.toBe("");
    expect(JSON.stringify(feed)).not.toContain(text);
  }));
