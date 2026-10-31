/** @file Pins how the collective layer runs an all_gather at its requester and members. */

import * as NodeSdk from "@effect/opentelemetry/NodeSdk";
import { scoped as it } from "@effect/vitest";
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
  Scope,
  Supervisor,
  TestClock,
} from "effect";
import { describe, expect } from "vitest";
import type { InboundItem } from "../../host-protocol/items.js";
import type { EngineSendInput } from "../conversations/index.js";
import { testAgentView } from "../../__tests__/agent-card-fixtures.js";
import { collectiveOperationId } from "../../__tests__/collective-id-fixtures.js";
import { collectivePersistencePorts } from "../../__tests__/collective-message-fixtures.js";
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
import {
  type TestCollectiveOperations as CollectiveOperations,
  makeCollectiveOperations,
} from "../../__tests__/collective-send.js";
import { SendError } from "../conversations/errors.js";
import { Message, type MessageReference } from "../message.js";
import { CollectiveEmitError } from "./contracts.js";
import { collectiveRequesterOf } from "./wire/index.js";

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
  Schema.decodeUnknownSync(Message)({
    msgId: msgId(byte),
    author: testAgentView(sender),
    recipients: groupMembers
      .filter((member) => member !== sender)
      .map(testAgentView),
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

const answerReference = (author: string, byte: number): MessageReference => ({
  authorAgentId: testAgentView(author).agentId,
  msgId: msgId(byte),
});

const close = (operationId: string, included: readonly MessageReference[]) => ({
  kind: "close",
  closedAt: 60_000,
  closedBy: "deadline",
  operationId,
  included,
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

function recoversTheSameRequestAfterAcceptedCertificationFails() {
  return Effect.gen(function* () {
    const ports = yield* collectivePersistencePorts(() =>
      Effect.fail(new SendError({ reason: "network-unavailable" })),
    );
    const original = yield* Effect.scoped(
      Effect.gen(function* () {
        const layer = yield* ports.run(
          makeCollectiveOperations({
            ...ports,
            self: testAgentView(alice),
            scope: yield* Scope.Scope,
            emit: () => Effect.void,
          }),
        );
        const failure = yield* Effect.flip(send(layer, allGatherInput()));
        expect(failure).toEqual(
          new SendError({ reason: "network-unavailable" }),
        );
        return yield* ports.run(ports.store.readCollectiveMessages());
      }),
    );
    const request = yield* Effect.fromNullable(original[0]);
    expect(request).toMatchObject({ role: "request", destination: group });
    expect(original).toHaveLength(1);

    yield* ports.run(
      makeCollectiveOperations({
        ...ports,
        self: testAgentView(alice),
        scope: yield* Scope.Scope,
        emit: () => Effect.void,
      }),
    );

    expect(yield* ports.run(ports.store.readCollectiveMessages())).toEqual(
      original,
    );
    expect(
      yield* ports.run(
        ports.store.readCollectiveOperation(request.operationId),
      ),
    ).toMatchObject({ operationId: request.operationId, phase: "collecting" });
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

function closesWithTheIdentityOfEachCountedAnswer() {
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
              included: [
                answerReference("agent:bob", 11),
                answerReference("agent:carol", 13),
              ],
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
            included: [answerReference("agent:bob", 11)],
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
        message: {
          msgId: msgId(10),
          author: testAgentView("agent:alice"),
          recipients: [
            testAgentView("agent:bob"),
            testAgentView("agent:carol"),
          ],
          content: {
            op: "all_gather",
            operationId: requestId,
            question: questionText,
            requestedSchema: slotSchema,
            deadlineAt: 60_000,
          },
        },
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
      message: Schema.decodeUnknownSync(Message)({
        msgId: msgId(20),
        author: testAgentView("agent:alice"),
        recipients: [testAgentView("agent:bob")],
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
    expect(redelivered).toMatchObject(
      Option.some({ message: { content: { operationId: requestId } } }),
    );
  });
}

function keepsARequestFirstSeenAfterItsDeadlineForTheClose() {
  const observed = newObserved();

  return Effect.gen(function* () {
    const layer = yield* makeLayer(observed, { self: "agent:bob" });
    yield* TestClock.adjust(Duration.seconds(60));
    const item = yield* classify(layer, "agent:alice", 10, requestValue);
    yield* classify(layer, "agent:carol", 13, answer(requestId, "tue"));
    yield* classify(
      layer,
      "agent:alice",
      14,
      close(requestId, [answerReference("agent:carol", 13)]),
    );
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
    yield* classify(
      layer,
      "agent:alice",
      14,
      close(requestId, [answerReference("agent:bob", 101)]),
    );

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
    yield* classify(
      layer,
      "agent:alice",
      14,
      close(requestId, [answerReference("agent:carol", 13)]),
    );

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
    yield* classify(
      layer,
      "agent:alice",
      14,
      close(requestId, [answerReference("agent:bob", 101)]),
    );
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
    yield* classify(
      layer,
      "agent:alice",
      14,
      close(requestId, [answerReference("agent:bob", 101)]),
    );
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
    yield* classify(
      layer,
      "agent:alice",
      14,
      close(requestId, [answerReference("agent:bob", 101)]),
    );
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

/** An accepted pending answer keeps its claim and the close waiting for its certification. */
function keepsAnAcceptedAnswerClaimWhenCertificationRemainsPending() {
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
    yield* classify(
      layer,
      "agent:alice",
      14,
      close(requestId, [answerReference("agent:bob", 101)]),
    );
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
    yield* classify(
      layer,
      "agent:alice",
      14,
      close(requestId, [answerReference("agent:bob", 99)]),
    );

    expect(observed.emitted).toEqual([]);
  });
}

describe("an accepted answer pending certification", () => {
  it(
    "retains its answer claim and leaves the close pending",
    keepsAnAcceptedAnswerClaimWhenCertificationRemainsPending,
  );
});

describe("all_gather at the requester", () => {
  it(
    "sends one request message to the group",
    sendsOneRequestMessageToTheGroup,
  );
  it(
    "refuses an all_gather to an agent address",
    refusesAnAllGatherToAnAgentAddress,
  );
  it(
    "recovers the same request after accepted certification fails",
    recoversTheSameRequestAfterAcceptedCertificationFails,
  );
  it(
    "names every member when the group message is not certified in time",
    namesEveryMemberWhenTheGroupMessageIsNotCertifiedInTime,
  );
  it(
    "refuses an all_gather with an unknown member before sending",
    refusesAnAllGatherWithAnUnknownMemberBeforeSending,
  );
  it(
    "closes with the message identity of each counted answer",
    closesWithTheIdentityOfEachCountedAnswer,
  );
  it(
    "publishes its result once its close is certified",
    publishesTheRequesterResultOnceItsCloseIsCertified,
  );
  it(
    "closes at the deadline without the silent member",
    closesAtTheDeadlineWithoutTheSilentMember,
  );
  it(
    "ignores an answer that arrives after the close",
    ignoresAnAnswerThatArrivesAfterTheClose,
  );
  it(
    "reports a close that cannot be certified as a failed operation",
    reportsACloseThatCannotBeCertifiedAsAFailedOperation,
  );
});

describe("all_gather messages that failed once queued", () => {
  it(
    "says every member is still sent a group message that failed once queued",
    saysEveryMemberIsStillSentAQueuedGroupMessage,
  );
  it(
    "keeps a queued close pending without a terminal failure",
    keepsAQueuedClosePending,
  );
});

describe("all_gather at a member", () => {
  it(
    "delivers a group request as an item addressed to the group",
    deliversAGroupRequestAsAnItemAddressedToTheGroup,
  );
  it(
    "consumes a group request whose operationId identifies another sender",
    consumesAGroupRequestWhoseIdDoesNotDeriveFromItsSender,
  );
  it(
    "consumes a second request message that reuses a held operationId",
    consumesASecondRequestMessageThatReusesAHeldId,
  );
  it(
    "keeps a request first seen after its deadline for the close",
    keepsARequestFirstSeenAfterItsDeadlineForTheClose,
  );
  it("sends its answer to the group", sendsAMemberAnswerToTheGroup);
  it(
    "consumes a peer answer without publishing it",
    consumesAPeerAnswerWithoutPublishingIt,
  );
  it(
    "builds its result from exactly the listed answers",
    buildsTheMemberResultFromExactlyTheListedAnswers,
  );
  it(
    "includes a listed peer answer in its result",
    includesAListedPeerAnswerInTheMemberResult,
  );
  it(
    "holds a close until its own answer is certified",
    holdsACloseUntilTheMemberOwnAnswerIsCertified,
  );
  it(
    "excludes a peer answer that arrives after the close",
    excludesAPeerAnswerThatArrivesAfterTheClose,
  );
  it(
    "refuses its own answer after the close",
    refusesAMemberAnswerAfterTheClose,
  );
  it(
    "ignores a close from a member other than the requester",
    ignoresACloseFromAMemberOtherThanTheRequester,
  );
});

describe("all_gather close at a member", () => {
  it(
    "keeps its result when its own answer settles after the close",
    keepsItsResultWhenItsOwnAnswerSettlesAfterTheClose,
  );
  it(
    "applies only the first close while its own answer is in flight",
    appliesOnlyTheFirstCloseWhileItsOwnAnswerIsInFlight,
  );
  it("ignores a close for an unknown operationId", ignoresACloseForAnUnknownId);
  it(
    "ignores a close listing an answer it does not hold",
    ignoresACloseListingAnAnswerTheMemberDoesNotHold,
  );
});

describe("all_gather member results the service cannot keep", () => {
  it(
    "fails a close whose member result cannot be kept",
    failsACloseWhoseMemberResultCannotBeKept,
  );
  it(
    "keeps an answer's outcome when the close it releases cannot be kept",
    keepsAnAnswerThatReleasesAnUnkeptClose,
  );
});
