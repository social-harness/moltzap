/**
 * @file How the firewall admits an item the endpoint emitted itself: a
 * collective result, whose answers it checks one by one into a local
 * projection, and an operation failure, admitted without inference.
 */

import { Effect, Array as EffectArray, Schema, Struct } from "effect";
import type { InboundItem } from "../../communication/collectives/inbound.js";
import type { RecordHash } from "../../communication/records/index.js";
import { ResultProvenance } from "../../communication/collectives/index.js";
import {
  renderCollectiveResult,
  renderOutcome,
} from "../../communication/collectives/render.js";
import {
  agentAddressOf,
  type MessageAddressInput,
} from "../../communication/records/values.js";
import {
  decodeRuntimeValue,
  encodeRuntimeValue,
  EndpointStoreError,
  type FirewallEvidence,
  type FirewallEvidenceSlices,
  type FirewallInboxEntry,
  type FirewallLocalAdmission,
  type FirewallRequestAdmission,
  MAXIMUM_RUNTIME_ITEM_BYTES,
} from "../../communication/store/index.js";
import { AgentView, agentViewOf } from "../../identity/cards.js";
import {
  type FirewallCheck,
  firewallCheckSchema,
  type Message,
} from "../evaluator/index.js";
import { ENDPOINT_SENDER, type LocalGuidance } from "../outcome/index.js";
import {
  assess,
  attemptInput,
  captureEnvironment,
  type CheckedMessage,
  contextFrom,
  type DecodedRecord,
  decodeMessage,
  decodeRecord,
  type FirewallEnvironment,
  hashedId,
  messageFields,
  mintCheckId,
  refusalReason,
} from "./firewall-checks.js";
/** The window of a check with no history: a result's missing record, or a failure. */
const EMPTY_WINDOW = {
  pendingOutgoing: false,
  history: [],
  overflow: false,
  earlierHistoryOmitted: false,
} as const;

type ResultItem = Extract<InboundItem, { readonly kind: "collectiveResult" }>;
type FailureItem = Extract<InboundItem, { readonly kind: "operationFailed" }>;

/** One attempt at a queued local item's check. */
interface LocalItemCheck {
  readonly entry: FirewallInboxEntry;
  readonly item: ResultItem | FailureItem;
  readonly terminal: boolean;
}
type WithheldText = Extract<
  ResultItem["question"],
  { readonly kind: "withheld" }
>;

/**
 * Check one local item and build its commit. A failure's text is the
 * endpoint's own, so it is admitted without inference under a deterministic
 * check. A result's shell, its members and their outcomes, is always
 * admitted; each answer but the endpoint's own is checked on its own, from
 * one evidence capture, and the question when the runtime was never shown
 * its request and no check withheld it. An answer or question a check does
 * not admit becomes `withheld` in the projection the runtime reads.
 * @param environment The store, installation and local identity.
 * @param local The queued entry with its provenance, its decoded item, and
 * whether the stale budget is spent, so checks hold without inference.
 * @returns The commit the store applies.
 */
export const checkLocalItem = (
  environment: FirewallEnvironment,
  local: LocalItemCheck,
): Effect.Effect<FirewallLocalAdmission, EndpointStoreError> => {
  const { entry, item, terminal } = local;
  switch (item.kind) {
    case "operationFailed":
      return failureAdmission(environment, entry, item);
    case "collectiveResult":
      return resultAdmission(environment, { entry, item, terminal });
    default: {
      const exhaustive: never = item;
      return exhaustive;
    }
  }
};

/** Only judgment and reason are needed to project a stored check's withheld text. */
const retainedJudgment = Schema.Struct(
  Struct.pick(firewallCheckSchema.fields, "judgment", "reason"),
);

/** One result being admitted, and whether its stale budget is spent. */
interface ResultCheck {
  readonly entry: FirewallInboxEntry;
  readonly item: ResultItem;
  readonly terminal: boolean;
}

/** One answer of a result the firewall checks: its member, its record and its outcome. */
interface CountedAnswer {
  readonly member: AgentView;
  readonly recordHash: RecordHash;
  readonly outcome: ResultItem["outcomes"][number]["outcome"];
}

/** One text of a result the firewall checked, under its certified record. */
interface CheckedText {
  readonly recordHash: RecordHash;
  readonly checked: CheckedMessage;
}

/** One counted answer of a result, checked on its own. */
interface CheckedAnswer extends CheckedText {
  readonly member: AgentView;
}

/** The texts of a result its firewall checks: the counted answers, and maybe the question. */
interface ResultTexts {
  readonly answers: readonly CountedAnswer[];
  readonly question: QuestionAdmission;
}

/** A result's checked answers, and its question when that was checked too. */
interface CheckedResult {
  readonly answers: readonly CheckedAnswer[];
  readonly question?: CheckedText;
}

/**
 * Whether a member's result shows its question: the requester's own, or one
 * the runtime was shown, as it stands; one an enforcing check of its request
 * withheld, withheld under that check; any other, checked with the result.
 */
type QuestionAdmission =
  | { readonly kind: "shown" }
  | { readonly kind: "withheld"; readonly withheld: WithheldText }
  | { readonly kind: "check"; readonly recordHash: RecordHash };

function failureAdmission(
  environment: FirewallEnvironment,
  entry: FirewallInboxEntry,
  item: FailureItem,
) {
  return Effect.gen(function* () {
    const message = yield* localMessage(environment, entry, item.error, {
      kind: "failure",
      id: item.id,
    });
    return {
      queuedItem: entry.canonicalItem,
      item: {
        deliveryToken: entry.deliveryToken,
        canonicalItem: entry.canonicalItem,
      },
      completions: [],
      deterministic: yield* deterministicCheck(environment, entry, message),
      answers: [],
      evidence: yield* localEvidence(item.to, message),
    } satisfies FirewallLocalAdmission;
  }).pipe(Effect.withSpan("failureAdmission"));
}

function resultAdmission(
  environment: FirewallEnvironment,
  result: ResultCheck,
) {
  return Effect.gen(function* () {
    const provenance = yield* decodeRuntimeValue(
      ResultProvenance,
      result.entry.canonicalProvenance ?? new Uint8Array(),
    );
    const question = yield* questionAdmission(environment, provenance.request);
    const checked = yield* checkResultTexts(environment, result, {
      answers: countedAnswers(result.item, provenance.answers),
      question,
    });
    return yield* resultCommit(environment, result, question, checked);
  }).pipe(Effect.withSpan("resultAdmission"));
}

/**
 * Check every counted answer, and the question when it is checked, each
 * against its own window of one evidence capture.
 */
function checkResultTexts(
  environment: FirewallEnvironment,
  result: ResultCheck,
  texts: ResultTexts,
): Effect.Effect<CheckedResult, EndpointStoreError> {
  return Effect.gen(function* () {
    const { answers, question } = texts;
    const captured = yield* environment.store.readFirewallEvidenceSlices({
      ranges: resultRanges(result.item, texts),
      maximumRecords: environment.installed.configuration.maximumHistoryRecords,
    });
    const answerChecks = Effect.forEach(
      answers,
      (answer, index) =>
        checkAnswer(environment, {
          ...result,
          evidence: sliceEvidence(captured, index),
          answer,
        }),
      {
        concurrency:
          environment.installed.configuration.maximumConcurrentChecks,
      },
    );
    if (question.kind !== "check") {
      return { answers: yield* answerChecks };
    }
    const questionCheck = checkRecordText(
      environment,
      { ...result, evidence: sliceEvidence(captured, answers.length) },
      (candidate) => requestMessage(candidate, result.item),
    );
    const [checkedAnswers, checked] = yield* Effect.all(
      [answerChecks, questionCheck],
      { concurrency: 2 },
    );
    return {
      answers: checkedAnswers,
      question: { recordHash: question.recordHash, checked },
    };
  }).pipe(Effect.withSpan("checkResultTexts"));
}

/** The commit of a checked result: its projection, advice, checks and evidence. */
function resultCommit(
  environment: FirewallEnvironment,
  result: ResultCheck,
  question: QuestionAdmission,
  checked: CheckedResult,
): Effect.Effect<FirewallLocalAdmission, EndpointStoreError> {
  return Effect.gen(function* () {
    const { entry, item } = result;
    const projected = projectResult(item, question, checked);
    const completions = [
      ...checked.answers.map((answer) => answer.checked.completion),
      ...(checked.question === undefined
        ? []
        : [checked.question.checked.completion]),
    ];
    const message = yield* localMessage(
      environment,
      entry,
      renderCollectiveResult(projected),
      { kind: "result", op: item.op, id: item.id },
    );
    return {
      queuedItem: entry.canonicalItem,
      item: yield* projectedEntry(entry, projected, resultGuidance(checked)),
      completions,
      ...(completions.length === 0
        ? {
            deterministic: yield* deterministicCheck(
              environment,
              entry,
              message,
            ),
          }
        : {}),
      answers: checked.answers.map((answer) => ({
        recordHash: answer.recordHash,
        admitted:
          answer.checked.completion.admit && quotesRecord(item, answer.member),
      })),
      evidence: yield* localEvidence(item.to, message),
    };
  }).pipe(Effect.withSpan("resultCommit"));
}

/**
 * Whether a member's line of a result quotes its answer post. An `invalid`
 * outcome's line is the validation message instead, so that post's content
 * stays assessor evidence: the runtime was never shown it.
 */
function quotesRecord(item: ResultItem, member: AgentView): boolean {
  return (
    item.outcomes.find((outcome) => outcome.member.agentId === member.agentId)
      ?.outcome.kind !== "invalid"
  );
}

function questionAdmission(
  environment: FirewallEnvironment,
  request?: RecordHash,
): Effect.Effect<QuestionAdmission, EndpointStoreError> {
  if (request === undefined) {
    return Effect.succeed({ kind: "shown" });
  }
  return environment.store.readFirewallRequestAdmission(request).pipe(
    Effect.flatMap(
      (admission): Effect.Effect<QuestionAdmission, EndpointStoreError> => {
        if (admission?.presented === true) {
          return Effect.succeed({ kind: "shown" });
        }
        const enforced =
          environment.installed.configuration.mode === "enforcement";
        return (
          enforced ? withheldBy(admission) : Effect.succeed(undefined)
        ).pipe(
          Effect.map(
            (withheld): QuestionAdmission =>
              withheld === undefined
                ? { kind: "check", recordHash: request }
                : { kind: "withheld", withheld },
          ),
        );
      },
    ),
    Effect.withSpan("questionAdmission"),
  );
}

/** Which records a result's checks read their windows before, and in which conversations. */
function resultRanges(item: ResultItem, texts: ResultTexts) {
  return [
    ...texts.answers.map((answer) => ({
      beforeRecord: answer.recordHash,
      conversation:
        item.op === "gather" ? agentAddressOf(answer.member) : item.to,
    })),
    ...(texts.question.kind === "check"
      ? [{ beforeRecord: texts.question.recordHash, conversation: item.to }]
      : []),
  ];
}

/** Check one counted answer as its line of the result. */
function checkAnswer(
  environment: FirewallEnvironment,
  check: ResultCheck & {
    readonly evidence: FirewallEvidence;
    readonly answer: CountedAnswer;
  },
): Effect.Effect<CheckedAnswer, EndpointStoreError> {
  const { answer } = check;
  return checkRecordText(environment, check, (candidate) =>
    answerMessage(candidate, answer, check.item),
  ).pipe(
    Effect.map((checked) => ({
      member: answer.member,
      recordHash: answer.recordHash,
      checked,
    })),
  );
}

/** The inbox entry of a result's projection, with its advice when it fits the item budget. */
function projectedEntry(
  entry: FirewallInboxEntry,
  projected: ResultItem,
  guidance?: LocalGuidance,
): Effect.Effect<FirewallLocalAdmission["item"], EndpointStoreError> {
  return Effect.gen(function* () {
    const canonicalItem = yield* encodeRuntimeValue(projected);
    const canonicalGuidance =
      guidance === undefined ? undefined : yield* encodeRuntimeValue(guidance);
    const fits =
      canonicalGuidance !== undefined &&
      canonicalItem.byteLength + canonicalGuidance.byteLength <=
        MAXIMUM_RUNTIME_ITEM_BYTES;
    return {
      deliveryToken: entry.deliveryToken,
      canonicalItem,
      ...(fits ? { canonicalGuidance } : {}),
    };
  });
}

/**
 * The withheld value a request's retained check gives, when one ran and its
 * judgment held the request.
 */
function withheldBy(
  admission?: FirewallRequestAdmission,
): Effect.Effect<WithheldText | undefined, EndpointStoreError> {
  const checkId = admission?.checkId;
  const canonicalResult = admission?.canonicalResult;
  if (checkId === undefined || canonicalResult === undefined) {
    return Effect.succeed(undefined);
  }
  return decodeRuntimeValue(retainedJudgment, canonicalResult).pipe(
    Effect.map((result) =>
      result.judgment === "allow"
        ? undefined
        : withheldOf(checkId, result.reason),
    ),
  );
}

/** The answers provenance names, each with its outcome in the result. */
function countedAnswers(
  item: ResultItem,
  answers: ResultProvenance["answers"],
): readonly CountedAnswer[] {
  return answers.flatMap((answer) => {
    const outcome = item.outcomes.find(
      (candidate) => agentAddressOf(candidate.member) === answer.member,
    );
    return outcome === undefined
      ? []
      : [
          {
            member: outcome.member,
            recordHash: answer.recordHash,
            outcome: outcome.outcome,
          },
        ];
  });
}

/** One slice of a capture as the evidence one check reads. */
function sliceEvidence(
  captured: FirewallEvidenceSlices,
  index: number,
): FirewallEvidence {
  return {
    snapshot: captured.snapshot,
    ...(captured.slices[index] ?? EMPTY_WINDOW),
  };
}

/**
 * Check one record's text of a result against its slice of the capture.
 * A slice whose record is missing has no message, and holds unavailable.
 */
function checkRecordText(
  environment: FirewallEnvironment,
  check: ResultCheck & { readonly evidence: FirewallEvidence },
  project: (
    candidate: DecodedRecord,
  ) => Effect.Effect<Message, EndpointStoreError>,
): Effect.Effect<CheckedMessage, EndpointStoreError> {
  return environment.installed.permits.withPermits(1)(
    Effect.gen(function* () {
      const candidate =
        check.evidence.candidate === undefined
          ? undefined
          : yield* decodeRecord(
              check.evidence.candidate,
              environment.localAgentCard.agentId,
            );
      const message =
        candidate === undefined ? undefined : yield* project(candidate);
      return yield* assess(environment, {
        direction: "incoming",
        evidence: check.evidence,
        canonicalCandidate: check.entry.canonicalItem,
        ...(message === undefined ? {} : { message }),
        cards: candidate?.cards ?? [],
        terminal: check.terminal,
      });
    }),
  );
}

/**
 * An answer as the runtime would read it: the member's line of the result,
 * attributed to the record's author after the record is confirmed to be that
 * member's answer to this operation.
 */
function answerMessage(
  candidate: DecodedRecord,
  answer: CountedAnswer,
  item: ResultItem,
): Effect.Effect<Message, EndpointStoreError> {
  const operation = candidate.message.operation;
  return operation?.kind === "answer" &&
    operation.id === item.id &&
    candidate.cards.some(
      (card) =>
        card.agentId === candidate.intent.authorAgentId &&
        Schema.equivalence(AgentView)(AgentView.make(card), answer.member),
    )
    ? decodeMessage({
        ...messageFields(candidate.message),
        text: renderOutcome(answer.outcome),
        operation: { kind: "answer", op: item.op, id: item.id },
      })
    : Effect.fail(new EndpointStoreError({ reason: "corrupt" }));
}

/** A request's question as a member's model would have read it. */
function requestMessage(
  candidate: DecodedRecord,
  item: ResultItem,
): Effect.Effect<Message, EndpointStoreError> {
  const operation = candidate.message.operation;
  return operation?.kind === "request" && operation.id === item.id
    ? Effect.succeed(candidate.message)
    : Effect.fail(new EndpointStoreError({ reason: "corrupt" }));
}

/** The result the runtime reads: every text a check did not admit becomes `withheld`. */
function projectResult(
  item: ResultItem,
  question: QuestionAdmission,
  checked: CheckedResult,
): ResultItem {
  return {
    ...item,
    question: projectedQuestion(item, question, checked.question),
    outcomes: EffectArray.map(item.outcomes, (outcome) =>
      projectedOutcome(outcome, checked.answers),
    ),
  };
}

function projectedQuestion(
  item: ResultItem,
  question: QuestionAdmission,
  checked?: CheckedText,
): ResultItem["question"] {
  switch (question.kind) {
    case "shown":
      return item.question;
    case "withheld":
      return question.withheld;
    case "check":
      return checked === undefined || checked.checked.completion.admit
        ? item.question
        : withheldBecause(checked.checked);
    default: {
      const exhaustive: never = question;
      return exhaustive;
    }
  }
}

function projectedOutcome(
  outcome: ResultItem["outcomes"][number],
  checked: readonly CheckedAnswer[],
): ResultItem["outcomes"][number] {
  const check = checked.find(
    (answer) => answer.member.agentId === outcome.member.agentId,
  );
  return check === undefined || check.checked.completion.admit
    ? outcome
    : { member: outcome.member, outcome: withheldBecause(check.checked) };
}

function withheldBecause(checked: CheckedMessage): WithheldText {
  return withheldOf(checked.completion.checkId, checked.result.reason);
}

function withheldOf(
  checkId: string,
  reason: CheckedMessage["result"]["reason"],
): WithheldText {
  return { kind: "withheld", checkId, reason: refusalReason(reason) };
}

/** Each checked text's advice, keyed by its member; none when no check advised. */
function resultGuidance(checked: CheckedResult): LocalGuidance | undefined {
  const advised = checked.answers.flatMap((answer) =>
    answer.checked.guidance === undefined
      ? []
      : [{ member: answer.member, ...answer.checked.guidance }],
  );
  const questionGuidance = checked.question?.checked.guidance;
  if (advised.length === 0 && questionGuidance === undefined) {
    return undefined;
  }
  return {
    answers: advised,
    ...(questionGuidance === undefined ? {} : { question: questionGuidance }),
  };
}

/**
 * A local item's own text, attributed to the endpoint and shown to the local
 * agent. Its id is the item's delivery, since one operation can end in more
 * than one failure.
 */
function localMessage(
  environment: FirewallEnvironment,
  entry: FirewallInboxEntry,
  text: string,
  operation: NonNullable<Message["operation"]>,
) {
  return decodeMessage({
    id: hashedId(`${ENDPOINT_SENDER}:${entry.deliveryToken}`),
    sender: ENDPOINT_SENDER,
    recipients: [environment.localAgentCard.agentId],
    text,
    operation,
  });
}

/** The runtime-visible evidence a local item leaves in its conversation. */
function localEvidence(conversation: MessageAddressInput, message: Message) {
  return encodeRuntimeValue({
    ...messageFields(message),
    visibility: "runtime",
    admission: "admitted",
  }).pipe(Effect.map((canonicalEntry) => ({ conversation, canonicalEntry })));
}

/**
 * The audit record of an item admitted without inference: its input, with an
 * empty capture, and an allowing result with no middleware checks.
 */
function deterministicCheck(
  liveEnvironment: FirewallEnvironment,
  entry: FirewallInboxEntry,
  message: Message,
) {
  const environment = captureEnvironment(liveEnvironment);
  return Effect.gen(function* () {
    const context = yield* contextFrom(environment, EMPTY_WINDOW, []);
    const allowed: FirewallCheck = {
      judgment: "allow",
      reason: "eligible",
      feedback: [],
      guidance: [],
      checks: [],
    };
    return {
      checkId: mintCheckId(),
      direction: "incoming" as const,
      canonicalCandidate: entry.canonicalItem,
      canonicalInput: yield* attemptInput(environment, {
        context,
        agents: [agentViewOf(environment.localAgentCard)],
        message,
        terminal: false,
      }),
      canonicalResult: yield* encodeRuntimeValue(allowed),
    };
  }).pipe(Effect.withSpan("deterministicCheck"));
}
