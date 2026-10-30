/** @file Closed local outcome values shared without loading the evaluator. */

import { Schema } from "effect";
import { exactStruct } from "../../encoding/exact.js";

/** Registered repair advice is independent of the deciding rule's representation. */
// eslint-disable-next-line agent-code-guard/no-exported-brand-constructor -- Private evaluation and host projection compose this leaf-owned outcome grammar; package entry points do not export its constructors.
export const nextActionSchema = Schema.Literal(
  "revise",
  "wait",
  "stop",
  "seek-approval",
);

/** Operational holds remain distinct from a settled rule violation. */
// eslint-disable-next-line agent-code-guard/no-exported-brand-constructor -- Private evaluation and host projection compose this leaf-owned outcome grammar; package entry points do not export its constructors.
export const firewallRefusalReasonSchema = Schema.Literal(
  "rule-violation",
  "unresolved-evidence",
  "check-unavailable",
);

/** A completed assessment either admits or names a closed refusal reason. */
// eslint-disable-next-line agent-code-guard/no-exported-brand-constructor -- Private evaluation and host projection compose this leaf-owned outcome grammar; package entry points do not export its constructors.
export const firewallReasonSchema = Schema.Literal(
  "eligible",
  ...firewallRefusalReasonSchema.literals,
);

const instruction = {
  middlewareId: Schema.NonEmptyTrimmedString,
  ruleId: Schema.NonEmptyTrimmedString,
  instruction: Schema.NonEmptyString,
};

/** Only registered advice and visible references reach the local agent. */
// eslint-disable-next-line agent-code-guard/no-exported-brand-constructor -- Private evaluation and host projection compose this leaf-owned outcome grammar; package entry points do not export its constructors.
export const registeredGuidanceSchema = Schema.Union(
  exactStruct({
    ...instruction,
    expectation: Schema.Literal("required", "permitted", "wait", "none"),
    subjects: Schema.Array(Schema.NonEmptyTrimmedString),
  }),
  exactStruct({
    ...instruction,
    uncertain: exactStruct({
      choice: Schema.NonEmptyTrimmedString,
      probability: Schema.Number.pipe(Schema.between(0, 1)),
    }),
  }),
  exactStruct(instruction),
);
