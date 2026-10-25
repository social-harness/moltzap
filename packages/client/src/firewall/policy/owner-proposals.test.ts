/** @file Owner decisions apply validated runtime edits through durable policy operations. */

import { effect as it } from "@effect/vitest";
import { Clock, Effect, TestClock } from "effect";
import { expect } from "vitest";
import type { FirewallOptions } from "../admission/index.js";
import {
  stateDirectory,
  withStore,
} from "../../__tests__/store-schema-fixtures.js";
import {
  DecisionProviderError,
  type FirewallPolicyOperations,
} from "../evaluator/index.js";
import { installEditableFirewall } from "./index.js";

/* eslint-disable agent-code-guard/no-hardcoded-assertion-literals -- Closed policy reasons are the public behavior under test. */

const original = {
  id: "privacy",
  kind: "safety",
  text: "Keep personal details private.",
} as const;
const replacement = {
  ...original,
  text: "Share details only with approved contacts.",
};
const fixed = {
  id: "fixed",
  kind: "safety",
  text: "Protect credentials.",
} as const;
const options: FirewallOptions = {
  incoming: [],
  outgoing: [],
  mode: "enforcement",
  facts: [],
  codeDigest: "a".repeat(64),
  settings: {
    timeoutMilliseconds: 1000,
    middlewareTimeoutMilliseconds: 1000,
    maximumInputBytes: 100000,
    maximumResultBytes: 10000,
  },
  english: {
    fixedRules: [fixed],
    initialRules: [original],
    settings: {
      minimumProbability: 0.5,
      maximumRequestBytes: 60000,
      timeoutMilliseconds: 1000,
    },
    provider: {
      decide: () =>
        Effect.fail(new DecisionProviderError({ reason: "transport" })),
    },
  },
};
const edit = { add: [replacement], remove: [original.id] };
function proposalIds(feed: {
  readonly proposals: ReadonlyArray<{ readonly id: string }>;
}) {
  return feed.proposals.map((item) => item.id);
}

// @agent-code-guard/regression-only: Real SQLite and public policy operations protect durable owner authority and decision semantics.
it("shows complete proposed rules and deduplicates the same pending edit without activation", () =>
  withPolicy((policy) =>
    Effect.gen(function* () {
      const before = yield* policy.read();
      const proposedAt = yield* Clock.currentTimeMillis;
      const proposal = yield* policy.propose(edit);
      expect(proposal.id).toMatch(/^pol_[A-Za-z0-9_-]{22}$/);
      expect(
        yield* policy.propose({ remove: edit.remove, add: edit.add }),
      ).toEqual(proposal);
      expect(yield* policy.proposals({})).toEqual({
        proposals: [
          {
            ...proposal,
            kind: "policy",
            proposedAt,
            add: [replacement],
            remove: [original],
          },
        ],
      });
      expect(yield* policy.read()).toEqual(before);
      expect((yield* policy.decisions({})).activations).toEqual([]);
    }),
  ));

it.each([
  { request: { remove: ["missing"] }, reason: "invalid-rule" },
  { request: { remove: [fixed.id] }, reason: "fixed-rule" },
  { request: { add: [original] }, reason: "invalid-rule" },
  { request: { add: [fixed] }, reason: "fixed-rule" },
])(
  "rejects an invalid proposal with the update reason $reason and records nothing",
  ({ request, reason }) =>
    withPolicy((policy) =>
      Effect.gen(function* () {
        expect((yield* Effect.flip(policy.propose(request))).reason).toBe(
          reason,
        );
        expect((yield* Effect.flip(policy.update(request))).reason).toBe(
          reason,
        );
        expect(yield* policy.proposals({})).toEqual({ proposals: [] });
      }),
    ),
);

it("activates an accepted edit once and refuses the opposite decision", () =>
  withPolicy((policy) =>
    Effect.gen(function* () {
      const proposal = yield* policy.propose(edit);
      expect(yield* policy.accept(proposal)).toEqual(proposal);
      expect(yield* policy.accept(proposal)).toEqual(proposal);
      expect((yield* policy.read()).rules).toEqual([replacement]);
      expect((yield* policy.decisions({})).activations).toHaveLength(1);
      expect((yield* Effect.flip(policy.decline(proposal))).reason).toBe(
        "already-decided",
      );
      expect(yield* policy.proposals({})).toEqual({ proposals: [] });
    }),
  ));

it("discards a declined edit once while leaving the active policy unchanged", () =>
  withPolicy((policy) =>
    Effect.gen(function* () {
      const before = yield* policy.read();
      const proposal = yield* policy.propose(edit);
      expect(yield* policy.decline(proposal)).toEqual(proposal);
      expect(yield* policy.decline(proposal)).toEqual(proposal);
      expect((yield* Effect.flip(policy.accept(proposal))).reason).toBe(
        "already-decided",
      );
      expect(yield* policy.read()).toEqual(before);
      expect((yield* policy.decisions({})).activations).toEqual([]);
      expect(yield* policy.proposals({})).toEqual({ proposals: [] });
    }),
  ));

it("refuses either decision for an unknown item", () =>
  withPolicy((policy) =>
    Effect.gen(function* () {
      expect(
        (yield* Effect.flip(policy.accept({ id: "unknown" }))).reason,
      ).toBe("unknown-proposal");
      expect(
        (yield* Effect.flip(policy.decline({ id: "unknown" }))).reason,
      ).toBe("unknown-proposal");
    }),
  ));

it.each([
  { add: [replacement], remove: [original.id] },
  { remove: [original.id] },
])(
  "keeps a proposal pending when a removed rule changes or disappears: %j",
  (change) =>
    withPolicy((policy) =>
      Effect.gen(function* () {
        const proposal = yield* policy.propose({ remove: [original.id] });
        yield* policy.update(change);
        expect((yield* Effect.flip(policy.accept(proposal))).reason).toBe(
          "proposal-stale",
        );
        expect(proposalIds(yield* policy.proposals({}))).toEqual([proposal.id]);
      }),
    ),
);

it("keeps an edit pending when acceptance cannot apply it", () =>
  withPolicy((policy) =>
    Effect.gen(function* () {
      const addition = {
        id: "contacts",
        kind: "safety",
        text: "Use approved contacts.",
      } as const;
      const proposal = yield* policy.propose({ add: [addition] });
      yield* policy.update({ add: [addition] });
      expect((yield* Effect.flip(policy.accept(proposal))).reason).toBe(
        "invalid-rule",
      );
      expect(proposalIds(yield* policy.proposals({}))).toEqual([proposal.id]);
    }),
  ));

it("reads pending items oldest first with an inclusive proposal time filter", () =>
  withPolicy((policy) =>
    Effect.gen(function* () {
      const first = yield* policy.propose({ remove: [original.id] });
      yield* TestClock.adjust(10);
      const since = yield* Clock.currentTimeMillis;
      const second = yield* policy.propose(edit);
      expect(proposalIds(yield* policy.proposals({}))).toEqual([
        first.id,
        second.id,
      ]);
      expect(proposalIds(yield* policy.proposals({ since }))).toEqual([
        second.id,
      ]);
      expect(yield* policy.proposals({ since: since + 1 })).toEqual({
        proposals: [],
      });
    }),
  ));

function prepareDecisions(directory: string) {
  return withPolicy(
    (policy) =>
      Effect.gen(function* () {
        const accepted = yield* policy.propose(edit);
        yield* policy.accept(accepted);
        const declined = yield* policy.propose({ remove: [original.id] });
        yield* policy.decline(declined);
        const pending = yield* policy.propose({ remove: [original.id] });
        return {
          accepted,
          declined,
          pending,
          feed: yield* policy.proposals({}),
        };
      }),
    directory,
  );
}

function verifyRestarted(
  directory: string,
  items: Effect.Effect.Success<ReturnType<typeof prepareDecisions>>,
) {
  return withPolicy(
    (policy) =>
      Effect.gen(function* () {
        expect(yield* policy.proposals({})).toEqual(items.feed);
        expect(yield* policy.propose({ remove: [original.id] })).toEqual(
          items.pending,
        );
        expect(yield* policy.accept(items.accepted)).toEqual(items.accepted);
        expect(yield* policy.decline(items.declined)).toEqual(items.declined);
        expect((yield* Effect.flip(policy.accept(items.declined))).reason).toBe(
          "already-decided",
        );
        expect(
          (yield* Effect.flip(policy.decline(items.accepted))).reason,
        ).toBe("already-decided");
        expect((yield* policy.read()).rules).toEqual([replacement]);
      }),
    directory,
  );
}

it("retains pending and decided items and their idempotence after the store reopens", () =>
  Effect.gen(function* () {
    const directory = stateDirectory();
    const items = yield* prepareDecisions(directory);
    yield* verifyRestarted(directory, items);
  }));

function withPolicy<A, E>(
  use: (policy: FirewallPolicyOperations) => Effect.Effect<A, E>,
  directory?: string,
) {
  return withStore(directory ?? stateDirectory(), (store) =>
    installEditableFirewall(options, store).pipe(
      Effect.flatMap(({ policy }) => use(policy)),
    ),
  );
}

/* eslint-enable agent-code-guard/no-hardcoded-assertion-literals -- Restore default assertion rules outside the policy contract tests. */
