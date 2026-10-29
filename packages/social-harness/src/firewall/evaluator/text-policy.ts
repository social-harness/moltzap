/** @file Natural-language policies implement the same atomic middleware contract as code. */

import { Clock, Effect, Either, Schema } from "effect";
import { createHash } from "node:crypto";
import {
  captureResult,
  CheckInputError,
  type DecisionProvider,
  DecisionProviderError,
  type DecisionRequest,
  DecisionResponse,
  decodeFrozen,
  type MessageMiddleware,
  type MiddlewareInput,
  type MiddlewareResult,
  NormExpectation,
  type PolicyFinding,
  type PolicyStageTrace,
  RuleDescription,
  type TextCheck,
  TextPolicySettings,
  TextRule,
} from "./contract/index.js";
import {
  makeTextRequest,
  questionEdition,
  textPolicyFitsBudget,
} from "./questions.js";

const decideWithinBudget = Effect.fn("TextPolicy.decideWithinBudget")(
  function* (
    request: DecisionRequest,
    provider: DecisionProvider,
    settings: TextPolicySettings,
  ) {
    const received = yield* provider.decide(request).pipe(
      Effect.timeoutFail({
        duration: settings.timeoutMilliseconds,
        onTimeout: () => new DecisionProviderError({ reason: "timeout" }),
      }),
    );
    const response = yield* Schema.decodeUnknown(DecisionResponse)(
      received,
    ).pipe(
      Effect.flatMap(Schema.encode(Schema.parseJson(DecisionResponse))),
      Effect.flatMap(Schema.decode(Schema.parseJson(DecisionResponse))),
      Effect.catchTag("ParseError", () =>
        Effect.fail(new DecisionProviderError({ reason: "invalid-response" })),
      ),
    );
    if (!validAnswers(request, response)) {
      return yield* new DecisionProviderError({
        reason: "invalid-response",
        response: response.raw,
        accounting: {
          provider: response.provider,
          model: response.model,
          usage: response.usage,
        },
      });
    }
    return response;
  },
);

/**
 * Each answer must give a probability to exactly its question's choices, sum
 * to one, and state a choice that no other option exceeds, within
 * a provider probability tolerance of 0.02. The policy routes by the stated choice, and a
 * stated choice that trails another option is unsettled.
 */
function validAnswers(
  request: DecisionRequest,
  response: DecisionResponse,
): boolean {
  const questions = Object.entries(request.questions);
  if (questions.length !== Object.keys(response.answers).length) {
    return false;
  }
  return questions.every(([id, question]) => {
    const answer = response.answers[id];
    if (answer === undefined) {
      return false;
    }
    const choices = Object.keys(question.criteria);
    const probabilities = Object.values(answer.probabilities);
    const selected = answer.probabilities[answer.choice];
    if (
      selected === undefined ||
      !choices.includes(answer.choice) ||
      choices.length !== probabilities.length
    ) {
      return false;
    }
    const tolerance = 0.02 + Number.EPSILON * probabilities.length;
    return (
      choices.every((choice) => Object.hasOwn(answer.probabilities, choice)) &&
      probabilities.every((value) => value - selected <= tolerance) &&
      Math.abs(probabilities.reduce((sum, value) => sum + value, 0) - 1) <=
        tolerance
    );
  });
}

const runStage = Effect.fn("TextPolicy.runStage")(function* (
  preparation: ReturnType<typeof makeTextRequest>,
  provider: DecisionProvider,
  settings: TextPolicySettings,
): Effect.fn.Return<PolicyStageTrace> {
  if ("status" in preparation) {
    return preparation;
  }
  const request = preparation;
  if (Object.keys(request.questions).length === 0) {
    return { stage: request.stage, status: "empty", elapsedMilliseconds: 0 };
  }
  const started = yield* Clock.currentTimeMillis;
  const response = yield* captureResult(
    decideWithinBudget(request, provider, settings),
    () => new DecisionProviderError({ reason: "defect" }),
  );
  const finished = yield* Clock.currentTimeMillis;
  const base = {
    stage: request.stage,
    request,
    elapsedMilliseconds: finished - started,
  };
  return Either.match(response, {
    onLeft: (failure): PolicyStageTrace => ({
      ...base,
      status: "failed",
      failure,
    }),
    onRight: (value): PolicyStageTrace => ({
      ...base,
      status: "answered",
      response: value,
      uncertainQuestions: Object.entries(value.answers).flatMap(
        ([id, answer]) =>
          unsettled(answer, settings.minimumProbability) ? [id] : [],
      ),
    }),
  });
});

/**
 * The decision provider did not settle an answer that is `unresolved`, below the routing
 * threshold, or a rounded near-tie whose stated choice trails another option.
 */
function unsettled(
  answer: DecisionResponse["answers"][string],
  minimumProbability: number,
): boolean {
  const selected = answer.probabilities[answer.choice] ?? 0;
  return (
    answer.choice === "unresolved" ||
    selected < minimumProbability ||
    Object.values(answer.probabilities).some((value) => value > selected)
  );
}

/**
 * Conformance assesses the draft against the expectations the decision
 * provider settled;
 * the unsettled ones reach the agent as guidance instead. Only a failed
 * expectations stage leaves conformance unavailable.
 */
const evaluateConformance = Effect.fn("TextPolicy.conformance")(function* (
  snapshot: TextCheck,
  expectations: PolicyStageTrace,
  provider: DecisionProvider,
  settings: TextPolicySettings,
): Effect.fn.Return<PolicyStageTrace> {
  if (expectations.status !== "empty" && expectations.status !== "answered") {
    return {
      stage: "conformance",
      status: "unavailable",
      dependency: "expectations",
      elapsedMilliseconds: 0,
    };
  }
  return yield* runStage(
    makeTextRequest(
      "conformance",
      snapshot,
      settings.maximumRequestBytes,
      readNorms(expectations),
    ),
    provider,
    settings,
  );
});

/**
 * Outgoing expectations use authorized history and facts before conformance
 * assesses the draft against those independently established expectations.
 */
const checkText = Effect.fn("TextPolicy.check")(function* (
  input: MiddlewareInput,
  policy: Pick<TextCheck, "rules" | "revision">,
  provider: DecisionProvider,
  settings: TextPolicySettings,
): Effect.fn.Return<MiddlewareResult> {
  const check: TextCheck = {
    event: input.event,
    context: input.context,
    rules: policy.rules,
    revision: policy.revision,
  };
  const trace: PolicyStageTrace[] = [];
  for (const stage of ["applicability", "safety", "expectations"] as const) {
    trace.push(
      yield* runStage(
        makeTextRequest(stage, check, settings.maximumRequestBytes),
        provider,
        settings,
      ),
    );
  }
  const expectations = trace.find((entry) => entry.stage === "expectations");
  const norms = expectations === undefined ? [] : readNorms(expectations);
  if (check.event.direction === "outgoing" && expectations !== undefined) {
    trace.push(
      yield* evaluateConformance(check, expectations, provider, settings),
    );
  }
  return {
    findings: trace.flatMap((stage) => stageFindings(stage, policy.rules)),
    expectations: norms,
    trace: {
      format: "text-policy/v1",
      data: JSON.stringify({ questionEdition, settings, stages: trace }),
    },
  };
});

/**
 * Freezes natural-language documents and provider settings for repeated checks in either
 * direction. Question semantics and documents determine the recorded revision.
 * Registration fails if the catalog, required state structure and mandatory
 * questions exceed the request budget at their schema minimums.
 * `fixedRuleIds` names the rules composition fixed against owner edits; it is
 * recorded in the provenance only, so a retained check keeps which of its
 * rules were fixed, and never changes checking.
 *
 * ```mermaid
 * flowchart TD
 *   I[Original message and context] --> A[Applicability]
 *   A --> S[Personal trust]
 *   S --> N[Norm expectations from permitted evidence]
 *   N --> C[Outgoing conformance against the settled expectations]
 *   C --> R[Return all findings and private stage trace]
 * ```
 */
export const makeTextPolicy = Effect.fn("makeTextPolicy")(function* (options: {
  readonly id: string;
  readonly rules: readonly TextRule[];
  readonly provider: DecisionProvider;
  readonly settings: unknown;
  readonly fixedRuleIds?: readonly string[];
  readonly runtimeRuleIds?: readonly string[];
}): Effect.fn.Return<MessageMiddleware, CheckInputError> {
  const settings = yield* decodeFrozen(
    TextPolicySettings,
    options.settings,
  ).pipe(
    Effect.catchTag("ParseError", () =>
      Effect.fail(new CheckInputError({ reason: "settings" })),
    ),
  );
  const { id, rules } = yield* decodeFrozen(
    Schema.Struct({
      id: Schema.NonEmptyTrimmedString,
      rules: Schema.NonEmptyArray(TextRule),
    }),
    { id: options.id, rules: options.rules },
  ).pipe(
    Effect.catchTag("ParseError", () =>
      Effect.fail(new CheckInputError({ reason: "registration" })),
    ),
  );
  if (new Set(rules.map((rule) => rule.id)).size !== rules.length) {
    return yield* new CheckInputError({ reason: "registration" });
  }
  const descriptions = yield* ruleDescriptions(rules);
  const revision = textRevision(rules, settings);
  if (
    !textPolicyFitsBudget({ rules, revision }, settings.maximumRequestBytes)
  ) {
    return yield* new CheckInputError({ reason: "registration" });
  }
  const provider = Object.freeze({
    decide: options.provider.decide.bind(options.provider),
  });
  return Object.freeze({
    id,
    revision,
    rules: descriptions,
    provenance: textProvenance(rules, settings, options.provider, options),
    check: (input: MiddlewareInput) =>
      checkText(input, { rules, revision }, provider, settings),
  });
});

function ruleDescriptions(rules: readonly TextRule[]) {
  return Schema.decodeUnknown(Schema.Array(RuleDescription))(rules).pipe(
    Effect.flatMap((value) =>
      decodeFrozen(Schema.Array(RuleDescription), value),
    ),
    Effect.catchTag("ParseError", () =>
      Effect.fail(new CheckInputError({ reason: "registration" })),
    ),
  );
}

/** The provenance format every natural-language policy registers, naming its checks as natural-language judgments. */
export const textPolicyFormat = "org.social-harness/text-policy.v1";

function textProvenance(
  rules: readonly TextRule[],
  settings: TextPolicySettings,
  provider: DecisionProvider,
  ownership: {
    readonly fixedRuleIds?: readonly string[];
    readonly runtimeRuleIds?: readonly string[];
  },
) {
  return Object.freeze({
    format: textPolicyFormat,
    data: JSON.stringify({
      questionEdition,
      rules,
      settings,
      provider: provider.provenance ?? null,
      fixedRuleIds: [...(ownership.fixedRuleIds ?? [])],
      runtimeRuleIds: [...(ownership.runtimeRuleIds ?? [])],
    }),
  });
}

function textRevision(
  rules: readonly TextRule[],
  settings: TextPolicySettings,
): string {
  return createHash("sha256")
    .update(JSON.stringify({ questionEdition, rules, settings }))
    .digest("hex");
}

/**
 * The expectations the decision provider settled, each with the references it settled
 * as relevant. An unsettled expectation reaches the agent as guidance
 * instead, and an unsettled reference is left out.
 */
function readNorms(trace: PolicyStageTrace): readonly NormExpectation[] {
  if (trace.status !== "answered") {
    return [];
  }
  const uncertain = new Set(trace.uncertainQuestions);
  const settled = (id: string) => !uncertain.has(id);
  const subjects = new Map<string, string[]>();
  Object.entries(trace.request.questions).forEach(([id, question]) => {
    if (
      question.purpose === "subject" &&
      question.subject !== undefined &&
      settled(id) &&
      trace.response.answers[id]?.choice === "relevant"
    ) {
      const references = subjects.get(question.ruleId) ?? [];
      references.push(question.subject);
      subjects.set(question.ruleId, references);
    }
  });
  return Object.entries(trace.request.questions).flatMap(([id, question]) => {
    const expectation = trace.response.answers[id]?.choice;
    if (
      question.purpose !== "assessment" ||
      !settled(id) ||
      !Schema.is(NormExpectation.fields.expectation)(expectation)
    ) {
      return [];
    }
    return [
      {
        ruleId: question.ruleId,
        expectation,
        subjects: subjects.get(question.ruleId) ?? [],
      },
    ];
  });
}

function stageIncludes(
  rule: TextRule,
  stage: PolicyStageTrace["stage"],
): boolean {
  if (stage === "applicability" || rule.kind === stage) {
    return true;
  }
  return (
    rule.kind === "norm" &&
    (stage === "expectations" || stage === "conformance")
  );
}

function stageFindings(
  trace: PolicyStageTrace,
  rules: readonly TextRule[],
): PolicyFinding[] {
  switch (trace.status) {
    case "empty":
      return [];
    case "failed":
    case "unavailable":
      return rules
        .filter((rule) => stageIncludes(rule, trace.stage))
        .map((rule) => ({
          ruleId: rule.id,
          outcome: "hold",
          reason:
            trace.status === "failed"
              ? "check-unavailable"
              : "unresolved-evidence",
        }));
    case "answered": {
      const uncertain = new Set(trace.uncertainQuestions);
      const norms = new Set(
        rules.filter((rule) => rule.kind === "norm").map((rule) => rule.id),
      );
      return Object.entries(trace.request.questions).map(([id, question]) =>
        questionFinding(
          question,
          norms.has(question.ruleId),
          uncertain.has(id),
          trace.response.answers[id],
        ),
      );
    }
    default:
      return trace satisfies never;
  }
}

/**
 * One answered question's finding. An unsettled answer about a safety
 * rule holds. One about a norm never holds: its applicability,
 * expectation or conformance passes with the decision provider's choice and
 * probability, so the norm is still assessed and the agent advised, and an unsettled
 * reference only drops out of its expectation.
 */
function questionFinding(
  question: DecisionRequest["questions"][string],
  norm: boolean,
  uncertain: boolean,
  answer?: DecisionResponse["answers"][string],
): PolicyFinding {
  const { ruleId } = question;
  if (!uncertain) {
    return { ruleId, outcome: answerOutcome(answer?.choice) };
  }
  if (!norm) {
    return { ruleId, outcome: "hold", reason: "unresolved-evidence" };
  }
  if (question.purpose === "subject" || answer === undefined) {
    return { ruleId, outcome: "pass" };
  }
  return {
    ruleId,
    outcome: "pass",
    reason: "uncertain",
    choice: answer.choice,
    probability: answer.probabilities[answer.choice] ?? 0,
  };
}

function answerOutcome(
  choice?: string,
): Exclude<PolicyFinding["outcome"], "hold"> {
  switch (choice) {
    case undefined:
      return "pass";
    case "prohibited":
      return "block";
    case "violation":
      return "revise";
    default:
      return "pass";
  }
}
