/** @file Validated evidence and contracts shared by code and natural-language checks. */

import { Cause, Data, Effect, Either, Schema } from "effect";
import { exactStruct } from "../../../encoding/exact.js";
import { AgentId } from "../../../identity/agents.js";

const identifier = Schema.NonEmptyTrimmedString;
const visibility = Schema.Literal("runtime", "assessor");
const probability = Schema.Number.pipe(Schema.between(0, 1));
const nextAction = Schema.Literal("revise", "wait", "stop", "seek-approval");

const collectingOp = Schema.Literal("gather", "all_gather");

/**
 * The collective operation a message belongs to, so a policy can tell a
 * question, an answer, a result or a failure from a plain message without
 * reading its text. A request carries its absolute deadline in epoch
 * milliseconds; an answer and a result name the operation they belong to.
 */
const messageOperation = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("request"),
    op: collectingOp,
    id: identifier,
    deadlineAt: Schema.Int.pipe(Schema.positive()),
  }),
  Schema.Struct({
    kind: Schema.Literal("answer", "result"),
    op: collectingOp,
    id: identifier,
  }),
  Schema.Struct({ kind: Schema.Literal("failure"), id: identifier }),
);

/**
 * Attribution is supplied by Client, never inferred from names in the body.
 * `operation` is absent for a plain message.
 */
export class Message extends Schema.Class<Message>("Message")({
  id: identifier,
  sender: identifier,
  recipients: Schema.NonEmptyArray(identifier),
  text: Schema.String,
  operation: Schema.optional(messageOperation),
}) {}

/* eslint-disable @typescript-eslint/naming-convention, @typescript-eslint/no-redeclare -- The history entry Schema shares its domain name with the value it decodes. */

/**
 * One message of authorized earlier history: whether the runtime can see it,
 * and whether the endpoint admitted it or withheld it.
 */
export const HistoryEntry = Schema.Struct({
  ...Message.fields,
  visibility,
  admission: Schema.Literal("admitted", "withheld"),
}).annotations({ identifier: "HistoryEntry" });

/** One validated message of earlier history. */
export type HistoryEntry = typeof HistoryEntry.Type;

/* eslint-enable @typescript-eslint/naming-convention, @typescript-eslint/no-redeclare -- Restore naming after the Schema/type pair. */

/**
 * Trusted composition supplies verified attribution and authorized evidence
 * preceding the candidate. Exclude future messages, expected test labels and
 * another endpoint's private state. Visibility determines which admitted
 * messages may appear as subjects in runtime guidance.
 */
export class MessageContext extends Schema.Class<MessageContext>(
  "MessageContext",
)({
  agentId: identifier,
  principal: identifier,
  participants: Schema.Array(
    Schema.Struct({
      agentId: identifier,
      principal: identifier,
    }),
  ),
  history: Schema.Array(HistoryEntry),
  /** Older certified records outside the configured window are not an evidence gap. */
  earlierHistoryOmitted: Schema.optional(Schema.Boolean),
  /** Epoch milliseconds when Client captured the context, so a deadline can be judged and a check replayed. */
  now: Schema.optional(Schema.Int.pipe(Schema.nonNegative())),
  facts: Schema.Array(
    Schema.Struct({
      id: identifier,
      source: identifier,
      text: Schema.NonEmptyString,
      visibility,
    }),
  ),
  gaps: Schema.Array(Schema.NonEmptyString),
}) {}

/** A direction is assigned by the boundary method, not by a peer's payload. */
const messageEvent = Schema.Union(
  Schema.Struct({ direction: Schema.Literal("incoming"), message: Message }),
  Schema.Struct({ direction: Schema.Literal("outgoing"), message: Message }),
);

/** Direction determines whether the message is received or still an unsent draft. */
export type MessageEvent = typeof messageEvent.Type;

/** Runtime advice can only select templates registered by trusted composition. */
export class RuleDescription extends Schema.Class<RuleDescription>(
  "RuleDescription",
)({
  id: identifier,
  kind: Schema.Literal("safety", "norm"),
  guidance: Schema.optional(Schema.NonEmptyString),
  feedback: Schema.optional(
    Schema.Struct({
      text: Schema.NonEmptyString,
      nextAction,
    }),
  ),
}) {}

/**
 * The decision provider interprets the rule as natural-language text.
 * Validation requires nonempty text and imposes no language restriction.
 */
export class EnglishRule extends Schema.Class<EnglishRule>("EnglishRule")({
  ...RuleDescription.fields,
  text: Schema.NonEmptyString,
}) {}

/**
 * Pass is local to one rule; only the complete firewall may return allow. An
 * uncertain pass is a norm judgment the decision provider could not settle:
 * it admits, and keeps the provider's choice and probability so the agent is advised and
 * the audit can count it. It precedes plain pass, which would otherwise
 * decode it without those fields.
 */
const policyFinding = Schema.Union(
  Schema.Struct({
    ruleId: identifier,
    outcome: Schema.Literal("pass"),
    reason: Schema.Literal("uncertain"),
    choice: identifier,
    probability,
  }),
  Schema.Struct({
    ruleId: identifier,
    outcome: Schema.Literal("pass", "not-applicable", "block", "revise"),
  }),
  Schema.Struct({
    ruleId: identifier,
    outcome: Schema.Literal("hold"),
    reason: Schema.Literal("unresolved-evidence", "check-unavailable"),
  }),
);

/** Rule findings accumulate independently of their English or code representation. */
export type PolicyFinding = typeof policyFinding.Type;

/** Subjects refer only to admitted runtime-visible messages or the incoming event. */
export class NormExpectation extends Schema.Class<NormExpectation>(
  "NormExpectation",
)({
  ruleId: identifier,
  expectation: Schema.Literal("required", "permitted", "wait", "none"),
  subjects: Schema.Array(identifier),
}) {}

/** Opaque bounded diagnostics stay private; the runner never interprets their format. */
export class PrivateCheckTrace extends Schema.Class<PrivateCheckTrace>(
  "PrivateCheckTrace",
)({
  format: identifier,
  data: Schema.String,
}) {}

/** A result is atomic: interrupted middleware has no returned partial findings. */
export class MiddlewareResult extends Schema.Class<MiddlewareResult>(
  "MiddlewareResult",
)({
  findings: Schema.Array(policyFinding),
  expectations: Schema.Array(NormExpectation),
  trace: Schema.optional(PrivateCheckTrace),
}) {}

/** Operational failures carry closed reasons, never arbitrary exception text. */
export class MiddlewareError extends Data.TaggedError("MiddlewareError")<{
  readonly reason:
    | "unavailable"
    | "timeout"
    | "invalid-result"
    | "budget"
    | "defect";
}> {}

/** Earlier judgments cannot replace evidence or erase another rule's restriction. */
export class MiddlewareObservation extends Schema.Class<MiddlewareObservation>(
  "MiddlewareObservation",
)({
  middlewareId: identifier,
  revision: identifier,
  status: Schema.Literal("completed", "unavailable"),
  findings: Schema.Array(policyFinding),
  expectations: Schema.Array(NormExpectation),
}) {}

/** Each invocation gets immutable message evidence and authorized context. */
export class MiddlewareInput extends Schema.Class<MiddlewareInput>(
  "MiddlewareInput",
)({
  event: messageEvent,
  context: MessageContext,
}) {}

/**
 * Code and English policies have the same contract. Registered code is trusted;
 * it receives no conversation or store capability and must not retain conversation
 * state or perform messaging side effects.
 *
 * Middleware ids must be unique within each direction. Change the revision
 * whenever code policy behavior changes. Every declared rule must return a
 * finding, and subject references must name admitted runtime-visible evidence.
 * Registration copies and freezes metadata, but cannot isolate mutable closure
 * state or interrupt blocking JavaScript.
 */
export interface MessageMiddleware {
  readonly id: string;
  readonly revision: string;
  readonly rules: readonly RuleDescription[];
  /** Descriptive audit data declared by trusted composition, never authority. */
  readonly provenance?: PrivateCheckTrace;
  readonly check: (
    input: MiddlewareInput,
  ) => Effect.Effect<MiddlewareResult, MiddlewareError>;
}

/** Sequential execution is bounded per entry and across the whole attempt. */
export class FirewallSettings extends Schema.Class<FirewallSettings>(
  "FirewallSettings",
)({
  timeoutMilliseconds: Schema.Positive.pipe(Schema.int()),
  middlewareTimeoutMilliseconds: Schema.Positive.pipe(Schema.int()),
  maximumInputBytes: Schema.Positive.pipe(Schema.int()),
  maximumResultBytes: Schema.Positive.pipe(Schema.int()),
}) {}

/** Invalid construction or evidence is a typed failure, never permission. */
export class CheckInputError extends Data.TaggedError("CheckInputError")<{
  readonly reason: "settings" | "registration" | "message" | "context";
}> {}

/** Every installed entry is attributed, including a skipped or failed check. */
export interface MiddlewareCheck extends MiddlewareObservation {
  readonly elapsedMilliseconds: number;
  readonly failure?: MiddlewareError;
  readonly trace?: PrivateCheckTrace;
}

/** Templates are projected only after the complete chain permits admission. */
export interface NormGuidance extends NormExpectation {
  readonly middlewareId: string;
  readonly instruction: string;
}

/* eslint-disable @typescript-eslint/naming-convention, @typescript-eslint/no-redeclare -- The guidance Schema shares its domain name with the value it decodes. */

/** A rule's registered guidance beside the decision provider's unsettled choice and probability. */
export const UncertainNormGuidance = Schema.Struct({
  middlewareId: identifier,
  ruleId: identifier,
  uncertain: Schema.Struct({ choice: identifier, probability }),
  instruction: Schema.NonEmptyString,
}).annotations({ identifier: "UncertainNormGuidance" });

/** One uncertain norm judgment as composition projects it. */
export type UncertainNormGuidance = typeof UncertainNormGuidance.Type;

/* eslint-enable @typescript-eslint/naming-convention, @typescript-eslint/no-redeclare -- Restore naming after the Schema/type pair. */

/** Private audit is separate from the only fields intended for a runtime. */
export const firewallCheckSchema = exactStruct({
  judgment: Schema.Literal("allow", "block", "hold", "revise"),
  reason: Schema.Literal(
    "eligible",
    "prohibited",
    "unresolved-evidence",
    "check-unavailable",
    "norm-violation",
  ),
  feedback: Schema.Array(Schema.Struct({ nextAction, text: Schema.String })),
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
      /** Wall-clock subtraction can be negative after a clock adjustment. */
      elapsedMilliseconds: Schema.Finite,
      failure: Schema.optional(
        Schema.transform(
          Schema.Struct({
            _tag: Schema.Literal("MiddlewareError"),
            reason: Schema.Literal(
              "unavailable",
              "timeout",
              "invalid-result",
              "budget",
              "defect",
            ),
          }),
          Schema.instanceOf(MiddlewareError),
          {
            strict: true,
            decode: (error) => new MiddlewareError(error),
            encode: (error) => ({ _tag: error._tag, reason: error.reason }),
          },
        ),
      ),
      trace: Schema.optional(PrivateCheckTrace),
    }),
  ),
});

/** The complete check keeps private traces distinct from runtime advice. */
export type FirewallCheck = typeof firewallCheckSchema.Type;

/**
 * Incoming checks can guide the recipient but cannot ask the sender to revise.
 * @inline
 */
interface IncomingCheck extends FirewallCheck {
  readonly judgment: "allow" | "block" | "hold";
}

/** Checking returns data; Client separately owns fresh, atomic send/delivery admission. */
export interface Firewall {
  readonly checkIncoming: (
    message: Message,
    context: MessageContext,
  ) => Effect.Effect<IncomingCheck, CheckInputError>;
  readonly checkOutgoing: (
    draft: Message,
    context: MessageContext,
  ) => Effect.Effect<FirewallCheck, CheckInputError>;
}

/** Bytes bound allocation, not tokenizer capacity; probability is a routing setting. */
export class EnglishPolicySettings extends Schema.Class<EnglishPolicySettings>(
  "EnglishPolicySettings",
)({
  minimumProbability: Schema.Number.pipe(Schema.between(0.5, 1)),
  maximumRequestBytes: Schema.Positive.pipe(Schema.int()),
  timeoutMilliseconds: Schema.Positive.pipe(Schema.int()),
}) {}

/**
 * Question semantics have a recorded edition independent of English wording.
 * @inline
 */
export type PolicyStage =
  | "applicability"
  | "safety"
  | "expectations"
  | "conformance";

/** Provider input contains explicit questions and state, never execution authority. */
export interface DecisionRequest {
  readonly stage: PolicyStage;
  readonly state: string;
  readonly questions: Readonly<
    Record<
      string,
      {
        readonly ruleId: string;
        readonly purpose: "assessment" | "subject";
        readonly subject?: string;
        readonly instructions: string;
        readonly criteria: Readonly<Record<string, string>>;
      }
    >
  >;
}

/** Raw provider bytes and distributions survive routing unchanged. */
export class DecisionResponse extends Schema.Class<DecisionResponse>(
  "DecisionResponse",
)({
  provider: identifier,
  model: identifier,
  answers: Schema.Record({
    key: identifier,
    value: Schema.Struct({
      choice: identifier,
      probabilities: Schema.Record({ key: identifier, value: probability }),
    }),
  }),
  usage: Schema.Record({ key: identifier, value: Schema.NonNegativeInt }),
  raw: Schema.String,
}) {}

/** The adapter scrubs credentials before retaining optional private diagnostics. */
export class DecisionProviderError extends Data.TaggedError(
  "DecisionProviderError",
)<{
  readonly reason:
    | "configuration"
    | "transport"
    | "http"
    | "timeout"
    | "invalid-response"
    | "budget"
    | "defect";
  readonly status?: number;
  readonly response?: string;
  /**
   * The usage a response body reported before the call failed, named as an
   * answered response names it, so the call's cost stays accountable. A
   * failure without a parsed body has none.
   */
  readonly accounting?: Pick<DecisionResponse, "provider" | "model" | "usage">;
}> {}

/** Entirely code-based chains have no dependency on this optional capability. */
export interface DecisionProvider {
  /** Requested provider configuration, retained even when no response arrives. */
  readonly provenance?: PrivateCheckTrace;
  readonly decide: (
    request: DecisionRequest,
  ) => Effect.Effect<DecisionResponse, DecisionProviderError>;
}

/** Returned stages retain failures and uncertainty without inventing an answer. */
export type PolicyStageTrace = {
  readonly stage: PolicyStage;
  readonly elapsedMilliseconds: number;
} & (
  | {
      readonly status: "answered";
      readonly request: DecisionRequest;
      readonly response: DecisionResponse;
      readonly uncertainQuestions: readonly string[];
    }
  | {
      readonly status: "failed";
      readonly request?: DecisionRequest;
      readonly failure: DecisionProviderError;
    }
  | { readonly status: "empty" }
  | { readonly status: "unavailable"; readonly dependency: "expectations" }
);

/** Internal English state adds frozen documents without a public snapshot/binding. */
export interface EnglishCheck {
  readonly event: typeof messageEvent.Type;
  readonly context: MessageContext;
  readonly revision: string;
  readonly rules: readonly EnglishRule[];
}

/**
 * Inspect the full cause before capturing failures so cleanup cannot erase cancellation.
 * @param check One bounded check whose interruption must propagate.
 * @param onDefect Projects an unexpected defect to a closed check failure.
 * @returns The completed result or typed failure, preserving interruption.
 */
export function captureResult<A, E, R>(
  check: Effect.Effect<A, E, R>,
  onDefect: () => E,
): Effect.Effect<Either.Either<A, E>, never, R> {
  return Effect.matchCauseEffect(check, {
    onFailure: (cause) => {
      if (Cause.isInterrupted(cause)) {
        return Effect.failCause(Cause.stripFailures(cause));
      }
      if (Cause.isDie(cause)) {
        return Effect.succeed(Either.left(onDefect()));
      }
      return Either.match(Cause.failureOrCause(cause), {
        onLeft: (error) => Effect.succeed(Either.left(error)),
        onRight: Effect.failCause,
      });
    },
    onSuccess: (value) => Effect.succeed(Either.right(value)),
  });
}

/**
 * Copy before freezing so callers and injected policies cannot alter later checks.
 * @param schema Closed evidence grammar used for a detached round trip.
 * @param input Caller-owned evidence whose references must not escape.
 * @returns A deeply frozen copy or a typed decoding failure.
 */
export function decodeFrozen<A, I>(
  schema: Schema.Schema<A, I>,
  input: unknown,
) {
  return Schema.decodeUnknown(schema)(input, {
    onExcessProperty: "error",
  }).pipe(
    Effect.flatMap(Schema.encode(Schema.parseJson(schema))),
    Effect.flatMap(Schema.decode(Schema.parseJson(schema))),
    Effect.tap((value) =>
      Effect.sync(() => {
        freezeData(value);
      }),
    ),
  );
}

function freezeData(value: unknown): void {
  if (typeof value !== "object" || value === null) {
    return;
  }
  for (const child of Object.values(value)) {
    freezeData(child);
  }
  Object.freeze(value);
}

const ruleFields = {
  id: EnglishRule.fields.id,
  text: EnglishRule.fields.text,
  feedback: EnglishRule.fields.feedback,
};

/** Norm instructions must have a registered template before owners can activate them. */
const editableRuleSchema = Schema.Union(
  exactStruct({
    ...ruleFields,
    kind: Schema.Literal("norm"),
    guidance: Schema.NonEmptyString,
  }),
  exactStruct({
    ...ruleFields,
    kind: Schema.Literal("safety"),
    guidance: EnglishRule.fields.guidance,
  }),
);

/** The most editable English rules one daemon holds, across seeding, persistence and updates. */
export const MAXIMUM_EDITABLE_RULES = 256;

/** The complete editable document. */
export const editableDocumentSchema = Schema.Array(editableRuleSchema).pipe(
  Schema.maxItems(MAXIMUM_EDITABLE_RULES),
);

/**
 * A shared norm's `BEHAVIOR.md` exactly as proposed, mapped to its rule as a
 * policy file's behaviors are: docs/reference/spec/agent/message-policy.md#behaviors.
 */
const behaviorAddition = exactStruct({ behavior: Schema.String });

/** Removing and adding the same editable id replaces it in one activation. */
export const policyUpdateSchema = exactStruct({
  add: Schema.optional(
    Schema.Array(Schema.Union(editableRuleSchema, behaviorAddition)).pipe(
      Schema.maxItems(MAXIMUM_EDITABLE_RULES),
    ),
  ),
  remove: Schema.optional(
    Schema.Array(EnglishRule.fields.id).pipe(
      Schema.maxItems(MAXIMUM_EDITABLE_RULES),
    ),
  ),
});

const describedFields = {
  id: RuleDescription.fields.id,
  kind: RuleDescription.fields.kind,
  guidance: RuleDescription.fields.guidance,
  feedback: RuleDescription.fields.feedback,
};

/**
 * A fixed rule as trusted composition installed it: English text, or the
 * description a code middleware declares for a rule it checks in code.
 */
const fixedRuleSchema = Schema.Union(
  exactStruct({
    from: Schema.Literal("code"),
    middleware: Schema.NonEmptyString,
    ...describedFields,
  }),
  exactStruct({
    from: Schema.Literal("english"),
    ...describedFields,
    text: EnglishRule.fields.text,
  }),
);

/** The digest identifies the entire active installation, including fixed policy. */
export const policyReadSchema = exactStruct({
  rules: Schema.Array(editableRuleSchema),
  fixedRules: Schema.Array(fixedRuleSchema),
  activeRevision: Schema.NonEmptyString,
});

/** Activation acknowledges future checks only; retained dispositions are unchanged. */
export const policyUpdateResultSchema = exactStruct({
  activeRevision: Schema.NonEmptyString,
});

/** Inclusive Unix milliseconds permit polling across checks completed out of start order. */
export const firewallDecisionsRequestSchema = exactStruct({
  since: Schema.optional(Schema.NonNegativeInt),
});

/** Activation metadata contains rule ids only, never their text or templates. */
const firewallActivationSchema = exactStruct({
  time: Schema.NonNegativeInt,
  activeRevision: Schema.NonEmptyString,
  addedRuleIds: Schema.Array(Schema.NonEmptyString),
  removedRuleIds: Schema.Array(Schema.NonEmptyString),
});

/**
 * How a decision's outcome came about. `judgment` is a settled English
 * judgment and `uncertain` an unsettled one, admitted or held with guidance.
 * `unavailable` is a check that could not run: the decision provider failed
 * or was unreachable, or a middleware failed or timed out. `code` is a code
 * middleware's finding. `endpoint` is a hold Client makes itself without a
 * deciding rule, and `default` an admission no rule qualified.
 */
const decisionCause = Schema.Literal(
  "judgment",
  "uncertain",
  "unavailable",
  "code",
  "endpoint",
  "default",
);

/**
 * One row per peer contains no message content or provider traces. The only
 * text is `decidedBy[].advice`, the deciding rule's own registered feedback,
 * or its guidance for an admission. `decidedBy[].from` says where the rule is
 * defined, as `policy_read` lists it: a code middleware, a fixed English rule,
 * or an owner-editable English rule. `checkedRuleIds` lists every rule with a
 * finding in the completed chain.
 */
export const firewallDecisionsSchema = exactStruct({
  activations: Schema.Array(firewallActivationSchema),
  decisions: Schema.Array(
    exactStruct({
      checkId: Schema.NonEmptyString,
      time: Schema.NonNegativeInt,
      direction: Schema.Literal("incoming", "outgoing"),
      peerAgentId: Schema.NullOr(AgentId),
      outcome: Schema.Literal("allow", "block", "hold", "revise"),
      disposition: Schema.Literal("stale", "admitted", "withheld"),
      cause: decisionCause,
      decidedBy: Schema.Array(
        exactStruct({
          ruleId: Schema.NonEmptyString,
          from: Schema.Literal("code", "fixed", "editable"),
          advice: Schema.optional(Schema.NonEmptyString),
        }),
      ),
      checkedRuleIds: Schema.Array(Schema.NonEmptyString),
      activeRevision: Schema.NonEmptyString,
    }),
  ),
});

/**
 * What made an edit's rule invalid. A `BEHAVIOR.md` addition fails as
 * `frontmatter`, `schema`, `too-large` or `not-norm`; an edit as
 * `duplicate-id`, `unknown-id` or `editable-limit`.
 * @inline
 */
export type PolicyProblem =
  | "duplicate-id"
  | "unknown-id"
  | "editable-limit"
  | "frontmatter"
  | "schema"
  | "too-large"
  | "not-norm";

const policyProblemText: Readonly<Record<PolicyProblem, string>> = {
  "duplicate-id":
    "its id is already in the policy; remove that rule in the same update to replace it, or use another id",
  "unknown-id":
    "no editable rule has this id; policy_read lists the editable rules",
  "editable-limit": `the update would leave more than ${String(MAXIMUM_EDITABLE_RULES)} editable rules; remove some rules first`,
  frontmatter:
    "the BEHAVIOR.md needs valid YAML frontmatter between --- lines (no code fence or other text before it)",
  schema:
    "it does not map to an editable rule: a norm needs guidance, and a BEHAVIOR.md needs name, description and metadata.social-harness.guidance, with no metadata.social-harness keys other than kind, guidance and feedback",
  "too-large": "the BEHAVIOR.md is over 64 KiB",
  "not-norm": "the BEHAVIOR.md is not kind norm; a shared norm is kind norm",
};

const policyReasonText: Readonly<
  Record<FirewallPolicyError["reason"], string>
> = {
  "not-configured": "the message policy has no english block",
  "invalid-rule": "the update is invalid",
  "fixed-rule":
    "it is a fixed rule of the owner's policy, which policy_update cannot add, remove or replace",
  "build-failed": "the new rules could not be installed",
  "persistence-failed": "the rules could not be stored",
};

const editRefusalDocs =
  "Docs: https://docs.moltzap.xyz/reference/spec/agent/message-policy#editable-english-policy";

/**
 * A failed edit never replaces the active installation or retained editable
 * document. `ruleId` and `path` name the failing rule when the edit had one:
 * `path` is its place in the update, such as `["add", 0]`. `problem` says why
 * an `invalid-rule` edit failed. The message names all three, and never the
 * text of a rejected `BEHAVIOR.md`.
 */
export class FirewallPolicyError extends Data.TaggedError(
  "FirewallPolicyError",
)<{
  readonly ruleId?: string;
  readonly problem?: PolicyProblem;
  readonly path?: readonly [field: "add" | "remove", index: number];
  readonly reason:
    | "not-configured"
    | "invalid-rule"
    | "fixed-rule"
    | "build-failed"
    | "persistence-failed";
}> {
  override get message(): string {
    const subject = editSubject(this.path, this.ruleId);
    const cause =
      this.problem === undefined
        ? policyReasonText[this.reason]
        : policyProblemText[this.problem];
    const text = subject === undefined ? cause : `${subject}: ${cause}`;
    return this.reason === "invalid-rule" || this.reason === "fixed-rule"
      ? `${text}. ${editRefusalDocs}`
      : text;
  }

  /**
   * The fields a refusal's error data carries beside its reason.
   * @returns `ruleId`, `path` and `problem`, each when the refusal has it.
   */
  get data(): Readonly<{
    ruleId?: string;
    path?: readonly [field: "add" | "remove", index: number];
    problem?: PolicyProblem;
  }> {
    return {
      ...(this.ruleId === undefined ? {} : { ruleId: this.ruleId }),
      ...(this.path === undefined ? {} : { path: this.path }),
      ...(this.problem === undefined ? {} : { problem: this.problem }),
    };
  }
}

/**
 * The failing rule as a refusal names it: its place in the update, then its id.
 * @param path The rule's place in the update, when the refusal has one.
 * @param ruleId The rule's id, when the refusal has one.
 * @returns The subject, or undefined when the refusal names neither.
 */
function editSubject(
  path?: FirewallPolicyError["path"],
  ruleId?: string,
): string | undefined {
  const place = path === undefined ? undefined : `${path[0]}[${path[1]}]`;
  const rule = ruleId === undefined ? undefined : `rule ${ruleId}`;
  return place !== undefined && rule !== undefined
    ? `${place} (${rule})`
    : (place ?? rule);
}

/** Owner capabilities are separate from runtime send and inbox authority. */
export interface FirewallPolicyOperations {
  readonly read: () => Effect.Effect<
    typeof policyReadSchema.Type,
    FirewallPolicyError
  >;
  readonly update: (
    request: typeof policyUpdateSchema.Type,
  ) => Effect.Effect<typeof policyUpdateResultSchema.Type, FirewallPolicyError>;
  readonly decisions: (
    request: typeof firewallDecisionsRequestSchema.Type,
  ) => Effect.Effect<typeof firewallDecisionsSchema.Type, FirewallPolicyError>;
}
