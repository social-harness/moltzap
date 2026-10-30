/** @file Collective operations through real Client storage, admission and send preparation. */

import { scopedLive as it } from "@effect/vitest";
import { Deferred, Duration, Effect, Fiber, Queue, Schema } from "effect";
import { describe, expect } from "vitest";
import type { AnswerContent } from "../../communication/collectives/contracts.js";
import type { ResultProvenance } from "../../communication/collectives/index.js";
import type { CertifiedRecord } from "../../communication/records/index.js";
import type { MessageAddressInput } from "../../communication/records/values.js";
import type {
  MessageMiddleware,
  MiddlewareInput,
} from "../evaluator/contract/index.js";
import type { FirewallOptions } from "../policy/installation.js";
import { testAgentView } from "../../__tests__/agent-card-fixtures.js";
import { appendCertifiedMessage } from "../../__tests__/certified-history-fixtures.js";
import { collectiveOperationId } from "../../__tests__/collective-id-fixtures.js";
import { collectiveKey } from "../../__tests__/collective-operation-fixtures.js";
import {
  admitPending,
  answerBob,
  bob,
  carol,
  collectiveContent,
  formSchema,
  gatherRequestContent,
  group,
  holdMarked,
  type IncomingRuntime,
  marker,
  question,
  seedRequest,
  sendInput,
  unfinishedIntents,
} from "../../__tests__/firewall-collective-fixtures.js";
import {
  addConversation,
  auditChecks,
  fixture,
  type Fixture,
  incomingFixture,
  pass,
  policy,
  rule,
  seedIncoming,
  settings,
} from "../../__tests__/firewall-runtime-fixtures.js";
import { bytes } from "../../__tests__/store-schema-fixtures.js";
import {
  type DeliveryToken,
  encodeRuntimeValue,
} from "../../communication/store/index.js";
import { InboundItem } from "../../host-protocol/items.js";
import {
  renderCollectiveRequest,
  renderCollectiveRequestBody,
  renderOutcome,
} from "../../host-protocol/render.js";
import { installEditableFirewall } from "../policy/editable.js";

// @agent-code-guard/regression-only: Exercises collective admission, refusal and evidence through SQLite and the protocol engine.

const resultId = collectiveOperationId(
  testAgentView("agent:alice").agentId,
  30,
);

type ResultItem = Extract<InboundItem, { readonly kind: "collectiveResult" }>;
type FailureItem = Extract<InboundItem, { readonly kind: "operationFailed" }>;
type Outcome = ResultItem["outcomes"][number]["outcome"];

/** The result item alone, so a test reads its outcomes without narrowing. */
const resultItem = Schema.typeSchema(InboundItem).pipe(
  Schema.filter((item): item is ResultItem => item.kind === "collectiveResult"),
);
const failureItem = Schema.typeSchema(InboundItem).pipe(
  Schema.filter((item): item is FailureItem => item.kind === "operationFailed"),
);

/** A policy that asks for a response to every message it sees. */
function adviseEvery() {
  return policy((input) =>
    Effect.succeed({
      findings: pass.findings,
      expectations: [
        {
          ruleId: rule.id,
          expectation: "required" as const,
          subjects: [input.event.message.id],
        },
      ],
    }),
  );
}

/** One value for each member alice's gather `resultId` asks. */
interface PerMember<Value> {
  readonly bob: Value;
  readonly carol: Value;
}

/** A member's accepted answer to alice's gather `resultId`. */
function answerContent(content: object) {
  return collectiveContent({
    kind: "response",
    operationId: resultId,
    action: "accept",
    content,
  });
}

/**
 * Alice's store holds a direct conversation with each of Bob and Carol, each
 * ending in that member's answer to alice's gather `resultId`.
 */
function seedAnswers(subject: Fixture, answers: PerMember<AnswerContent>) {
  return Effect.gen(function* () {
    const bobFirstMessage = yield* seedIncoming(subject, true);
    const bobAnswer = yield* appendCertifiedMessage(
      subject,
      bobFirstMessage,
      yield* answerContent(answers.bob),
    );
    const other = yield* addConversation(subject, true);
    const carolAnswer = yield* appendCertifiedMessage(
      { ...subject, ...other },
      other.record,
      yield* answerContent(answers.carol),
    );
    return provenanceOf({ bob: bobAnswer, carol: carolAnswer });
  });
}

function provenanceOf(records: PerMember<CertifiedRecord>): ResultProvenance {
  return {
    answers: [
      {
        member: bob,
        recordHash: records.bob.actionCertifiedRecord.recordHash,
      },
      {
        member: carol,
        recordHash: records.carol.actionCertifiedRecord.recordHash,
      },
    ],
  };
}

/** Alice's gather to Bob and Carol, as the collective layer emits its result. */
function gatherResult(
  outcomes: PerMember<Outcome>,
  to: MessageAddressInput = group,
): ResultItem {
  return Schema.decodeUnknownSync(resultItem)({
    kind: "collectiveResult",
    closedAt: 0,
    closedBy: "settled",
    op: "gather",
    operationId: resultId,
    to,
    question,
    outcomes: [
      { member: testAgentView(bob), outcome: outcomes.bob },
      { member: testAgentView(carol), outcome: outcomes.carol },
    ],
  });
}

/** Both members' answers as answered outcomes. */
function answered(answers: PerMember<AnswerContent>): PerMember<Outcome> {
  return {
    bob: { kind: "answered", content: answers.bob },
    carol: { kind: "answered", content: answers.carol },
  };
}

/** Queue a local result with its provenance and wait for its admission. */
function admitResult(
  runtime: IncomingRuntime,
  item: InboundItem,
  provenance: ResultProvenance,
) {
  return runtime.delivery
    .queueLocalItem(item, provenance)
    .pipe(Effect.zipRight(admitPending(runtime)));
}

/** The item a read-event returns for one delivery token. */
function readEventItem(runtime: IncomingRuntime, token?: DeliveryToken) {
  return Effect.fromNullable(token).pipe(
    Effect.orDie,
    Effect.flatMap((deliveryToken) =>
      runtime.delivery.operations.readEvent({
        eventId: deliveryToken,
      }),
    ),
    Effect.map((event) => event.item),
  );
}

function withholdsAHeldRequest() {
  return Effect.gen(function* () {
    const subject = yield* fixture;
    yield* seedRequest(subject, Date.now() + 60_000, `${marker} ${question}`);
    const runtime = yield* incomingFixture(subject, holdMarked(), {}, false);
    yield* admitPending(runtime);

    const refusal = yield* Effect.flip(
      runtime.delivery.operations.send({ input: answerBob({ slot: "mon" }) }),
    );

    expect(runtime.published).toEqual([]);
    expect((yield* runtime.delivery.operations.readInbox({})).items).toEqual(
      [],
    );
    expect(refusal).toMatchObject({ failure: { kind: "request-none" } });
    expect(yield* unfinishedIntents(subject)).toEqual([]);
  });
}

function showsAHeldRequestInGuidanceMode() {
  return Effect.gen(function* () {
    const subject = yield* fixture;
    yield* seedRequest(subject, Date.now() + 60_000, `${marker} ${question}`);
    const runtime = yield* incomingFixture(
      subject,
      holdMarked(),
      { mode: "guidance" },
      false,
    );
    yield* admitPending(runtime);

    const answering = yield* runtime.delivery.operations
      .send({ input: answerBob({ slot: "mon" }) })
      .pipe(Effect.forkScoped);
    yield* Deferred.await(subject.outbound);

    expect(runtime.published.map((event) => event.item)).toMatchObject([
      { kind: "collectiveRequest", from: testAgentView(bob), to: bob },
    ]);
    expect(yield* unfinishedIntents(subject)).toHaveLength(1);
    yield* Fiber.interrupt(answering);
  });
}

/** The one request the subscription delivered. */
function deliveredRequest(runtime: IncomingRuntime) {
  const [delivered] = runtime.published;
  return delivered?.item.kind === "collectiveRequest"
    ? Effect.succeed(delivered.item)
    : Effect.dieMessage("expected the delivered request");
}

function checksARequestAsItsQuestion() {
  return Effect.gen(function* () {
    const subject = yield* fixture;
    const deadlineAt = Date.now() + 60_000;
    const firstMessage = yield* seedIncoming(subject, true);
    yield* appendCertifiedMessage(subject, firstMessage, [
      ...(yield* gatherRequestContent(deadlineAt, question)),
      { type: "data", value: { agenda: ["mon", "tue"] } },
    ]);
    const seen: MiddlewareInput[] = [];
    const runtime = yield* incomingFixture(
      subject,
      holdMarked(seen),
      {},
      false,
    );
    yield* admitPending(runtime);

    const message = yield* Effect.fromNullable(seen[0]?.event.message);
    const delivered = yield* deliveredRequest(runtime);
    const modelText = renderCollectiveRequest(delivered, question);
    expect(message.text).toBe(renderCollectiveRequestBody(delivered));
    expect(modelText.startsWith(`${message.text}\n`)).toBe(true);
    expect(message.operation).toEqual({
      kind: "request",
      op: "gather",
      operationId: collectiveOperationId(testAgentView(bob).agentId),
      deadlineAt,
    });
    expect(seen[0]?.context.now).toEqual(expect.any(Number));
    expect((yield* auditChecks(subject))[0]?.input.message).toMatchObject({
      sender: subject.remote.card.agentId,
    });
  });
}

function withholdsARequestThatExpiresDuringItsCheck() {
  return Effect.gen(function* () {
    const subject = yield* fixture;
    const deadlineAt = Date.now() + 3_000;
    yield* seedRequest(subject, deadlineAt, question);
    const slow = policy(() =>
      Effect.sleep(
        Duration.millis(Math.max(0, deadlineAt - Date.now()) + 50),
      ).pipe(Effect.as(pass)),
    );
    const runtime = yield* incomingFixture(subject, slow, {}, false);
    yield* admitPending(runtime);

    expect(runtime.published).toEqual([]);
    expect(yield* auditChecks(subject)).toMatchObject([
      { disposition: "withheld", result: { judgment: "allow" } },
    ]);
  });
}

function withholdsOneAnswerFromEveryRuntimeRead() {
  return Effect.gen(function* () {
    const subject = yield* fixture;
    const answers = {
      bob: { slot: "mon", note: marker },
      carol: { slot: "tue" },
    };
    const provenance = yield* seedAnswers(subject, answers);
    const runtime = yield* incomingFixture(subject, holdMarked(), {}, false);
    const result = gatherResult(answered(answers));
    yield* admitResult(runtime, result, provenance);

    const checks = yield* auditChecks(subject);
    const bobCheck = checks.find(
      (check) => check.input.message?.sender === subject.remote.card.agentId,
    );
    const [, carolOutcome] = result.outcomes;
    const projected = {
      ...result,
      outcomes: [
        {
          member: testAgentView(bob),
          outcome: {
            kind: "withheld",
            checkId: bobCheck?.checkId,
            reason: "rule-violation",
          },
        },
        carolOutcome,
      ],
    };
    const inbox = yield* runtime.delivery.operations.readInbox({});
    const webhook = yield* runtime.delivery.eventStore.readInbox();
    const canonical = yield* encodeRuntimeValue(result);
    expect(inbox.items.map((entry) => entry.item)).toEqual([projected]);
    expect(runtime.published.map((event) => event.item)).toEqual([projected]);
    expect(
      yield* readEventItem(runtime, inbox.items[0]?.deliveryToken),
    ).toEqual(projected);
    expect(webhook.items.map((entry) => entry.canonicalItem)).toEqual([
      yield* encodeRuntimeValue(projected),
    ]);
    expect(checks.map((check) => check.candidate)).toEqual([
      canonical,
      canonical,
    ]);
  });
}

function scopesUnresolvedEvidenceToTheMembersAnswer() {
  return Effect.gen(function* () {
    const subject = yield* fixture;
    const answers = { bob: { slot: "mon" }, carol: { slot: "tue" } };
    const provenance = yield* seedAnswers(subject, answers);
    yield* subject.store.bindMessageIntent({
      kind: "existing-conversation",
      intent: {
        conversationId: subject.membership.descriptor.conversationId,
        membershipHash: subject.membership.hash,
        authorAgentId: subject.local.card.agentId,
        msgId: "msg_unresolved",
        canonicalIntent: bytes("pending send to Bob"),
      },
    });
    const seen: MiddlewareInput[] = [];
    const runtime = yield* incomingFixture(
      subject,
      holdMarked(seen),
      {},
      false,
    );
    yield* admitResult(runtime, gatherResult(answered(answers)), provenance);

    expect(
      (yield* runtime.delivery.operations.readInbox({})).items[0]?.item,
    ).toMatchObject({
      outcomes: [
        {
          member: testAgentView(bob),
          outcome: { kind: "withheld", reason: "unresolved-evidence" },
        },
        {
          member: testAgentView(carol),
          outcome: { kind: "answered", content: answers.carol },
        },
      ],
    });
    expect(yield* auditChecks(subject)).toMatchObject([
      { disposition: "withheld", result: { reason: "unresolved-evidence" } },
      { disposition: "admitted", result: { reason: "eligible" } },
    ]);
    const inputFrom = (sender: string) =>
      seen.find((input) => input.event.message.sender === sender);
    expect(inputFrom(subject.third.card.agentId)?.context.gaps).toEqual([]);
    expect(inputFrom(subject.remote.card.agentId)?.context.gaps).toEqual([
      "An earlier outgoing intent has not reached certified completion.",
    ]);
  });
}

function checksAnInvalidAnswerAsItsLine() {
  return Effect.gen(function* () {
    const subject = yield* fixture;
    const provenance = yield* seedAnswers(subject, {
      bob: { slot: "mon" },
      carol: { slot: "sun" },
    });
    const seen: MiddlewareInput[] = [];
    const runtime = yield* incomingFixture(
      subject,
      holdMarked(seen),
      {},
      false,
    );
    const outcomes = {
      bob: { kind: "answered", content: { slot: "mon" } },
      carol: { kind: "invalid", reason: `slot: ${marker} is not an option` },
    } as const;
    yield* admitResult(runtime, gatherResult(outcomes), provenance);

    const texts = seen.map((input) => input.event.message.text);
    expect(texts).toHaveLength(2);
    expect(texts).toEqual(
      expect.arrayContaining([
        renderOutcome(outcomes.bob),
        renderOutcome(outcomes.carol),
      ]),
    );
    expect(seen.map((input) => input.event.message.operation)).toEqual([
      { kind: "answer", op: "gather", operationId: resultId },
      { kind: "answer", op: "gather", operationId: resultId },
    ]);
    expect(
      (yield* runtime.delivery.operations.readInbox({})).items[0]?.item,
    ).toMatchObject({
      outcomes: [
        { outcome: { kind: "answered" } },
        { outcome: { kind: "withheld", reason: "rule-violation" } },
      ],
    });
  });
}

function showsEveryAnswerWithItsAdvice() {
  return Effect.gen(function* () {
    const subject = yield* fixture;
    const answers = { bob: { slot: "mon" }, carol: { slot: "tue" } };
    const provenance = yield* seedAnswers(subject, answers);
    const runtime = yield* incomingFixture(
      subject,
      adviseEvery(),
      { mode: "guidance" },
      false,
    );
    const result = gatherResult(answered(answers));
    yield* admitResult(runtime, result, provenance);

    const [delivered] = (yield* runtime.delivery.operations.readInbox({}))
      .items;
    expect(delivered?.item).toEqual(result);
    expect(delivered?.guidance).toMatchObject({
      answers: [
        {
          member: testAgentView(bob),
          instructions: [{ instruction: rule.guidance }],
          subjects: [{ sender: testAgentView(bob) }],
        },
        {
          member: testAgentView(carol),
          instructions: [{ instruction: rule.guidance }],
          subjects: [{ sender: testAgentView(carol) }],
        },
      ],
    });
  });
}

function admitsAFailureWithoutInference() {
  return Effect.gen(function* () {
    const subject = yield* fixture;
    const firstMessage = yield* seedIncoming(subject, true);
    yield* appendCertifiedMessage(subject, firstMessage, question);
    const runtime = yield* incomingFixture(
      subject,
      policy(() => Effect.dieMessage("a failure is never inferred")),
      {},
      false,
    );
    yield* admitPending(runtime);
    const failure = Schema.decodeUnknownSync(failureItem)({
      kind: "operationFailed",
      operationId: resultId,
      to: group,
      error: "all_gather failed: the result could not be shared",
    });

    yield* runtime.delivery.queueLocalItem(failure);
    yield* admitPending(runtime);

    const inbox = yield* runtime.delivery.operations.readInbox({});
    const failureChecks = (yield* auditChecks(subject)).filter(
      (check) => check.input.message?.operation?.kind === "failure",
    );
    expect(inbox.items.map((entry) => entry.item)).toContainEqual(failure);
    expect(failureChecks).toMatchObject([
      {
        disposition: "admitted",
        result: { judgment: "allow", checks: [] },
        input: { message: { text: failure.error } },
      },
    ]);
  });
}

function leavesTheResultInLaterEvidence() {
  return Effect.gen(function* () {
    const subject = yield* fixture;
    const secret = `${marker} private detail`;
    const answers = {
      bob: { slot: "mon", note: secret },
      carol: { slot: "tue" },
    };
    const provenance = yield* seedAnswers(subject, answers);
    const seen: MiddlewareInput[] = [];
    const runtime = yield* incomingFixture(
      subject,
      holdMarked(seen),
      {},
      false,
    );
    yield* admitResult(
      runtime,
      gatherResult(answered(answers), bob),
      provenance,
    );

    const sending = yield* runtime.delivery.operations
      .send({ input: sendInput({ to: bob, text: question }) })
      .pipe(Effect.forkScoped);
    yield* Deferred.await(subject.outbound);
    yield* Fiber.interrupt(sending);

    const history = seen.at(-1)?.context.history ?? [];
    expect(history.at(-2)).toMatchObject({
      sender: subject.remote.card.agentId,
      operation: { kind: "answer", operationId: resultId },
      visibility: "assessor",
      admission: "withheld",
    });
    expect(history.at(-1)).toMatchObject({
      sender: "sharness",
      operation: { kind: "result", op: "gather", operationId: resultId },
      visibility: "runtime",
      admission: "admitted",
    });
    expect(history.at(-1)?.text).not.toContain(secret);
    expect(seen[0]?.event.message.text).toContain(secret);
  });
}

/**
 * A request whose deadline lies past the last instant a date can represent,
 * as a hostile peer could message it, then a plain message after it.
 */
function seedUnrenderableRequest(subject: Fixture) {
  return Effect.gen(function* () {
    const firstMessage = yield* seedIncoming(subject, true);
    const hostile = yield* appendCertifiedMessage(subject, firstMessage, [
      { type: "text", text: question },
      {
        type: "data",
        value: {
          [collectiveKey]: {
            kind: "operation",
            op: "gather",
            operationId: collectiveOperationId(testAgentView(bob).agentId),
            deadlineAt: 9_000_000_000_000_000,
            requestedSchema: formSchema,
          },
        },
      },
    ]);
    return yield* appendCertifiedMessage(subject, hostile, "A later message");
  }).pipe(Effect.withSpan("seedUnrenderableRequest"));
}

function checksPastAnUnrenderableDeadline() {
  return Effect.gen(function* () {
    const subject = yield* fixture;
    yield* seedUnrenderableRequest(subject);
    const seen: MiddlewareInput[] = [];
    const runtime = yield* incomingFixture(
      subject,
      holdMarked(seen),
      {},
      false,
    );
    yield* admitPending(runtime);

    expect(runtime.published.map((event) => event.item)).toMatchObject([
      {
        kind: "multicast",
        message: { content: [{ text: "A later message" }] },
      },
    ]);
    expect(seen.at(-1)?.context.history.at(-1)).toMatchObject({
      visibility: "assessor",
    });
    expect(seen.at(-1)?.context.history.at(-1)?.operation).toBeUndefined();
  });
}

function retiresARequestThatExpiresBeforeItsCheck() {
  return Effect.gen(function* () {
    const subject = yield* fixture;
    const deadlineAt = Date.now() + 3_000;
    const firstMessage = yield* seedIncoming(subject, true);
    const earlier = yield* appendCertifiedMessage(
      subject,
      firstMessage,
      "Earlier",
    );
    yield* appendCertifiedMessage(
      subject,
      earlier,
      yield* gatherRequestContent(deadlineAt, question),
    );
    const runtime = yield* incomingFixture(
      subject,
      policy((input) =>
        input.event.message.operation === undefined
          ? Effect.sleep(
              Duration.millis(Math.max(0, deadlineAt - Date.now()) + 50),
            ).pipe(Effect.as(pass))
          : Effect.dieMessage("a request past its deadline is never checked"),
      ),
      {},
      false,
    );
    yield* admitPending(runtime);
    yield* Queue.take(runtime.completed);

    const refusal = yield* Effect.flip(
      runtime.delivery.operations.send({ input: answerBob({ slot: "mon" }) }),
    );

    expect(runtime.published.map((event) => event.item.kind)).toEqual([
      "multicast",
    ]);
    expect(yield* auditChecks(subject)).toHaveLength(1);
    expect(refusal).toMatchObject({ failure: { kind: "request-none" } });
  });
}

/**
 * Bob's request reaches alice's runtime neither shown nor held: its check
 * allows it but outlasts its deadline. A result naming it then follows.
 */
function questionCheckedWithResult(
  mode: FirewallOptions["mode"],
  middleware: (seen: MiddlewareInput[]) => MessageMiddleware,
) {
  return Effect.gen(function* () {
    const subject = yield* fixture;
    const deadlineAt = Date.now() + 3_000;
    const text = `${marker} ${question}`;
    const request = yield* seedRequest(subject, deadlineAt, text);
    const seen: MiddlewareInput[] = [];
    const checked = middleware(seen);
    const runtime = yield* incomingFixture(
      subject,
      policy((input) =>
        seen.length === 0
          ? Effect.sleep(
              Duration.millis(Math.max(0, deadlineAt - Date.now()) + 50),
            ).pipe(
              Effect.zipRight(Effect.sync(() => seen.push(input))),
              Effect.as(pass),
            )
          : checked.check(input),
      ),
      { mode },
      false,
    );
    yield* admitPending(runtime);
    const result = Schema.decodeUnknownSync(resultItem)({
      kind: "collectiveResult",
      closedAt: 0,
      closedBy: "settled",
      op: "all_gather",
      operationId: collectiveOperationId(testAgentView(bob).agentId),
      to: bob,
      question: text,
      outcomes: [
        { member: testAgentView(bob), outcome: { kind: "no-answer" } },
      ],
    });
    yield* admitResult(runtime, result, {
      answers: [],
      request: request.actionCertifiedRecord.recordHash,
    });
    return {
      seen,
      delivery: (yield* runtime.delivery.operations.readInbox({})).items[0],
    };
  });
}

function withholdsAQuestionCheckedWithItsResult() {
  return Effect.gen(function* () {
    const { seen, delivery } = yield* questionCheckedWithResult(
      "enforcement",
      holdMarked,
    );

    expect(seen.at(-1)?.event.message.operation).toMatchObject({
      kind: "request",
      op: "gather",
    });
    expect(delivery?.item).toMatchObject({
      question: { kind: "withheld", reason: "rule-violation" },
    });
  });
}

function advisesOnAQuestionCheckedWithItsResult() {
  return Effect.gen(function* () {
    const { delivery } = yield* questionCheckedWithResult("guidance", () =>
      adviseEvery(),
    );

    expect(delivery?.item).toMatchObject({ question: `${marker} ${question}` });
    expect(delivery?.guidance).toMatchObject({
      answers: [],
      question: { instructions: [{ instruction: rule.guidance }] },
    });
  });
}

function admitsAResultWithNoAnswerWithoutInference() {
  return Effect.gen(function* () {
    const subject = yield* fixture;
    yield* seedEarlierMessage(subject);
    const runtime = yield* incomingFixture(
      subject,
      policy((input) =>
        input.event.message.operation === undefined
          ? Effect.succeed(pass)
          : Effect.dieMessage("a result without answers is never inferred"),
      ),
      {},
      false,
    );
    yield* admitPending(runtime);
    const result = gatherResult({
      bob: { kind: "no-answer" },
      carol: { kind: "no-answer" },
    });

    yield* admitResult(runtime, result, { answers: [] });

    expect(runtime.published.map((event) => event.item)).toContainEqual(result);
    expect(
      (yield* auditChecks(subject)).filter(
        (check) => check.input.message?.operation?.kind === "result",
      ),
    ).toMatchObject([{ disposition: "admitted", result: { checks: [] } }]);
  });
}

function keepsAnInvalidAnswerFromLaterRuntimeHistory() {
  return Effect.gen(function* () {
    const subject = yield* fixture;
    const provenance = yield* seedAnswers(subject, {
      bob: { slot: "wed", note: "outside the form" },
      carol: { slot: "tue" },
    });
    const seen: MiddlewareInput[] = [];
    const runtime = yield* incomingFixture(
      subject,
      holdMarked(seen),
      {},
      false,
    );
    yield* admitResult(
      runtime,
      gatherResult(
        {
          bob: { kind: "invalid", reason: "slot: wed is not an option" },
          carol: { kind: "answered", content: { slot: "tue" } },
        },
        bob,
      ),
      provenance,
    );

    const sending = yield* runtime.delivery.operations
      .send({ input: sendInput({ to: bob, text: question }) })
      .pipe(Effect.forkScoped);
    yield* Deferred.await(subject.outbound);
    yield* Fiber.interrupt(sending);

    expect(seen.at(-1)?.context.history.at(-2)).toMatchObject({
      operation: { kind: "answer", operationId: resultId },
      visibility: "assessor",
    });
  });
}

/** Alice's direct conversation with Bob, ending in one plain message from Bob. */
function seedEarlierMessage(subject: Fixture) {
  return seedIncoming(subject, true).pipe(
    Effect.flatMap((firstMessage) =>
      appendCertifiedMessage(subject, firstMessage, "An earlier message"),
    ),
  );
}

/** An all_gather of alice's that failed, as the collective layer emits it. */
function allGatherFailure(error: string) {
  return Schema.decodeUnknownSync(failureItem)({
    kind: "operationFailed",
    operationId: resultId,
    to: bob,
    error,
  });
}

function namesNoPeerForAFailureInTheDecisionsFeed() {
  return Effect.gen(function* () {
    const subject = yield* fixture;
    yield* seedEarlierMessage(subject);
    const runtime = yield* incomingFixture(subject, holdMarked(), {}, false);
    yield* admitPending(runtime);
    yield* runtime.delivery.queueLocalItem(allGatherFailure("failed"));
    yield* admitPending(runtime);
    const editable = yield* installEditableFirewall(
      {
        incoming: [holdMarked()],
        outgoing: [holdMarked()],
        settings,
        facts: [],
        codeDigest: "a".repeat(64),
        mode: "enforcement",
      },
      subject.store,
    );

    const feed = yield* editable.policy.decisions({});

    expect(feed.decisions).toMatchObject([
      { direction: "incoming", peer: null, disposition: "admitted" },
      {
        direction: "incoming",
        peer: testAgentView("agent:bob"),
        disposition: "admitted",
      },
    ]);
  });
}

function keepsTwoFailuresOfOneOperationApart() {
  return Effect.gen(function* () {
    const subject = yield* fixture;
    yield* seedEarlierMessage(subject);
    const seen: MiddlewareInput[] = [];
    const runtime = yield* incomingFixture(
      subject,
      holdMarked(seen),
      {},
      false,
    );
    yield* admitPending(runtime);
    yield* runtime.delivery.queueLocalItem(allGatherFailure("first refusal"));
    yield* admitPending(runtime);
    yield* runtime.delivery.queueLocalItem(allGatherFailure("second refusal"));
    yield* admitPending(runtime);

    const sending = yield* runtime.delivery.operations
      .send({ input: sendInput({ to: bob, text: question }) })
      .pipe(Effect.forkScoped);
    yield* Deferred.await(subject.outbound);
    yield* Fiber.interrupt(sending);

    const failures = (seen.at(-1)?.context.history ?? []).filter(
      (entry) => entry.operation?.kind === "failure",
    );
    expect(failures.map((entry) => entry.text)).toEqual([
      "first refusal",
      "second refusal",
    ]);
    expect(new Set(failures.map((entry) => entry.id)).size).toBe(2);
  });
}

describe("received requests under a firewall", () => {
  it(
    "withholds a request an enforcing check holds, so it cannot be answered",
    withholdsAHeldRequest,
  );
  it(
    "shows a held request in guidance mode, answerable",
    showsAHeldRequestInGuidanceMode,
  );
  it(
    "checks a request as exactly the question a model reads, before its answer instructions and without its data parts",
    checksARequestAsItsQuestion,
  );
  it(
    "does not present a request whose deadline passes while it is checked",
    withholdsARequestThatExpiresDuringItsCheck,
  );
  it(
    "retires a request whose deadline passes before its check starts, without checking it",
    retiresARequestThatExpiresBeforeItsCheck,
  );
  it(
    "checks later messages past a request whose deadline no date can represent",
    checksPastAnUnrenderableDeadline,
  );
});

describe("collective results under a firewall", () => {
  it(
    "withholds one answer from every runtime read while the result's other answers stay",
    withholdsOneAnswerFromEveryRuntimeRead,
  );
  it(
    "scopes unresolved-send evidence to the member whose answer shares the conversation",
    scopesUnresolvedEvidenceToTheMembersAnswer,
  );
  it(
    "checks an invalid answer's peer-controlled reason as the line a model reads",
    checksAnInvalidAnswerAsItsLine,
  );
  it(
    "shows every answer in guidance mode, each with its own advice",
    showsEveryAnswerWithItsAdvice,
  );
  it(
    "leaves the shown result and its answers' admission in later evidence",
    leavesTheResultInLaterEvidence,
  );
  it(
    "withholds a question the runtime was never shown when its check with the result holds it",
    withholdsAQuestionCheckedWithItsResult,
  );
  it(
    "attaches advice to a question checked with its result in guidance mode",
    advisesOnAQuestionCheckedWithItsResult,
  );
  it(
    "admits a result with no counted answer under one deterministic audit record",
    admitsAResultWithNoAnswerWithoutInference,
  );
  it(
    "keeps an invalid answer's message content out of later runtime-visible history",
    keepsAnInvalidAnswerFromLaterRuntimeHistory,
  );
});

describe("collective operation failures under a firewall", () => {
  it(
    "admits an operation failure without inference under one deterministic audit record",
    admitsAFailureWithoutInference,
  );
  it(
    "names no peer for the endpoint's own failure in the owner's decisions feed",
    namesNoPeerForAFailureInTheDecisionsFeed,
  );
  it(
    "keeps two failures of one operation apart in later evidence",
    keepsTwoFailuresOfOneOperationApart,
  );
});
