/** @file Immutable policy metadata and retained check decoding. */

import { Effect, Schema, Struct } from "effect";
import {
  decodeRuntimeValue,
  type FirewallAuditEntry,
} from "../../communication/store/index.js";
import { exactStruct } from "../../encoding/exact.js";
import {
  decodeFrozen,
  FirewallSettings,
  Message,
  MessageContext,
  MiddlewareObservation,
  NormExpectation,
  PrivateCheckTrace,
  RuleDescription,
  UncertainNormGuidance,
} from "../evaluator/index.js";
import { retainedFirewallRefusal } from "../outcome/index.js";

// safer-arch-ignore file-implicit-boundary-module: Checking and audit projection share exact retained value schemas; only admission/index.ts exposes these private implementations to service composition.

/** Operational evidence limits are part of the installed policy identity. */
const firewallConfiguration = Schema.Struct({
  mode: Schema.Literal("guidance", "enforcement"),
  facts: MessageContext.fields.facts,
  codeDigest: Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/u)),
  maximumHistoryRecords: Schema.Int.pipe(Schema.between(1, 1024)),
  maximumConcurrentChecks: Schema.Int.pipe(Schema.between(1, 32)),
});

const retainedFirewallReason = Schema.Union(
  Schema.Literal("eligible"),
  retainedFirewallRefusal,
);

/** A retained autonomy rule decodes as safety metadata without installation authority. */
const retainedRule = Schema.Struct({
  ...RuleDescription.fields,
  kind: Schema.transform(
    Schema.Literal("safety", "norm", "autonomy"),
    RuleDescription.fields.kind,
    {
      strict: true,
      decode: (kind) => (kind === "autonomy" ? ("safety" as const) : kind),
      encode: (kind) => kind,
    },
  ),
});

/** The optional historical context field is discarded before projection or encoding. */
const retainedContext = Schema.transform(
  exactStruct({
    ...MessageContext.fields,
    authorization: Schema.optional(Schema.Unknown),
  }),
  MessageContext,
  {
    strict: true,
    decode: (context) => Struct.omit(context, "authorization"),
    encode: (context) => context,
  },
);

/** A retained approval finding is settled even though its current reason holds the message. */
const settledHold = Schema.Struct({
  ruleId: Schema.NonEmptyTrimmedString,
  outcome: Schema.Literal("hold"),
  reason: Schema.Literal("unresolved-evidence"),
  settled: Schema.Literal(true),
});
const currentFinding = Schema.Union(
  settledHold,
  MiddlewareObservation.fields.findings.value,
);

const retainedFinding = Schema.Union(
  currentFinding,
  Schema.Struct({
    ruleId: Schema.NonEmptyTrimmedString,
    outcome: Schema.Literal("approval-required"),
  }),
);

function migrateApprovalFinding(
  finding: typeof retainedFinding.Type,
  approvalDecided: boolean,
): typeof currentFinding.Type {
  if (finding.outcome !== "approval-required") {
    return finding;
  }
  return approvalDecided
    ? {
        ruleId: finding.ruleId,
        outcome: "hold",
        reason: "unresolved-evidence",
        settled: true,
      }
    : { ruleId: finding.ruleId, outcome: "not-applicable" };
}

/** Registration provenance is retained without giving it execution authority. */
const firewallRegistration = Schema.Struct({
  id: Schema.NonEmptyTrimmedString,
  revision: Schema.NonEmptyTrimmedString,
  rules: Schema.Array(RuleDescription),
  provenance: PrivateCheckTrace,
});

/** The exact installation used by an attempt survives later process configuration. */
const firewallInstallation = Schema.Struct({
  configuration: firewallConfiguration,
  settings: FirewallSettings,
  incoming: Schema.Array(firewallRegistration),
  outgoing: Schema.Array(firewallRegistration),
});

const retainedRegistration = Schema.Struct({
  ...firewallRegistration.fields,
  rules: Schema.Array(retainedRule),
});
const retainedInstallation = Schema.Struct({
  ...firewallInstallation.fields,
  incoming: Schema.Array(retainedRegistration),
  outgoing: Schema.Array(retainedRegistration),
});

/** A missing projected message records an unsupported candidate without inventing attribution. */
const firewallAuditInput = exactStruct({
  configurationDigest: Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/u)),
  installation: retainedInstallation,
  context: retainedContext,
  message: Schema.NullOr(Message),
  terminal: Schema.Boolean,
});

const middlewareFailure = Schema.Struct({
  _tag: Schema.Literal("MiddlewareError"),
  reason: Schema.Literal(
    "unavailable",
    "timeout",
    "invalid-result",
    "budget",
    "defect",
  ),
});

/** Retained results keep private traces and judgments distinct from store admission. */
const currentAuditResult = exactStruct({
  judgment: Schema.Literal("allow", "block", "hold", "revise"),
  reason: retainedFirewallReason,
  feedback: Schema.Array(
    Schema.Struct({
      nextAction: Schema.Literal("revise", "wait", "stop", "seek-approval"),
      text: Schema.String,
    }),
  ),
  guidance: Schema.Array(
    Schema.Union(
      Schema.Struct({
        ...NormExpectation.fields,
        middlewareId: Schema.String,
        instruction: Schema.String,
      }),
      UncertainNormGuidance,
    ),
  ),
  checks: Schema.Array(
    Schema.Struct({
      ...MiddlewareObservation.fields,
      findings: Schema.Array(currentFinding),
      /** Wall-clock subtraction can be negative after a clock adjustment. */
      elapsedMilliseconds: Schema.Finite,
      failure: Schema.optional(middlewareFailure),
      trace: Schema.optional(PrivateCheckTrace),
    }),
  ),
});

/** Only the historical deciding approval reason gives an approval finding a settled hold. */
const firewallAuditResult = Schema.transform(
  exactStruct({
    ...currentAuditResult.fields,
    reason: Schema.Union(
      Schema.Literal("approval-required"),
      retainedFirewallReason,
    ),
    checks: Schema.Array(
      Schema.Struct({
        ...currentAuditResult.fields.checks.value.fields,
        findings: Schema.Array(retainedFinding),
      }),
    ),
  }),
  currentAuditResult,
  {
    strict: true,
    decode: (result) => ({
      ...result,
      reason:
        result.reason === "approval-required"
          ? ("unresolved-evidence" as const)
          : result.reason,
      checks: result.checks.map((check) => ({
        ...check,
        findings: check.findings.map((finding) =>
          migrateApprovalFinding(
            finding,
            result.reason === "approval-required",
          ),
        ),
      })),
    }),
    encode: (result) => result,
  },
);

/** Evidence limits and fixed facts captured before checking starts. */
export type FirewallConfiguration = typeof firewallConfiguration.Type;
/** Registration metadata remains tied to the policy edition that made a check. */
export type FirewallInstallation = typeof firewallInstallation.Type;

/** Configuration is copied and deeply frozen before it influences assessment. */
export const decodeFirewallConfiguration = (value: unknown) =>
  decodeFrozen(firewallConfiguration, value);
/** Trusted middleware metadata is copied without retaining caller-owned values. */
export const decodeFirewallRegistration = (value: unknown) =>
  decodeFrozen(firewallRegistration, value);
/** Installation bytes share one schema between checking and retained reads. */
export const decodeFirewallInstallation = (value: unknown) =>
  decodeFrozen(firewallInstallation, value);

/** Opaque retained bytes are interpreted only by their Client delivery owner. */
export const decodeFirewallAuditEntry = Effect.fn("decodeFirewallAuditEntry")(
  function* (entry: FirewallAuditEntry) {
    const input = yield* decodeRuntimeValue(
      firewallAuditInput,
      entry.canonicalInput,
    );
    const result =
      entry.canonicalResult === undefined
        ? null
        : yield* decodeRuntimeValue(firewallAuditResult, entry.canonicalResult);
    return {
      checkId: entry.checkId,
      direction: entry.direction,
      revision: entry.revision,
      disposition: entry.disposition,
      candidate: entry.canonicalCandidate,
      input,
      result,
    };
  },
);
