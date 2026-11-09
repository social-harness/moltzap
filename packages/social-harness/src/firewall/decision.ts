/** @file Captures local admission records and safe contract recovery detail. */

import { Effect, Schema } from "effect";
import { randomBytes } from "node:crypto";
import type { Outgoing } from "../communication/service.js";
import type { FirewallEvidence } from "./chain.js";
import type { firewallRefusalReasonSchema } from "./rules.js";
import type { FirewallCompletion } from "./store.js";
import {
  canonicalBytes,
  decodeCanonical,
  encodeCanonicalJson,
} from "../encoding/canonical-json.js";
import {
  type CheckedGuidance,
  CheckInputError,
  type MessageContext,
} from "./check.js";
import {
  assessmentKey,
  type ContractCheck,
  contractReply,
} from "./contract-check.js";

type Direction = "incoming" | "outgoing";
type RefusalReason = typeof firewallRefusalReasonSchema.Type;

/** The assessed value and supplied context remain detached from later caller changes. */
export interface Candidate {
  readonly protocolContext?: MessageContext["protocol"];
  readonly value: Outgoing;
  readonly evidence: FirewallEvidence;
  readonly text?: string;
}

/** A refused message's reason, the chain rule that decided, and what its sender is told. */
export interface Refusal {
  readonly reason: RefusalReason;
  readonly rule?: string;
  readonly feedback: ReadonlyArray<{ readonly text: string }>;
  readonly detail?: unknown;
  readonly reply?: string;
}

/** A candidate's local admission and the deferred write that retains its evidence. */
export type Decision =
  | {
      readonly kind: "admitted";
      readonly completion?: FirewallCompletion;
      readonly guidance?: CheckedGuidance;
    }
  | {
      readonly kind: "refused";
      readonly completion: FirewallCompletion;
      readonly refusal: Refusal;
    };

/** Unconstrained messages still retain local admission evidence for later contract projection. */
export function defaultDecision(
  activeRevision: string,
  candidate: Candidate,
  direction: Direction,
) {
  return Effect.gen(function* () {
    const completion: FirewallCompletion = {
      checkId: mintCheckId(),
      messageKey: assessmentKey(candidate.value),
      direction,
      canonicalCandidate: yield* encodeCanonicalJson(candidate.value),
      canonicalInput: yield* canonicalBytes({
        activeRevision: activeRevision,
        evidence: candidate.evidence,
      }),
      canonicalResult: yield* canonicalBytes({
        summaries: candidatePeers(candidate, direction).map((peer) => ({
          direction,
          peer,
          outcome: "allow",
          reason: "eligible",
          decidedBy: [],
          checkedRuleIds: [],
          activeRevision: activeRevision,
        })),
      }),
      admit: true,
    };
    return { kind: "admitted", completion } satisfies Decision;
  }).pipe(Effect.withSpan("defaultDecision"));
}

/** A structural or protocol refusal retains current state alongside its exact assessment input. */
export function contractRefusal(
  activeRevision: string,
  candidate: Candidate,
  direction: Direction,
  check: Extract<ContractCheck, { readonly kind: "refused" }>,
) {
  return Effect.gen(function* () {
    const detail = {
      ...check.guidance,
      ...(check.selected === undefined
        ? {}
        : { norm: check.selected.name, revision: check.selected.digest }),
      stage: check.problem.stage,
      explanation: check.problem.detail,
      ...(check.problem.field === undefined
        ? {}
        : { field: check.problem.field }),
    };
    const rule = `${check.view.active?.contract.name ?? "norm"}-${check.problem.stage}`;
    const reply =
      direction === "incoming"
        ? contractReply(check, candidate.value, check.problem.detail)
        : undefined;
    const completion: FirewallCompletion = {
      checkId: mintCheckId(),
      messageKey: assessmentKey(candidate.value),
      direction,
      canonicalCandidate: yield* encodeCanonicalJson(candidate.value),
      canonicalInput: yield* canonicalBytes({
        activeRevision: activeRevision,
        contracts: check.contracts,
        evidence: candidate.evidence,
      }),
      canonicalResult: yield* canonicalBytes({
        detail,
        summaries: candidatePeers(candidate, direction).map((peer) => ({
          direction,
          peer,
          outcome:
            check.problem.reason === "rule-violation" ? "reject" : "hold",
          reason: check.problem.reason,
          decidedBy: [{ ruleId: rule, from: "chain" }],
          checkedRuleIds: [rule],
          activeRevision: activeRevision,
        })),
      }),
      admit: false,
    };
    return {
      kind: "refused",
      completion,
      refusal: {
        reason: check.problem.reason,
        rule,
        feedback: [{ text: check.problem.detail }],
        detail,
        ...(reply === undefined ? {} : { reply }),
      },
    } satisfies Decision;
  }).pipe(Effect.withSpan("contractRefusal"));
}

/** A saved record retains the admitted act and its opening source without reinterpreting old judgments. */
export function attachContract(
  decision: Decision,
  check: Extract<ContractCheck, { readonly kind: "ready" }>,
  value: Outgoing,
  direction: Direction,
) {
  return Effect.gen(function* () {
    if (decision.completion === undefined) {
      return yield* new CheckInputError({ reason: "context" });
    }
    const result = yield* decodeCanonical(
      Schema.Record({ key: Schema.String, value: Schema.Unknown }),
      decision.completion.canonicalResult,
    ).pipe(
      Effect.catchTag("ClientRepresentationError", () =>
        Effect.fail(new CheckInputError({ reason: "context" })),
      ),
    );
    const input = yield* decodeCanonical(
      Schema.Record({ key: Schema.String, value: Schema.Unknown }),
      decision.completion.canonicalInput,
    ).pipe(
      Effect.catchTag("ClientRepresentationError", () =>
        Effect.fail(new CheckInputError({ reason: "context" })),
      ),
    );
    const detail = {
      ...check.guidance,
      norm: check.contract.name,
      revision: check.contract.digest,
      act: check.record.act.name,
      stage:
        decision.kind === "refused" && decision.refusal.rule !== undefined
          ? "policy"
          : "semantic",
    };
    const completion = {
      ...decision.completion,
      canonicalInput: yield* canonicalBytes({
        ...input,
        contract: check.contract,
        protocolContext: check.guidance,
      }),
      canonicalResult: yield* canonicalBytes({
        ...result,
        detail,
        ...(decision.kind === "admitted" ? { protocol: check.record } : {}),
      }),
    };
    if (decision.kind === "admitted") {
      return { ...decision, completion };
    }
    const text =
      decision.refusal.feedback.map((entry) => entry.text).join(" ") ||
      `The semantic policy check returned ${decision.refusal.reason}.`;
    const reply =
      direction === "incoming" ? contractReply(check, value, text) : undefined;
    return {
      ...decision,
      completion,
      refusal: {
        ...decision.refusal,
        detail,
        ...(reply === undefined ? {} : { reply }),
      },
    };
  }).pipe(Effect.withSpan("attachContract"));
}

/** A local reference correlates an assessment without granting lookup authority. */
export function mintCheckId() {
  return `chk_${randomBytes(32).toString("hex")}`;
}

function candidatePeers(candidate: Candidate, direction: Direction) {
  return direction === "outgoing"
    ? candidate.value.recipients
    : [candidate.value.author];
}
