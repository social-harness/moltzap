/** @file Pins how the collective layer runs an all_gather at its requester and members. */

import * as NodeSdk from "@effect/opentelemetry/NodeSdk";
import { live as it, scoped as itOnTestClock } from "@effect/vitest";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import {
  Deferred,
  Duration,
  Effect,
  Fiber,
  Option,
  Schema,
  Supervisor,
  TestClock,
} from "effect";
import { describe, expect } from "vitest";
import type { TestCollectiveOperations as CollectiveOperations } from "../../__tests__/collective-send.js";
import type { InboundItem } from "../../host-protocol/items.js";
import type { EngineSendInput } from "../conversations/index.js";
import { testAgentView } from "../../__tests__/agent-card-fixtures.js";
import { collectiveOperationId } from "../../__tests__/collective-id-fixtures.js";
import {
  alice,
  certifyNext,
  collectiveFailureOf,
  collectiveKey,
  firstRequestOf,
  makeLayer,
  msgId,
  newObserved,
  type Observed,
  operationIdOf,
  questionText,
  recordHashOf,
  requestSendWait,
  send,
  slotSchema,
  unkeptEmit,
} from "../../__tests__/collective-operation-fixtures.js";
import { SendError } from "../conversations/errors.js";
import { InboundMessage } from "../conversations/message.js";
import { CollectiveEmitError } from "./contracts.js";
import { collectiveRequesterOf, readCollectiveValue } from "./wire/index.js";

const group = "group:alice,bob,carol";
const groupMembers = ["agent:alice", "agent:bob", "agent:carol"];
const requestId = collectiveOperationId(testAgentView(alice).agentId);
const otherId = collectiveOperationId(testAgentView(alice).agentId, 1);

/**
 * An emit port that records each item and resolves `emitted` on the first,
 * so a test can wait for an item a forked fiber emits, such as the
 * requester's result once its close is certified.
 */
const signalEmitted = (
  observed: Observed,
  emitted: Deferred.Deferred<undefined>,
) => ({
  emit: (item: InboundItem) =>
    Effect.sync(() => {
      observed.emitted.push(item);
    }).pipe(
      Effect.zipRight(Deferred.succeed(emitted, undefined)),
      Effect.asVoid,
    ),
});

/**
 * A send port that resolves `attempted` when a message reaches it and certifies
 * the message only once `certified` resolves, so a test can deliver a close
 * while the member's own answer is in flight.
 */
const holdMessages = (
  observed: Observed,
  attempted: Deferred.Deferred<undefined>,
  certified: Deferred.Deferred<undefined>,
) => ({
  sendMessage: (input: EngineSendInput) =>
    Deferred.succeed(attempted, undefined).pipe(
      Effect.zipRight(Deferred.await(certified)),
      Effect.zipRight(certifyNext(observed, input)),
    ),
});

const requestValue = {
  kind: "operation",
  op: "all_gather",
  operationId: requestId,
  deadlineAt: 60_000,
  requestedSchema: slotSchema,
};

const groupMessage = (sender: string, byte: number, value: object) =>
  Schema.decodeUnknownSync(InboundMessage)({
    kind: "group",
    msgId: msgId(byte),
    address: group,
    sender: testAgentView(sender),
    members: groupMembers.map(testAgentView),
    content: [
      ...("op" in value && value.op === "all_gather"
        ? [{ type: "text", text: questionText }]
        : []),
      { type: "data", value: { [collectiveKey]: value } },
    ],
  });

const classify = (
  layer: CollectiveOperations,
  sender: string,
  byte: number,
  value: object,
) =>
  layer.classify({
    message: groupMessage(sender, byte, value),
    recordHash: recordHashOf(byte),
  });

const answer = (operationId: string, slot: string) => ({
  kind: "response",
  operationId,
  action: "accept",
  content: { slot },
});

const close = (operationId: string, included: readonly number[]) => ({
  kind: "close",
  closedAt: 60_000,
  closedBy: "deadline",
  operationId,
  included: included.map(recordHashOf),
});

const allGatherInput = (to = group) => ({
  to,
  text: questionText,
  collective: { op: "all_gather", deadline: 60, requestedSchema: slotSchema },
});

/** Start the all_gather `allGatherInput` describes and return its operationId; dies when the send names none. */
const startAllGather = (layer: CollectiveOperations) =>
  send(layer, allGatherInput()).pipe(Effect.flatMap(operationIdOf));

const respond = (layer: CollectiveOperations, slot: string) =>
  send(layer, {
    to: group,
    collectiveResponse: {
      operationId: requestId,
      action: "accept",
      content: { slot },
    },
  });

function sendsOneRequestMessageToTheGroup() {
  const observed = newObserved();

  return Effect.gen(function* () {
    const layer = yield* makeLayer(observed);
    const operationId = yield* startAllGather(layer);
    const request = yield* firstRequestOf(observed);

    expect(request.operationId).toBe(operationId);
    expect(collectiveRequesterOf(operationId)).toBe(
      testAgentView(alice).agentId,
    );
    expect(observed.sent).toEqual([
      {
        to: group,
        content: [
          { type: "text", text: questionText },
          {
            type: "data",
            value: {
              [collectiveKey]: {
                kind: "operation",
                op: "all_gather",
                operationId,
                deadlineAt: 60_000,
                requestedSchema: slotSchema,
              },
            },
          },
        ],
      },
    ]);
  });
}

function refusesAnAllGatherToAnAgentAddress() {
  const observed = newObserved();

  return Effect.gen(function* () {
    const layer = yield* makeLayer(observed);
    const failure = yield* collectiveFailureOf(
      send(layer, allGatherInput("agent:bob")),
    );

    expect(failure).toMatchObject({ reason: "membership-invalid" });
  });
}

function namesEveryMemberWithTheMessageReasonWhenTheGroupMessageIsRefused() {
  const observed = newObserved();

  return Effect.gen(function* () {
    const layer = yield* makeLayer(observed, {
      sendMessage: () =>
        Effect.fail(new SendError({ reason: "network-unavailable" })),
    });
    const failure = yield* collectiveFailureOf(send(layer, allGatherInput()));

    expect(failure).toEqual({
      kind: "members-unreachable",
      members: [
        { member: "agent:bob", reason: "network-unavailable" },
        { member: "agent:carol", reason: "network-unavailable" },
      ],
    });
  });
}

/**
 * A group message that failed after it was queued still reaches the group, so
 * the refusal says so for every member rather than that it was not sent.
 */
function saysEveryMemberIsStillSentAQueuedGroupMessage() {
  return Effect.gen(function* () {
    const layer = yield* makeLayer(newObserved(), {
      sendMessage: () =>
        Effect.fail(new SendError({ reason: "delivery-pending" })),
    });
    const refusal = yield* Effect.flip(send(layer, allGatherInput()));

    expect(refusal).toEqual(new SendError({ reason: "delivery-pending" }));
  });
}

function refusesAnAllGatherWithAnUnknownMemberBeforeSending() {
  const observed = newObserved();

  return Effect.gen(function* () {
    const messages = { attempted: 0 };
    const layer = yield* makeLayer(observed, {
      unknown: ["agent:carol"],
      sendMessage: (input) => {
        messages.attempted += 1;
        return certifyNext(observed, input);
      },
    });
    const failure = yield* collectiveFailureOf(send(layer, allGatherInput()));

    expect(failure).toEqual({
      kind: "members-unreachable",
      members: [{ member: "agent:carol", reason: "unknown-agent" }],
    });
    expect(messages.attempted).toBe(0);
  });
}

function namesEveryMemberWhenTheGroupMessageIsNotCertifiedInTime() {
  const observed = newObserved();

  return Effect.gen(function* () {
    const layer = yield* makeLayer(observed, {
      sendMessage: () => Effect.never,
    });
    const sending = yield* Effect.fork(
      collectiveFailureOf(send(layer, allGatherInput())),
    );
    yield* TestClock.adjust(requestSendWait);

    expect(yield* Fiber.join(sending)).toEqual(
      new SendError({ reason: "delivery-pending" }),
    );
  });
}

/**
 * Runs on the live clock. The one-second deadline lies within the send's
 * wait, so the wait ends at the deadline; the deadline timer is scheduled just
 * before the group message's wait, so it fires first. Effect's TestClock wakes
 * sleeps due at one instant newest first, so under it the wait fires first and
 * the send is refused. The test waits on the result's emission, not on a fixed
 * delay.
 */
function endsInItsResultAloneWhenTheDeadlinePassesBeforeTheGroupMessageCertifies() {
  const observed = newObserved();

  return Effect.gen(function* () {
    const emitted = yield* Deferred.make<undefined>();
    const bound: EngineSendInput[] = [];
    const layer = yield* makeLayer(observed, {
      ...signalEmitted(observed, emitted),
      sendMessage: recordUncertifiedRequest(bound, observed),
    });
    const completed = yield* Effect.flip(
      send(layer, {
        ...allGatherInput(),
        collective: {
          op: "all_gather",
          deadline: 1,
          requestedSchema: slotSchema,
        },
      }),
    );
    yield* Deferred.await(emitted);

    expect(bound.map(({ to }) => to)).toEqual([group]);
    expect(completed).toEqual(new SendError({ reason: "delivery-pending" }));
    expect(observed.emitted).toMatchObject([
      { kind: "collectiveResult", to: group },
    ]);
  }).pipe(Effect.scoped);
}

function recordUncertifiedRequest(
  bound: EngineSendInput[],
  observed: Observed,
) {
  return (input: EngineSendInput) =>
    readCollectiveValue(input.content).pipe(
      Effect.orDie,
      Effect.flatMap((value) => {
        if (Option.isSome(value) && value.value.kind === "operation") {
          bound.push(input);
          return Effect.never;
        }
        return certifyNext(observed, input);
      }),
    );
}

function closesWithTheRecordHashOfEachCountedAnswer() {
  const observed = newObserved();

  return Effect.gen(function* () {
    const emitted = yield* Deferred.make<undefined>();
    const layer = yield* makeLayer(observed, signalEmitted(observed, emitted));
    const operationId = yield* startAllGather(layer);
    yield* classify(layer, "agent:bob", 11, answer(operationId, "mon"));
    yield* classify(layer, "agent:bob", 12, answer(operationId, "tue"));
    yield* classify(layer, "agent:carol", 13, answer(operationId, "tue"));
    yield* Deferred.await(emitted);

    expect(observed.sent[1]).toEqual({
      to: group,
      content: [
        {
          type: "data",
          value: {
            [collectiveKey]: {
              kind: "close",
              closedAt: 0,
              closedBy: "settled",
              operationId,
              included: [recordHashOf(11), recordHashOf(13)],
            },
          },
        },
      ],
    });
  });
}

function publishesTheRequesterResultOnceItsCloseIsCertified() {
  const observed = newObserved();

  return Effect.gen(function* () {
    const emitted = yield* Deferred.make<undefined>();
    const layer = yield* makeLayer(observed, signalEmitted(observed, emitted));
    const operationId = yield* startAllGather(layer);
    yield* classify(layer, "agent:bob", 11, answer(operationId, "mon"));
    yield* classify(layer, "agent:carol", 13, answer(operationId, "tue"));
    yield* Deferred.await(emitted);

    expect(observed.emitted).toEqual([
      {
        kind: "collectiveResult",
        closedAt: 0,
        closedBy: "settled",
        op: "all_gather",
        operationId,
        to: group,
        question: questionText,
        outcomes: [
          {
            member: testAgentView("agent:bob"),
            outcome: { kind: "answered", content: { slot: "mon" } },
          },
          {
            member: testAgentView("agent:carol"),
            outcome: { kind: "answered", content: { slot: "tue" } },
          },
        ],
      },
    ]);
  });
}

function closesAtTheDeadlineWithoutTheSilentMember() {
  const observed = newObserved();

  return Effect.gen(function* () {
    const emitted = yield* Deferred.make<undefined>();
    const layer = yield* makeLayer(observed, signalEmitted(observed, emitted));
    const operationId = yield* startAllGather(layer);
    yield* classify(layer, "agent:bob", 11, answer(operationId, "mon"));
    yield* TestClock.adjust(Duration.seconds(60));
    yield* Deferred.await(emitted);

    expect(observed.emitted).toMatchObject([
      {
        closedAt: 60_000,
        closedBy: "deadline",
        outcomes: [
          { member: testAgentView("agent:bob"), outcome: { kind: "answered" } },
          {
            member: testAgentView("agent:carol"),
            outcome: { kind: "no-answer" },
          },
        ],
      },
    ]);
    expect(observed.sent[1]?.content).toMatchObject([
      {
        value: {
          [collectiveKey]: {
            included: [recordHashOf(11)],
            closedAt: 60_000,
            closedBy: "deadline",
          },
        },
      },
    ]);
  });
}

function ignoresAnAnswerThatArrivesAfterTheClose() {
  const observed = newObserved();

  return Effect.gen(function* () {
    const emitted = yield* Deferred.make<undefined>();
    const supervisor = yield* Supervisor.track;
    const layer = yield* makeLayer(observed, signalEmitted(observed, emitted));
    const operationId = yield* startAllGather(layer);
    yield* TestClock.adjust(Duration.seconds(60));
    yield* Deferred.await(emitted);
    const late = yield* classify(
      layer,
      "agent:carol",
      13,
      answer(operationId, "tue"),
    ).pipe(Effect.supervised(supervisor));

    expect(late).toEqual(Option.none());
    expect(yield* supervisor.value).toEqual([]);
    expect(observed.sent).toHaveLength(2);
    expect(observed.emitted).toHaveLength(1);
  });
}

function reportsACloseThatCannotBeCertifiedAsAFailedOperation() {
  const observed = newObserved();
  const exporter = new InMemorySpanExporter();
  const closed = () =>
    exporter
      .getFinishedSpans()
      .filter((span) => span.name === "collective.closed")
      .map((span) => span.attributes);

  return Effect.gen(function* () {
    const emitted = yield* Deferred.make<undefined>();
    const layer = yield* makeLayer(observed, {
      ...signalEmitted(observed, emitted),
      sendMessage: (input) =>
        observed.sent.length === 0
          ? certifyNext(observed, input)
          : Effect.fail(new SendError({ reason: "network-unavailable" })),
    });
    const operationId = yield* startAllGather(layer);
    yield* TestClock.adjust(Duration.seconds(60));
    yield* Deferred.await(emitted);

    expect(observed.emitted).toEqual([
      {
        kind: "operationFailed",
        operationId,
        to: group,
        error:
          "all_gather failed: the result could not be shared with the group: Social Harness is unavailable (network unavailable)",
      },
    ]);
    yield* Effect.repeat(Effect.yieldNow(), {
      until: () => closed().length > 0,
    });
    expect(closed()).toMatchObject([{ operationId, outcome: "failed" }]);
  }).pipe(
    Effect.provide(
      NodeSdk.layer(() => ({
        spanProcessor: new SimpleSpanProcessor(exporter),
      })),
    ),
  );
}

/** Pending close certification cannot publish a terminal failure. */
function keepsAQueuedClosePending() {
  const observed = newObserved();
  return Effect.gen(function* () {
    const attempted = yield* Deferred.make<undefined>();
    const layer = yield* makeLayer(observed, {
      sendMessage: (input) =>
        observed.sent.length === 0
          ? certifyNext(observed, input)
          : Deferred.succeed(attempted, undefined).pipe(
              Effect.zipRight(
                Effect.fail(new SendError({ reason: "delivery-pending" })),
              ),
            ),
    });
    yield* startAllGather(layer);
    yield* TestClock.adjust(Duration.seconds(60));
    yield* Deferred.await(attempted);
    yield* TestClock.adjust(Duration.hours(2));
    expect(observed.emitted).toEqual([]);
  });
}

function deliversAGroupRequestAsAnItemAddressedToTheGroup() {
  return Effect.gen(function* () {
    const layer = yield* makeLayer(newObserved(), { self: "agent:bob" });
    const item = yield* classify(layer, "agent:alice", 10, requestValue);

    expect(item).toEqual(
      Option.some({
        kind: "collectiveRequest",
        op: "all_gather",
        operationId: requestId,
        msgId: msgId(10),
        from: testAgentView("agent:alice"),
        to: group,
        question: questionText,
        requestedSchema: slotSchema,
        deadlineAt: 60_000,
      }),
    );
  });
}

function consumesAGroupRequestWhoseIdDoesNotDeriveFromItsSender() {
  return Effect.gen(function* () {
    const layer = yield* makeLayer(newObserved(), { self: "agent:bob" });
    const item = yield* classify(layer, "agent:carol", 10, requestValue);

    expect(item).toEqual(Option.none());
  });
}

function consumesASecondRequestMessageThatReusesAHeldId() {
  const observed = newObserved();

  return Effect.gen(function* () {
    const layer = yield* makeLayer(observed, { self: "agent:bob" });
    yield* classify(layer, "agent:alice", 10, requestValue);
    const reused = yield* layer.classify({
      message: Schema.decodeUnknownSync(InboundMessage)({
        kind: "direct",
        msgId: msgId(20),
        address: "agent:alice",
        sender: testAgentView("agent:alice"),
        content: [
          { type: "text", text: "Private question?" },
          {
            type: "data",
            value: { [collectiveKey]: { ...requestValue, op: "gather" } },
          },
        ],
      }),
      recordHash: recordHashOf(20),
    });
    const redelivered = yield* classify(layer, "agent:alice", 10, requestValue);

    expect(reused).toEqual(Option.none());
    expect(redelivered).toMatchObject(Option.some({ to: group }));
  });
}

function keepsARequestFirstSeenAfterItsDeadlineForTheClose() {
  const observed = newObserved();

  return Effect.gen(function* () {
    const layer = yield* makeLayer(observed, { self: "agent:bob" });
    yield* TestClock.adjust(Duration.seconds(60));
    const item = yield* classify(layer, "agent:alice", 10, requestValue);
    yield* classify(layer, "agent:carol", 13, answer(requestId, "tue"));
    yield* classify(layer, "agent:alice", 14, close(requestId, [13]));
    const failure = yield* collectiveFailureOf(respond(layer, "mon"));

    expect(item).toEqual(Option.none());
    expect(failure).toEqual({ kind: "request-expired" });
    expect(observed.emitted).toMatchObject([
      {
        outcomes: [
          {
            member: testAgentView("agent:bob"),
            outcome: { kind: "no-answer" },
          },
          {
            member: testAgentView("agent:carol"),
            outcome: { kind: "answered" },
          },
        ],
      },
    ]);
  });
}

function sendsAMemberAnswerToTheGroup() {
  const observed = newObserved();

  return Effect.gen(function* () {
    const layer = yield* makeLayer(observed, { self: "agent:bob" });
    yield* classify(layer, "agent:alice", 10, requestValue);
    yield* respond(layer, "mon");

    expect(observed.sent.map((message) => message.to)).toEqual([group]);
  });
}

function consumesAPeerAnswerWithoutPublishingIt() {
  const observed = newObserved();

  return Effect.gen(function* () {
    const layer = yield* makeLayer(observed, { self: "agent:bob" });
    yield* classify(layer, "agent:alice", 10, requestValue);
    const item = yield* classify(
      layer,
      "agent:carol",
      13,
      answer(requestId, "tue"),
    );

    expect(item).toEqual(Option.none());
    expect(observed.emitted).toEqual([]);
  });
}

function buildsTheMemberResultFromExactlyTheListedAnswers() {
  const observed = newObserved();

  return Effect.gen(function* () {
    const layer = yield* makeLayer(observed, { self: "agent:bob" });
    yield* classify(layer, "agent:alice", 10, requestValue);
    yield* respond(layer, "mon");
    yield* classify(layer, "agent:carol", 13, answer(requestId, "tue"));
    yield* classify(layer, "agent:alice", 14, close(requestId, [101]));

    expect(observed.emitted).toEqual([
      {
        kind: "collectiveResult",
        closedAt: 60_000,
        closedBy: "deadline",
        op: "all_gather",
        operationId: requestId,
        to: group,
        question: questionText,
        outcomes: [
          {
            member: testAgentView("agent:bob"),
            outcome: { kind: "answered", content: { slot: "mon" } },
          },
          {
            member: testAgentView("agent:carol"),
            outcome: { kind: "no-answer" },
          },
        ],
      },
    ]);
  });
}

function includesAListedPeerAnswerInTheMemberResult() {
  const observed = newObserved();

  return Effect.gen(function* () {
    const layer = yield* makeLayer(observed, { self: "agent:bob" });
    yield* classify(layer, "agent:alice", 10, requestValue);
    yield* classify(layer, "agent:carol", 13, answer(requestId, "tue"));
    yield* classify(layer, "agent:alice", 14, close(requestId, [13]));

    expect(observed.emitted).toMatchObject([
      {
        outcomes: [
          {
            member: testAgentView("agent:bob"),
            outcome: { kind: "no-answer" },
          },
          {
            member: testAgentView("agent:carol"),
            outcome: { kind: "answered", content: { slot: "tue" } },
          },
        ],
      },
    ]);
  });
}

function holdsACloseUntilTheMemberOwnAnswerIsCertified() {
  const observed = newObserved();

  return Effect.gen(function* () {
    const attempted = yield* Deferred.make<undefined>();
    const certified = yield* Deferred.make<undefined>();
    const layer = yield* makeLayer(observed, {
      self: "agent:bob",
      ...holdMessages(observed, attempted, certified),
    });
    yield* classify(layer, "agent:alice", 10, requestValue);
    const answering = yield* Effect.fork(respond(layer, "mon"));
    yield* Deferred.await(attempted);
    yield* classify(layer, "agent:alice", 14, close(requestId, [101]));
    const emittedBeforeCertification = [...observed.emitted];
    yield* Deferred.succeed(certified, undefined);
    yield* Fiber.join(answering);

    expect(emittedBeforeCertification).toEqual([]);
    expect(observed.emitted).toMatchObject([
      {
        outcomes: [
          { member: testAgentView("agent:bob"), outcome: { kind: "answered" } },
          {
            member: testAgentView("agent:carol"),
            outcome: { kind: "no-answer" },
          },
        ],
      },
    ]);
  });
}

/**
 * A close whose member result cannot be kept fails its classification, so
 * the pass classifying it ends instead of waiting.
 */
function failsACloseWhoseMemberResultCannotBeKept() {
  return Effect.gen(function* () {
    const layer = yield* makeLayer(newObserved(), {
      self: "agent:bob",
      emit: unkeptEmit,
    });
    yield* classify(layer, "agent:alice", 10, requestValue);
    const failure = yield* Effect.flip(
      classify(layer, "agent:alice", 14, close(requestId, [])),
    );

    expect(failure).toEqual(new CollectiveEmitError());
  });
}

/**
 * A member answer that releases a held close whose result cannot be kept
 * still returns its certified answer message, since that message exists.
 */
function keepsAnAnswerThatReleasesAnUnkeptClose() {
  const observed = newObserved();

  return Effect.gen(function* () {
    const attempted = yield* Deferred.make<undefined>();
    const certified = yield* Deferred.make<undefined>();
    const layer = yield* makeLayer(observed, {
      self: "agent:bob",
      emit: unkeptEmit,
      ...holdMessages(observed, attempted, certified),
    });
    yield* classify(layer, "agent:alice", 10, requestValue);
    const answering = yield* Effect.fork(respond(layer, "mon"));
    yield* Deferred.await(attempted);
    yield* classify(layer, "agent:alice", 14, close(requestId, [101]));
    yield* Deferred.succeed(certified, undefined);

    const outcome = yield* Fiber.join(answering);

    expect(outcome.operationId).toBe(requestId);
    expect(outcome.msgIds).toHaveLength(1);
  });
}

function excludesAPeerAnswerThatArrivesAfterTheClose() {
  const observed = newObserved();

  return Effect.gen(function* () {
    const layer = yield* makeLayer(observed, { self: "agent:bob" });
    yield* classify(layer, "agent:alice", 10, requestValue);
    yield* classify(layer, "agent:alice", 14, close(requestId, []));
    yield* classify(layer, "agent:carol", 15, answer(requestId, "tue"));
    yield* classify(layer, "agent:alice", 14, close(requestId, []));

    expect(observed.emitted).toMatchObject([
      {
        outcomes: [
          {
            member: testAgentView("agent:bob"),
            outcome: { kind: "no-answer" },
          },
          {
            member: testAgentView("agent:carol"),
            outcome: { kind: "no-answer" },
          },
        ],
      },
    ]);
  });
}

function refusesAMemberAnswerAfterTheClose() {
  return Effect.gen(function* () {
    const layer = yield* makeLayer(newObserved(), { self: "agent:bob" });
    yield* classify(layer, "agent:alice", 10, requestValue);
    yield* classify(layer, "agent:alice", 14, close(requestId, []));
    const failure = yield* collectiveFailureOf(respond(layer, "mon"));

    expect(failure).toEqual({ kind: "request-expired" });
  });
}

function ignoresACloseFromAMemberOtherThanTheRequester() {
  const observed = newObserved();

  return Effect.gen(function* () {
    const layer = yield* makeLayer(observed, { self: "agent:bob" });
    yield* classify(layer, "agent:alice", 10, requestValue);
    const item = yield* classify(
      layer,
      "agent:carol",
      14,
      close(requestId, []),
    );

    expect(item).toEqual(Option.none());
    expect(observed.emitted).toEqual([]);
  });
}

function keepsItsResultWhenItsOwnAnswerSettlesAfterTheClose() {
  const observed = newObserved();

  return Effect.gen(function* () {
    const attempted = yield* Deferred.make<undefined>();
    const certified = yield* Deferred.make<undefined>();
    const layer = yield* makeLayer(observed, {
      self: "agent:bob",
      ...holdMessages(observed, attempted, certified),
    });
    yield* classify(layer, "agent:alice", 10, requestValue);
    const answering = yield* Effect.fork(respond(layer, "mon"));
    yield* Deferred.await(attempted);
    yield* classify(layer, "agent:alice", 14, close(requestId, []));
    yield* Deferred.succeed(certified, undefined);
    yield* Fiber.join(answering);
    yield* classify(layer, "agent:alice", 14, close(requestId, []));
    const failure = yield* collectiveFailureOf(respond(layer, "tue"));

    expect(observed.emitted).toHaveLength(1);
    expect(failure).toEqual({ kind: "request-expired" });
  });
}

function appliesOnlyTheFirstCloseWhileItsOwnAnswerIsInFlight() {
  const observed = newObserved();

  return Effect.gen(function* () {
    const attempted = yield* Deferred.make<undefined>();
    const certified = yield* Deferred.make<undefined>();
    const layer = yield* makeLayer(observed, {
      self: "agent:bob",
      ...holdMessages(observed, attempted, certified),
    });
    yield* classify(layer, "agent:alice", 10, requestValue);
    const answering = yield* Effect.fork(respond(layer, "mon"));
    yield* Deferred.await(attempted);
    yield* classify(layer, "agent:alice", 14, close(requestId, [101]));
    yield* classify(layer, "agent:alice", 15, close(requestId, []));
    yield* Deferred.succeed(certified, undefined);
    yield* Fiber.join(answering);

    expect(observed.emitted).toMatchObject([
      {
        outcomes: [
          { member: testAgentView("agent:bob"), outcome: { kind: "answered" } },
          {
            member: testAgentView("agent:carol"),
            outcome: { kind: "no-answer" },
          },
        ],
      },
    ]);
  });
}

function ignoresACloseForAnUnknownId() {
  const observed = newObserved();

  return Effect.gen(function* () {
    const layer = yield* makeLayer(observed, { self: "agent:bob" });
    yield* classify(layer, "agent:alice", 10, requestValue);
    const item = yield* classify(layer, "agent:alice", 14, close(otherId, []));

    expect(item).toEqual(Option.none());
    expect(observed.emitted).toEqual([]);
  });
}

/**
 * An admitted answer whose message fails after binding settles unanswered with
 * applying the close held while it was in flight: that close
 * lists the answer this member will not hold, so it ends the request
 * without a result.
 */
function appliesAHeldCloseWhenAnAdmittedAnswerFailsAfterBinding() {
  const observed = newObserved();

  return Effect.gen(function* () {
    const attempted = yield* Deferred.make<undefined>();
    const failing = yield* Deferred.make<undefined>();
    const layer = yield* makeLayer(observed, {
      self: "agent:bob",
      sendMessage: (input) =>
        Deferred.succeed(attempted, undefined).pipe(
          Effect.zipRight(Deferred.await(failing)),
          Effect.zipRight(
            Effect.fail(new SendError({ reason: "delivery-pending" })),
          ),
          Effect.zipLeft(Effect.sync(() => observed.sent.push(input))),
        ),
    });
    yield* classify(layer, "agent:alice", 10, requestValue);
    const answering = yield* Effect.fork(
      send(layer, {
        to: group,
        collectiveResponse: {
          operationId: requestId,
          action: "accept",
          content: { slot: "mon" },
        },
      }),
    );
    yield* Deferred.await(attempted);
    yield* classify(layer, "agent:alice", 14, close(requestId, [101]));
    yield* Deferred.succeed(failing, undefined);
    const failure = yield* Effect.flip(Fiber.join(answering));
    const again = yield* collectiveFailureOf(respond(layer, "tue"));

    expect(failure).toEqual(new SendError({ reason: "delivery-pending" }));
    expect(observed.emitted).toEqual([]);
    expect(again).toEqual({ kind: "request-answered" });
  });
}

function ignoresACloseListingAnAnswerTheMemberDoesNotHold() {
  const observed = newObserved();

  return Effect.gen(function* () {
    const layer = yield* makeLayer(observed, { self: "agent:bob" });
    yield* classify(layer, "agent:alice", 10, requestValue);
    yield* classify(layer, "agent:alice", 14, close(requestId, [99]));

    expect(observed.emitted).toEqual([]);
  });
}

describe("an admitted answer whose message fails after binding", () => {
  itOnTestClock(
    "settles unanswered and applies the close held meanwhile",
    appliesAHeldCloseWhenAnAdmittedAnswerFailsAfterBinding,
  );
});

describe("all_gather at the requester", () => {
  itOnTestClock(
    "sends one request message to the group",
    sendsOneRequestMessageToTheGroup,
  );
  itOnTestClock(
    "refuses an all_gather to an agent address",
    refusesAnAllGatherToAnAgentAddress,
  );
  itOnTestClock(
    "names every member with the message's reason when the group message is refused",
    namesEveryMemberWithTheMessageReasonWhenTheGroupMessageIsRefused,
  );
  itOnTestClock(
    "names every member when the group message is not certified in time",
    namesEveryMemberWhenTheGroupMessageIsNotCertifiedInTime,
  );
  it(
    "ends in its result alone when the deadline passes before the group message certifies",
    endsInItsResultAloneWhenTheDeadlinePassesBeforeTheGroupMessageCertifies,
  );
  itOnTestClock(
    "refuses an all_gather with an unknown member before sending",
    refusesAnAllGatherWithAnUnknownMemberBeforeSending,
  );
  itOnTestClock(
    "closes with the record hash of each counted answer",
    closesWithTheRecordHashOfEachCountedAnswer,
  );
  itOnTestClock(
    "publishes its result once its close is certified",
    publishesTheRequesterResultOnceItsCloseIsCertified,
  );
  itOnTestClock(
    "closes at the deadline without the silent member",
    closesAtTheDeadlineWithoutTheSilentMember,
  );
  itOnTestClock(
    "ignores an answer that arrives after the close",
    ignoresAnAnswerThatArrivesAfterTheClose,
  );
  itOnTestClock(
    "reports a close that cannot be certified as a failed operation",
    reportsACloseThatCannotBeCertifiedAsAFailedOperation,
  );
});

describe("all_gather messages that failed once queued", () => {
  itOnTestClock(
    "says every member is still sent a group message that failed once queued",
    saysEveryMemberIsStillSentAQueuedGroupMessage,
  );
  itOnTestClock(
    "keeps a queued close pending without a terminal failure",
    keepsAQueuedClosePending,
  );
});

describe("all_gather at a member", () => {
  itOnTestClock(
    "delivers a group request as an item addressed to the group",
    deliversAGroupRequestAsAnItemAddressedToTheGroup,
  );
  itOnTestClock(
    "consumes a group request whose operationId identifies another sender",
    consumesAGroupRequestWhoseIdDoesNotDeriveFromItsSender,
  );
  itOnTestClock(
    "consumes a second request message that reuses a held operationId",
    consumesASecondRequestMessageThatReusesAHeldId,
  );
  itOnTestClock(
    "keeps a request first seen after its deadline for the close",
    keepsARequestFirstSeenAfterItsDeadlineForTheClose,
  );
  itOnTestClock("sends its answer to the group", sendsAMemberAnswerToTheGroup);
  itOnTestClock(
    "consumes a peer answer without publishing it",
    consumesAPeerAnswerWithoutPublishingIt,
  );
  itOnTestClock(
    "builds its result from exactly the listed answers",
    buildsTheMemberResultFromExactlyTheListedAnswers,
  );
  itOnTestClock(
    "includes a listed peer answer in its result",
    includesAListedPeerAnswerInTheMemberResult,
  );
  itOnTestClock(
    "holds a close until its own answer is certified",
    holdsACloseUntilTheMemberOwnAnswerIsCertified,
  );
  itOnTestClock(
    "excludes a peer answer that arrives after the close",
    excludesAPeerAnswerThatArrivesAfterTheClose,
  );
  itOnTestClock(
    "refuses its own answer after the close",
    refusesAMemberAnswerAfterTheClose,
  );
  itOnTestClock(
    "ignores a close from a member other than the requester",
    ignoresACloseFromAMemberOtherThanTheRequester,
  );
});

describe("all_gather close at a member", () => {
  itOnTestClock(
    "keeps its result when its own answer settles after the close",
    keepsItsResultWhenItsOwnAnswerSettlesAfterTheClose,
  );
  itOnTestClock(
    "applies only the first close while its own answer is in flight",
    appliesOnlyTheFirstCloseWhileItsOwnAnswerIsInFlight,
  );
  itOnTestClock(
    "ignores a close for an unknown operationId",
    ignoresACloseForAnUnknownId,
  );
  itOnTestClock(
    "ignores a close listing an answer it does not hold",
    ignoresACloseListingAnAnswerTheMemberDoesNotHold,
  );
});

describe("all_gather member results the service cannot keep", () => {
  itOnTestClock(
    "fails a close whose member result cannot be kept",
    failsACloseWhoseMemberResultCannotBeKept,
  );
  itOnTestClock(
    "keeps an answer's outcome when the close it releases cannot be kept",
    keepsAnAnswerThatReleasesAnUnkeptClose,
  );
});

itOnTestClock(
  "keeps concurrent requesters separate when their random operation bytes match",
  () =>
    Effect.gen(function* () {
      const observed = newObserved();
      const layer = yield* makeLayer(observed, { self: "agent:carol" });
      const bobOperationId = collectiveOperationId(
        testAgentView("bob").agentId,
      );
      yield* classify(layer, "agent:alice", 10, requestValue);
      yield* classify(layer, "agent:bob", 11, {
        ...requestValue,
        operationId: bobOperationId,
      });

      yield* send(layer, {
        to: group,
        collectiveResponse: { operationId: requestId, action: "decline" },
      });
      yield* send(layer, {
        to: group,
        collectiveResponse: { operationId: bobOperationId, action: "decline" },
      });
      yield* classify(layer, "agent:bob", 12, answer(requestId, "mon"));
      yield* classify(layer, "agent:alice", 13, answer(bobOperationId, "tue"));
      yield* classify(layer, "agent:bob", 14, close(requestId, [12, 101]));
      expect(observed.emitted).toEqual([]);

      yield* classify(layer, "agent:alice", 15, close(requestId, [12, 101]));
      yield* classify(layer, "agent:bob", 16, close(bobOperationId, [13, 102]));
      assertIndependentResults(observed.emitted, bobOperationId);
    }),
);

function assertIndependentResults(
  items: readonly InboundItem[],
  bobOperationId: string,
) {
  expect(items).toMatchObject([
    {
      kind: "collectiveResult",
      operationId: requestId,
      outcomes: [
        {
          member: testAgentView("bob"),
          outcome: { kind: "answered", content: { slot: "mon" } },
        },
        { member: testAgentView("carol"), outcome: { kind: "declined" } },
      ],
    },
    {
      kind: "collectiveResult",
      operationId: bobOperationId,
      outcomes: [
        {
          member: testAgentView("alice"),
          outcome: { kind: "answered", content: { slot: "tue" } },
        },
        { member: testAgentView("carol"), outcome: { kind: "declined" } },
      ],
    },
  ]);
}
