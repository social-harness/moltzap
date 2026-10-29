/** @file The owner decisions feed explains each checked message through real Client storage. */

import { scopedLive as it } from "@effect/vitest";
import { Effect, Queue, Schema, Struct } from "effect";
import { expect } from "vitest";
import type { FirewallOptions } from "./firewall.js";
import { makeRetainedCheckFixture } from "../../__tests__/firewall-retained-fixtures.js";
import {
  churnPolicy,
  fixture,
  type Fixture,
  incomingThrough,
  outgoingThrough,
  revise,
  rule,
  settings,
} from "../../__tests__/firewall-runtime-fixtures.js";
import { withStore } from "../../__tests__/store-schema-fixtures.js";
import { MessageAddressInput } from "../../communication/records/values.js";
import { encodeRuntimeValue } from "../../communication/store/index.js";
import { agentViewOf } from "../../identity/cards.js";
import {
  type DecisionProvider,
  DecisionProviderError,
  type DecisionRequest,
  type MessageMiddleware,
  MiddlewareError,
  type MiddlewareInput,
  type MiddlewareResult,
  type TextRule,
} from "../evaluator/contract/index.js";
import { installEditableFirewall } from "../policy/editable.js";

// @agent-code-guard/regression-only: Reads decisions retained by real admission through SQLite and the protocol engine.

const textSettings = {
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

const review: TextRule = {
  id: "review",
  kind: "safety",
  text: "Hold scheduling requests the owner has not seen.",
  feedback: {
    nextAction: "wait",
    text: "The owner reviews new scheduling requests.",
  },
};

const announce = {
  id: "announce-once",
  kind: "norm",
  text: "Announce the final meeting time once.",
  guidance: "Announce the final time once.",
} as const satisfies TextRule;

const contacts = {
  id: "contacts",
  kind: "safety",
  feedback: { nextAction: "stop", text: "Only known contacts may write." },
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

/** Configured safety rules take `safety`; other questions receive compliant answers. */
function decisionProvider(
  rules: ReadonlyArray<{ readonly id: string }> = [],
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
            certain(
              question,
              request.stage === "safety" &&
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

it("names the fixed natural-language rule whose settled judgment blocked a message", () =>
  Effect.gen(function* () {
    const feed = yield* decideIncoming(() =>
      options(
        [],
        text(decisionProvider([privacy], "prohibited"), {
          fixed: [privacy],
        }),
      ),
    );

    expect(feed.decisions).toMatchObject([
      {
        outcome: "block",
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

it("names the editable natural-language rule an uncertain judgment held, with its feedback", () =>
  Effect.gen(function* () {
    const feed = yield* decideIncoming(() =>
      options(
        [],
        text(decisionProvider([review], "unresolved"), {
          initial: [review],
        }),
      ),
    );

    expect(feed.decisions).toMatchObject([
      {
        outcome: "hold",
        disposition: "withheld",
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

it("names the norm an uncertain judgment admitted, with its guidance", () =>
  Effect.gen(function* () {
    const feed = yield* decideIncoming(() =>
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
    const feed = yield* decideIncoming(() =>
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

    const feed = yield* decideIncoming(() => options([timedOut]));

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
    const feed = yield* decideIncoming(() =>
      options([contactsPolicy("block")]),
    );

    expect(feed.decisions).toMatchObject([
      {
        outcome: "block",
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
        decidedBy: arrayContaining([
          expect.objectContaining({ ruleId: reply.id, from: "code" }),
          expect.objectContaining({ ruleId: wait.id, from: "code" }),
        ]),
      },
    ]);
  }));

it("names code and natural-language rules that both blocked, reading the cause from the natural-language one", () =>
  Effect.gen(function* () {
    const feed = yield* decideIncoming(() =>
      options(
        [contactsPolicy("block")],
        text(decisionProvider([privacy], "prohibited"), {
          fixed: [privacy],
        }),
      ),
    );

    expect(feed.decisions).toMatchObject([
      {
        outcome: "block",
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
    const feed = yield* decideIncoming(() => options([contactsPolicy("pass")]));

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

it("reports Client's own hold after repeatedly stale evidence as the endpoint's", () =>
  Effect.gen(function* () {
    const churn = yield* churnPolicy(yield* fixture);
    const editable = yield* installEditableFirewall(
      options([churn.middleware]),
      churn.subject.store,
    );
    const runtime = yield* incomingThrough(churn.subject, editable);
    yield* runtime.runPass;
    yield* Queue.take(runtime.completed);
    const feed = yield* editable.policy.decisions({});

    expect(feed.decisions).toContainEqual(
      expect.objectContaining({
        outcome: "hold",
        disposition: "withheld",
        cause: "endpoint",
        decidedBy: [],
      }),
    );
  }));

it("retains refused first-message peers after restart without an admitted conversation", () =>
  Effect.gen(function* () {
    const reviser = codePolicy([rule], revise);
    const saved = yield* Effect.scoped(refuseFirstGroupMessage(reviser));
    const recovered = yield* readRefusedDecisions(saved.directory, reviser);
    expect(recovered.decisions).toEqual(saved.decisions);
    expect(recovered.memberships).toEqual([]);
  }));

it("refuses unknown stored editable properties as persistence failures", () =>
  Effect.gen(function* () {
    const subject = yield* fixture;
    yield* subject.store.writeFirewallPolicy(
      yield* encodeRuntimeValue([
        {
          id: "review",
          kind: "safety",
          text: "Hold for review.",
          unexpected: true,
        },
      ]),
    );
    expect(
      yield* Effect.flip(
        installEditableFirewall(
          options([], text(decisionProvider(), {})),
          subject.store,
        ),
      ),
    ).toMatchObject({ reason: "persistence-failed" });
  }));

it.each([
  {
    name: "malformed input bytes",
    input: () => Effect.succeed(new TextEncoder().encode("{")),
  },
  {
    name: "an extra context field",
    input: (
      input: Effect.Effect.Success<typeof makeRetainedCheckFixture>["input"],
    ) =>
      encodeRuntimeValue({
        ...input,
        context: { ...Struct.omit(input.context), unexpected: true },
      }),
  },
])(
  "refuses a completed check with $name as a persistence failure",
  ({ input }) =>
    Effect.gen(function* () {
      const subject = yield* fixture;
      const retained = yield* makeRetainedCheckFixture;
      const checkId = "corrupt-retained-input";
      yield* subject.store.beginFirewallAttempt({
        checkId,
        direction: "outgoing",
        snapshot: (yield* subject.store.readFirewallEvidence({
          maximumRecords: 1,
        })).snapshot,
        canonicalCandidate: retained.canonicalCandidate,
        canonicalInput: yield* input(retained.input),
      });
      yield* subject.store.admitFirewallOperation(
        {
          checkId,
          admit: false,
          canonicalResult: yield* encodeRuntimeValue(retained.result),
        },
        retained.canonicalCandidate,
      );
      const installed = yield* installEditableFirewall(
        options([]),
        subject.store,
      );

      expect(yield* Effect.flip(installed.policy.decisions({}))).toMatchObject({
        reason: "persistence-failed",
      });
    }),
);

it("keeps the rules active at check time after the owner removes the deciding rule", () =>
  Effect.gen(function* () {
    const subject = yield* fixture;
    const provider = decisionProvider([privacy], "prohibited");
    const editable = yield* installEditableFirewall(
      options([], text(provider, {})),
      subject.store,
    );
    const runtime = yield* incomingThrough(subject, editable);
    yield* editable.policy.update({ add: [privacy] }, "owner");
    yield* runtime.runPass;
    yield* Queue.take(runtime.completed);
    yield* editable.policy.update({ remove: [privacy.id] }, "owner");

    const restarted = yield* installEditableFirewall(
      options([], text(provider, { fixed: [privacy] })),
      subject.store,
    );

    expect((yield* restarted.policy.decisions({})).decisions).toMatchObject([
      {
        outcome: "block",
        decidedBy: arrayContaining([
          expect.objectContaining({
            ruleId: privacy.id,
            from: "editable",
            advice: privacy.feedback.text,
          }),
        ]),
      },
    ]);
  }));

it("retains a runtime norm's ownership when the owner later replaces it", () =>
  Effect.gen(function* () {
    const subject = yield* fixture;
    const editable = yield* installEditableFirewall(
      options([], text(nearTieProvider, {})),
      subject.store,
    );
    yield* editable.policy.update({ add: [announce] }, "runtime");
    const runtime = yield* incomingThrough(subject, editable);
    yield* runtime.runPass;
    yield* Queue.take(runtime.completed);
    yield* editable.policy.update(
      { remove: [announce.id], add: [announce] },
      "owner",
    );
    const restarted = yield* installEditableFirewall(
      options([], text(nearTieProvider, {})),
      subject.store,
    );
    expect((yield* restarted.policy.decisions({})).decisions).toContainEqual(
      expect.objectContaining({
        decidedBy: arrayContaining([
          expect.objectContaining({
            ruleId: announce.id,
            from: "editable",
            owner: "runtime",
          }),
        ]),
      }),
    );
  }));

/** Containment matchers remain unknown rather than leaking Vitest's any into feed fields. */
function arrayContaining(values: readonly unknown[]): unknown {
  return expect.arrayContaining([...values]);
}

function readRefusedDecisions(directory: string, reviser: MessageMiddleware) {
  return withStore(directory, (store) =>
    Effect.gen(function* () {
      const editable = yield* installEditableFirewall(
        options([reviser]),
        store,
      );
      const { decisions } = yield* editable.policy.decisions({});
      const { memberships } = yield* store.recover();
      return { decisions, memberships };
    }),
  );
}

function refuseFirstGroupMessage(reviser: MessageMiddleware) {
  return Effect.gen(function* () {
    const subject = yield* fixture;
    const editable = yield* installEditableFirewall(
      options([reviser]),
      subject.store,
    );
    const delivery = yield* outgoingThrough(subject, editable);
    yield* Effect.flip(
      delivery.operations.send({
        input: {
          to: Schema.decodeUnknownSync(MessageAddressInput)("group:carol,bob"),
          text: "Hello",
        },
      }),
    );
    expect((yield* subject.store.recover()).memberships).toEqual([]);
    const feed = yield* editable.policy.decisions({});
    expect(feed.decisions.slice(0, 1)).toMatchObject([
      {
        direction: "outgoing",
        peer: agentViewOf(subject.remote.card),
        outcome: "revise",
        cause: "code",
        decidedBy: arrayContaining([
          expect.objectContaining({
            ruleId: rule.id,
            from: "code",
            advice: rule.feedback.text,
          }),
        ]),
      },
    ]);
    expect(feed.decisions.map((decision) => decision.peer)).toEqual([
      agentViewOf(subject.remote.card),
      agentViewOf(subject.third.card),
    ]);
    return { directory: subject.directory, decisions: feed.decisions };
  });
}
