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
 * Compliance assesses outgoing drafts against independently settled expectations;
 * incoming peer candidates are assessed without local recipient expectations.
 * The unsettled ones reach the agent as guidance instead. Only a failed
 * expectations stage leaves outgoing compliance unavailable.
 */
const evaluateCompliance = Effect.fn("TextPolicy.compliance")(function* (
  snapshot: TextCheck,
  expectations: PolicyStageTrace,
  provider: DecisionProvider,
  settings: TextPolicySettings,
): Effect.fn.Return<PolicyStageTrace> {
  if (
    snapshot.event.direction === "outgoing" &&
    expectations.status !== "empty" &&
    expectations.status !== "answered"
  ) {
    return {
      stage: "compliance",
      status: "unavailable",
      dependency: "expectations",
      elapsedMilliseconds: 0,
    };
  }
  return yield* runStage(
    makeTextRequest(
      "compliance",
      snapshot,
      settings.maximumRequestBytes,
      snapshot.event.direction === "outgoing" ? readNorms(expectations) : [],
    ),
    provider,
    settings,
  );
});

/**
 * Outgoing expectations use authorized history and facts before compliance
 * assesses the draft against those independently established expectations.
 */
const checkText = Effect.fn("TextPolicy.check")(function* (
  input: MiddlewareInput,
  policy: Pick<TextCheck, "rules" | "revision"> & {
    readonly skipped: readonly PolicyFinding[];
  },
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
  for (const stage of ["applicability", "expectations"] as const) {
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
  if (expectations !== undefined) {
    trace.push(
      yield* evaluateCompliance(check, expectations, provider, settings),
    );
  }
  return {
    findings: [
      ...trace.flatMap((stage) => stageFindings(stage, policy.rules)),
      ...policy.skipped,
    ],
    expectations: norms,
    trace: {
      format: "text-policy/v1",
      data: JSON.stringify({ questionEdition, settings, stages: trace }),
    },
  };
});

const captureTextDocuments = Effect.fn("TextPolicy.captureDocuments")(
  function* (options: {
    readonly id: string;
    readonly rules: readonly TextRule[];
    readonly settings: unknown;
  }) {
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
    return { id, rules, settings, descriptions, revision };
  },
);

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
 *   A --> N[Local response expectations from permitted evidence]
 *   N --> C[Candidate compliance with actor-correct expectations]
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
  const { id, rules, settings, descriptions, revision } =
    yield* captureTextDocuments(options);
  const directions = Object.freeze({
    incoming: forDirection(rules, "incoming"),
    outgoing: forDirection(rules, "outgoing"),
  });
  if (
    !(["incoming", "outgoing"] as const).every((direction) =>
      textPolicyFitsBudget(
        { rules: directions[direction].rules, revision },
        settings.maximumRequestBytes,
        direction,
      ),
    )
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
      checkText(
        input,
        { ...directions[input.event.direction], revision },
        provider,
        settings,
      ),
  });
});

function forDirection(
  rules: readonly TextRule[],
  direction: MiddlewareInput["event"]["direction"],
) {
  return Object.freeze({
    rules: Object.freeze(
      rules.filter(
        (rule) => rule.applies === "both" || rule.applies === direction,
      ),
    ),
    skipped: Object.freeze(
      rules
        .filter((rule) => rule.applies !== "both" && rule.applies !== direction)
        .map(
          (rule): PolicyFinding => ({
            ruleId: rule.id,
            outcome: "not-applicable",
          }),
        ),
    ),
  });
}

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

function stageFindings(
  trace: PolicyStageTrace,
  rules: readonly TextRule[],
): PolicyFinding[] {
  switch (trace.status) {
    case "empty":
      return [];
    case "failed":
    case "unavailable":
      return rules.map((rule) => ({
        ruleId: rule.id,
        outcome: "hold",
        reason:
          trace.status === "failed"
            ? "check-unavailable"
            : "unresolved-evidence",
      }));
    case "answered": {
      const uncertain = new Set(trace.uncertainQuestions);
      return Object.entries(trace.request.questions).map(([id, question]) =>
        questionFinding(
          question,
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
 * Valid unsettled judgments admit with registered advice and preserve the
 * provider's choice and probability. Unsettled references are omitted from
 * response expectations without erasing another stage's settled violation.
 */
function questionFinding(
  question: DecisionRequest["questions"][string],
  uncertain: boolean,
  answer?: DecisionResponse["answers"][string],
): PolicyFinding {
  const { ruleId } = question;
  if (!uncertain) {
    return { ruleId, outcome: answerOutcome(answer?.choice) };
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
    case "violation":
      return "violation";
    default:
      return "pass";
  }
}
