/** @file Reads retained firewall checks into the owner's decision feed. */

import { Effect, Schema } from "effect";
import type { FirewallAuditEntry, FirewallStore } from "../store/index.js";
import { EndpointStoreError } from "../../communication/store/index.js";
import { decodeFirewallAuditEntry } from "../admission/index.js";
import {
  type DecidingRule,
  decidingRules,
  textPolicyFormat,
} from "../evaluator/index.js";
import { firewallDecisionsSchema } from "./contract.js";

/**
 * Returns retained decisions without message content, private inputs,
 * diagnostics or rule text. Includes registered advice only for rules that
 * determined the decision.
 */
export function readDecisions(
  store: FirewallStore,
  request: { readonly since?: number },
  editableTextId: string,
) {
  return Effect.gen(function* () {
    const entries = yield* store.readFirewallDecisions(request.since);
    const rows = yield* Effect.forEach(
      entries,
      (entry) => decisionRows(entry, editableTextId),
      {
        concurrency: 1,
      },
    );
    return yield* Schema.decodeUnknown(firewallDecisionsSchema)({
      decisions: rows.flat(),
      activations: (yield* store.readFirewallActivations(request)).map(
        (entry) => entry.activation,
      ),
    });
  }).pipe(
    Effect.catchTag("ParseError", () =>
      Effect.fail(new EndpointStoreError({ reason: "corrupt" })),
    ),
    Effect.withSpan("readDecisions"),
  );
}

function decisionRows(
  entry: FirewallAuditEntry & { readonly time: number },
  editableTextId: string,
) {
  return decodeFirewallAuditEntry(entry).pipe(
    Effect.flatMap((check) =>
      ruleOrigin(
        check.input.installation[check.direction],
        editableTextId,
      ).pipe(
        Effect.flatMap((origin) => projectDecision(check, entry.time, origin)),
      ),
    ),
  );
}

type DecodedCheck = Effect.Effect.Success<
  ReturnType<typeof decodeFirewallAuditEntry>
>;
type DecodedResult = NonNullable<DecodedCheck["result"]>;

type DecisionRow = (typeof firewallDecisionsSchema.Type.decisions)[number];
type Registration = DecodedCheck["input"]["installation"]["incoming"][number];

const textProvenance = Schema.parseJson(
  Schema.Struct({
    fixedRuleIds: Schema.Array(Schema.String),
    runtimeRuleIds: Schema.Array(Schema.String),
  }),
);

type RuleOrigin = (
  rule: DecidingRule,
) => Pick<DecisionRow["decidedBy"][number], "from" | "owner">;

function projectDecision(
  check: DecodedCheck,
  time: number,
  origin: RuleOrigin,
) {
  const result = check.result;
  if (
    result === null ||
    check.disposition === "checking" ||
    check.disposition === "interrupted"
  ) {
    return Effect.succeed([]);
  }
  const message = check.input.message;
  const peers =
    message === null ? [null] : decisionPeers(message, check.direction);
  const rules = decisionRules(
    result,
    check.input.installation[check.direction],
    origin,
  );
  return Effect.forEach(
    peers,
    (peerAgentId) => {
      const peer =
        peerAgentId === null
          ? null
          : check.input.agents.find((agent) => agent.agentId === peerAgentId);
      return peer === undefined
        ? Effect.fail(new EndpointStoreError({ reason: "corrupt" }))
        : Effect.succeed({
            checkId: check.checkId,
            time,
            direction: check.direction,
            peer,
            outcome: result.judgment,
            disposition: check.disposition,
            ...rules,
            activeRevision: check.input.configurationDigest,
          });
    },
    { concurrency: 1 },
  );
}

function decisionRules(
  result: DecodedResult,
  registrations: readonly Registration[],
  origin: RuleOrigin,
) {
  const checkedRuleIds = [
    ...new Set(
      result.checks.flatMap((middleware) =>
        middleware.findings.map((finding) => finding.ruleId),
      ),
    ),
  ];
  const deciding = decidingRules(result.reason, registrations, result.checks);
  const text = new Set(
    registrations
      .filter((entry) => entry.provenance.format === textPolicyFormat)
      .map((entry) => entry.id),
  );
  const cause = decisionCause(result, deciding, text);
  const decidedBy = deciding.map((rule) => ({
    ruleId: rule.ruleId,
    ...origin(rule),
    ...(rule.advice === undefined ? {} : { advice: rule.advice }),
  }));
  return { cause, decidedBy, checkedRuleIds };
}

/**
 * Uses the installation retained with the check so later edits cannot change
 * rule ownership in earlier decisions.
 */
function ruleOrigin(
  registrations: readonly Registration[],
  editableTextId: string,
) {
  return Effect.gen(function* () {
    const text = registrations.find(
      (entry) =>
        entry.id === editableTextId &&
        entry.provenance.format === textPolicyFormat,
    );
    const recorded =
      text === undefined
        ? { fixedRuleIds: [], runtimeRuleIds: [] }
        : yield* Schema.decodeUnknown(textProvenance)(text.provenance.data);
    const fixed = new Set(recorded.fixedRuleIds);
    const runtime = new Set(recorded.runtimeRuleIds);
    return (rule: DecidingRule): ReturnType<RuleOrigin> => {
      if (rule.middlewareId !== text?.id) {
        return { from: "code" };
      }
      return fixed.has(rule.ruleId)
        ? { from: "fixed", owner: "owner" }
        : {
            from: "editable",
            owner: runtime.has(rule.ruleId) ? "runtime" : "owner",
          };
    };
  });
}

function decisionCause(
  result: DecodedResult,
  deciding: readonly DecidingRule[],
  text: ReadonlySet<string>,
): DecisionRow["cause"] {
  const first =
    deciding.find((rule) => text.has(rule.middlewareId)) ?? deciding[0];
  if (first === undefined) {
    return emptyCause(result);
  }
  if (first.finding === "unavailable") {
    return "unavailable";
  }
  if (!text.has(first.middlewareId)) {
    return "code";
  }
  return first.finding === "uncertain" ? "uncertain" : "judgment";
}

function emptyCause(result: DecodedResult): DecisionRow["cause"] {
  if (
    result.reason === "check-unavailable" &&
    result.checks.some((check) => check.status === "unavailable")
  ) {
    return "unavailable";
  }
  return result.judgment === "allow" ? "default" : "endpoint";
}

/** Results and failures name no peer because the endpoint produces their text. */
function decisionPeers(
  message: NonNullable<DecodedCheck["input"]["message"]>,
  direction: "incoming" | "outgoing",
): ReadonlyArray<string | null> {
  if (direction === "outgoing") {
    return message.recipients;
  }
  const kind = message.operation?.kind;
  return kind === "result" || kind === "failure" ? [null] : [message.sender];
}
