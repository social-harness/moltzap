/** @file Runtime-safe projections of local message policy, separate from peer content. */

import { Data, Schema } from "effect";
import { exactStruct } from "../../encoding/exact.js";

/** An opaque local assessment reference conveys no approval or lookup authority. */
const checkIdSchema = Schema.String.pipe(Schema.pattern(/^chk_[a-f0-9]{64}$/u));

/**
 * Only registered instructions and runtime-visible subjects cross into a
 * host. An instruction names either the expectation the decision provider settled and
 * the messages it refers to, or the choice and probability of a norm
 * judgment the decision provider left unsettled.
 */
const checkedGuidance = {
  checkId: checkIdSchema,
  subjects: Schema.Array(
    exactStruct({
      id: Schema.NonEmptyTrimmedString,
      sender: Schema.NonEmptyTrimmedString,
      recipients: Schema.Array(Schema.NonEmptyTrimmedString),
      text: Schema.String,
    }),
  ),
  instructions: Schema.Array(
    Schema.Union(
      exactStruct({
        middlewareId: Schema.NonEmptyTrimmedString,
        ruleId: Schema.NonEmptyTrimmedString,
        expectation: Schema.Literal("required", "permitted", "wait", "none"),
        subjects: Schema.Array(Schema.NonEmptyTrimmedString),
        instruction: Schema.NonEmptyString,
      }),
      exactStruct({
        middlewareId: Schema.NonEmptyTrimmedString,
        ruleId: Schema.NonEmptyTrimmedString,
        uncertain: exactStruct({
          choice: Schema.NonEmptyTrimmedString,
          probability: Schema.Number.pipe(Schema.between(0, 1)),
        }),
        instruction: Schema.NonEmptyString,
      }),
    ),
  ),
};

/** Exact decoding of one check's guidance, wherever a host receives it. */
export const checkedGuidanceSchema = exactStruct(checkedGuidance);

/** The guidance of one checked text: a message, a request, an answer, a question or a send. */
export type CheckedGuidance = typeof checkedGuidanceSchema.Type;

/**
 * A result's guidance: one entry per answer whose check produced advice,
 * keyed by the member's `agent:` address, and one for the question when the
 * question was checked with the result. Each entry carries its own check.
 */
const resultGuidance = exactStruct({
  question: Schema.optionalWith(checkedGuidanceSchema, { exact: true }),
  answers: Schema.Array(
    exactStruct({ member: Schema.NonEmptyTrimmedString, ...checkedGuidance }),
  ),
});

/**
 * Guidance for one checked message or request, or per checked text of a
 * collective result.
 */
export const localGuidanceSchema = Schema.Union(
  checkedGuidanceSchema,
  resultGuidance,
).annotations({ identifier: "LocalGuidance" });

/** Local advice accompanies the envelope and never changes a certified item. */
export type LocalGuidance = typeof localGuidanceSchema.Type;

/** Why a local check holds a text: the same closed set for a refused send and a withheld incoming text. */
const firewallRefusal = Schema.Literal(
  "prohibited",
  "unresolved-evidence",
  "check-unavailable",
  "norm-violation",
);

/**
 * Text the local firewall withheld from the runtime, in place of a peer's
 * answer or question: the check that withheld it and why. It is local
 * projection, not peer content.
 */
export const withheldText = exactStruct({
  kind: Schema.Literal("withheld"),
  checkId: checkIdSchema,
  reason: firewallRefusal,
});

/** Stored approval requirements decode as unresolved evidence at read boundaries. */
export const retainedFirewallRefusal = Schema.transform(
  Schema.Union(firewallRefusal, Schema.Literal("approval-required")),
  firewallRefusal,
  {
    strict: true,
    decode: (reason) =>
      reason === "approval-required"
        ? ("unresolved-evidence" as const)
        : reason,
    encode: (reason) => reason,
  },
);

/** Retained withheld text uses the same refusal mapping as retained check results. */
export const retainedWithheldText = exactStruct({
  ...withheldText.fields,
  reason: retainedFirewallRefusal,
});

/** Closed refusal data is retained verbatim for idempotent send retries. */
export const firewallRefusalSchema = exactStruct({
  checkId: checkIdSchema,
  refusal: firewallRefusal,
  feedback: Schema.Array(
    exactStruct({
      nextAction: Schema.Literal("revise", "wait", "stop", "seek-approval"),
      text: Schema.NonEmptyString,
    }),
  ),
});

const refusalText = {
  prohibited: "local policy prohibits this message",
  "unresolved-evidence": "local policy needs more evidence",
  "check-unavailable": "the message policy check could not complete",
  "norm-violation": "the message does not satisfy local norms",
} as const;

/**
 * A refusal is returned only before an application invocation creates any intent.
 * Its opaque check reference survives hosts that retain only the error message.
 */
export class FirewallSendError extends Data.TaggedError("FirewallSendError")<
  typeof firewallRefusalSchema.Type
> {
  override get message(): string {
    const feedback = this.feedback
      .map((item) => `Next action: ${item.nextAction}. ${item.text}`)
      .join(" ");
    const description = `send withheld (check ${this.checkId}): ${refusalText[this.refusal]}.`;
    return feedback.length === 0 ? description : `${description} ${feedback}`;
  }
}
