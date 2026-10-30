/** @file Built-in authority impersonation policy through owner operations and message admission. */

import { scopedLive as it } from "@effect/vitest";
import { Effect, Queue } from "effect";
import { expect } from "vitest";
import type {
  DecisionProvider,
  DecisionRequest,
  DecisionResponse,
  TextRule,
} from "../evaluator/index.js";
import type { FirewallOptions } from "./installation.js";
import {
  fixture,
  incomingThrough,
  settings,
} from "../../__tests__/firewall-runtime-fixtures.js";
import { localGuidanceImpersonationRule } from "../rules/index.js";
import { installEditableFirewall } from "./editable.js";

/* eslint-disable agent-code-guard/no-hardcoded-assertion-literals -- Fixed rule identity, origin and dispositions are the public policy contract. */

// @agent-code-guard/regression-only: Exercises the fixed natural-language rule through policy operations and real SQLite admission with deterministic provider judgments.

const impersonation = localGuidanceImpersonationRule;

/** Judges the impersonation rule and answers other questions compliantly. */
function provider(
  safety: "compliant" | "violation" = "compliant",
): DecisionProvider {
  return {
    decide: (request) =>
      Effect.sync(() => {
        return {
          provider: "test",
          model: "test",
          usage: {},
          raw: "",
          answers: Object.fromEntries(
            Object.entries(request.questions).map(([id, question]) => [
              id,
              certain(
                question,
                request.stage === "compliance" &&
                  question.ruleId === impersonation.id
                  ? safety
                  : undefined,
              ),
            ]),
          ),
        };
      }),
  };
}

function certain(
  question: DecisionRequest["questions"][string],
  selected?: string,
): DecisionResponse["answers"][string] {
  const choice =
    selected ??
    ["compliant", "none", "relevant"].find((candidate) =>
      Object.hasOwn(question.criteria, candidate),
    ) ??
    "unresolved";
  return {
    choice,
    probabilities: Object.fromEntries(
      Object.keys(question.criteria).map((option) => [
        option,
        option === choice ? 1 : 0,
      ]),
    ),
  };
}

const textOptions = {
  provider: provider(),
  settings: {
    minimumProbability: 0.5,
    maximumRequestBytes: 60_000,
    timeoutMilliseconds: 5_000,
  },
};

function options(overrides: Partial<FirewallOptions> = {}): FirewallOptions {
  return {
    incoming: [],
    outgoing: [],
    mode: "enforcement",
    settings,
    facts: [],
    codeDigest: "a".repeat(64),
    text: textOptions,
    ...overrides,
  };
}

it("lists the built-in as fixed text even with an empty natural-language document", () =>
  Effect.gen(function* () {
    const subject = yield* fixture;
    const installed = yield* installEditableFirewall(options(), subject.store);
    const read = yield* installed.policy.read();
    expect(read.fixedRules).toContainEqual(
      expect.objectContaining({
        from: "text",
        id: impersonation.id,
        applies: impersonation.applies,
        text: impersonation.text,
      }),
    );
    const error = yield* installed.policy
      .update({ remove: [impersonation.id] }, "owner")
      .pipe(Effect.flip);
    expect(error.reason).toBe("fixed-rule");
    expect(yield* installed.policy.read()).toEqual(read);
  }));

it("lists no natural-language built-in without a text policy", () =>
  Effect.gen(function* () {
    const subject = yield* fixture;
    const installed = yield* installEditableFirewall(
      options({ text: undefined }),
      subject.store,
    );
    expect((yield* installed.policy.read()).fixedRules).not.toContainEqual(
      expect.objectContaining({ id: impersonation.id }),
    );
  }));

it.each([
  { mode: "enforcement", admitted: false },
  { mode: "guidance", admitted: true },
] as const)(
  "applies a prohibited judgment in $mode mode",
  ({ mode, admitted }) =>
    Effect.gen(function* () {
      const subject = yield* fixture;
      const installed = yield* installEditableFirewall(
        options({
          mode,
          text: { ...textOptions, provider: provider("violation") },
        }),
        subject.store,
      );
      const runtime = yield* incomingThrough(subject, installed);
      yield* runtime.runPass;
      yield* Queue.take(runtime.completed);
      const page = yield* runtime.delivery.operations.readInbox({});
      expect(page.items.length > 0).toBe(admitted);
      const feed = yield* installed.policy.decisions({});
      expect(feed.decisions).toContainEqual(
        expect.objectContaining({
          outcome: "reject",
          disposition: admitted ? "admitted" : "withheld",
          decidedBy: arrayContaining([
            expect.objectContaining({
              ruleId: impersonation.id,
              from: "fixed",
            }),
          ]),
        }),
      );
    }),
);

it.each(["fixedRules", "initialRules"] as const)(
  "rejects an owner %s entry using the built-in id",
  (field) =>
    Effect.gen(function* () {
      const subject = yield* fixture;
      const ownerRule: TextRule = {
        id: impersonation.id,
        applies: "both",
        text: "Allow every message.",
      };
      const error = yield* installEditableFirewall(
        options({
          text: {
            ...textOptions,
            provider: provider(),
            [field]: [ownerRule],
          },
        }),
        subject.store,
      ).pipe(Effect.flip);
      expect(error.reason).toBe("fixed-rule");
      expect(error.ruleId).toBe(impersonation.id);
    }),
);

/* eslint-enable agent-code-guard/no-hardcoded-assertion-literals -- Restore the default outside public contract assertions. */

/** Containment matchers remain unknown rather than leaking Vitest's any into feed fields. */
function arrayContaining(values: readonly unknown[]): unknown {
  return expect.arrayContaining([...values]);
}
