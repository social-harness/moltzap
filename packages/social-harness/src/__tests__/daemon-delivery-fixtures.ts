/** @file Fixed rule fixtures and retained decisions support host policy behavior tests. */

import { SqlClient } from "@effect/sql";
import { Effect, Schedule } from "effect";
import type {
  MessageMiddleware,
  MiddlewareInput,
  MiddlewareResult,
} from "../firewall/check.js";
import type { FirewallOptions } from "../firewall/index.js";
import type { Fixture } from "./conversation-fixtures.js";
import { decodeFirewallAuditEntry } from "../firewall/store/index.js";

/** One rule supplies attribution for findings and registered advice. */
export const rule = {
  id: "communication",
  guidance: "Answer the open scheduling question.",
  feedback: {
    nextAction: "revise",
    text: "Include all required participants.",
  },
} as const;

/** A complete finding permits admission without advice. */
export const pass: MiddlewareResult = {
  findings: [{ ruleId: rule.id, outcome: "pass" }],
  expectations: [],
};
/** A violation withholds delivery without inventing a response obligation. */
export const block: MiddlewareResult = {
  findings: [{ ruleId: rule.id, outcome: "violation" }],
  expectations: [],
};

/** Bounds allow real SQL and live scheduling while keeping an unresponsive check finite. */
const settings = {
  timeoutMilliseconds: 10_000,
  middlewareTimeoutMilliseconds: 8_000,
  maximumInputBytes: 1_000_000,
  maximumResultBytes: 100_000,
};

/** Tests select their middleware through the same installation options as a daemon owner. */
export function firewallOptions(
  middleware: MessageMiddleware,
  overrides: Partial<FirewallOptions> = {},
): FirewallOptions {
  return {
    incoming: [middleware],
    outgoing: [middleware],
    settings,
    facts: [],
    codeDigest: "a".repeat(64),
    mode: "enforcement",
    ...overrides,
  };
}

/** Records the messages and history assessed under the installed rule. */
export function observeInputs(
  seen: MiddlewareInput[],
  resultFor?: (input: MiddlewareInput) => MiddlewareResult,
): MessageMiddleware {
  return policy((input) =>
    Effect.sync(() => {
      seen.push(input);
      return resultFor === undefined ? pass : resultFor(input);
    }),
  );
}

/** Each middleware result must account for the rule registered with its installation. */
export function policy(check: MessageMiddleware["check"]): MessageMiddleware {
  return { id: "communication", revision: "test-v1", rules: [rule], check };
}

/** An observed decision means its host publication transaction has committed too. */
export function waitForChecks(
  subject: Pick<Fixture, "store" | "sql">,
  count = 1,
) {
  return auditChecks(subject).pipe(
    Effect.repeat({
      until: (checks) => checks.length >= count,
      schedule: Schedule.spaced("10 millis"),
    }),
    Effect.asVoid,
    Effect.timeout("10 seconds"),
  );
}

/** The decision is committed in the same transaction as its host publication. */
function auditChecks(subject: Pick<Fixture, "store" | "sql">) {
  return Effect.gen(function* () {
    const entries = yield* subject.store.readFirewallDecisions();
    return yield* Effect.forEach(
      [...entries].sort((left, right) => left.sequence - right.sequence),
      decodeFirewallAuditEntry,
      { concurrency: 1 },
    );
  }).pipe(Effect.provideService(SqlClient.SqlClient, subject.sql));
}
