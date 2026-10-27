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
import type { EngineSendInput } from "../conversations/index.js";
import type { InboundItem } from "./inbound.js";
import type { CollectiveOperations } from "./ports.js";
import {
  alice,
  certifyNext,
  collectiveFailureOf,
  collectiveKey,
  firstRequestOf,
  makeLayer,
  newObserved,
  type Observed,
  operationIdOf,
  postId,
  questionText,
  recordHashOf,
  requestNonce,
  requestSendWait,
  send,
  slotSchema,
  unkeptEmit,
} from "../../__tests__/collective-operation-fixtures.js";
import { localGuidance } from "../../__tests__/message-policy-fixtures.js";
import { SendError } from "../conversations/errors.js";
import { InboundMessage } from "../conversations/message.js";
import { CollectiveEmitError } from "./forms.js";
import { collectiveIdOf } from "./part/index.js";

const group = "group:alice,bob,carol";
const groupMembers = ["agent:alice", "agent:bob", "agent:carol"];
const requestId = collectiveIdOf(alice, requestNonce);
const otherId = `col_${"B".repeat(43)}`;

/** What a send that failed after queueing its post says about it. */
const queuedText =
  "the message is pending and Social Harness will still deliver it";

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
 * A send port that resolves `attempted` when a post reaches it and certifies
 * the post only once `certified` resolves, so a test can deliver a close
 * while the member's own answer is in flight.
 */
const holdPosts = (
  observed: Observed,
  attempted: Deferred.Deferred<undefined>,
  certified: Deferred.Deferred<undefined>,
) => ({
  sendPost: (input: EngineSendInput) =>
    Deferred.succeed(attempted, undefined).pipe(
      Effect.zipRight(Deferred.await(certified)),
      Effect.zipRight(certifyNext(observed, input)),
    ),
});

const requestValue = {
  kind: "operation",
  op: "all_gather",
  id: requestId,
  nonce: requestNonce,
  deadlineAt: 60_000,
  requestedSchema: slotSchema,
};

const groupPost = (sender: string, byte: number, value: object) =>
  Schema.decodeUnknownSync(InboundMessage)({
    kind: "group",
    postId: postId(byte),
    address: group,
    sender,
    members: groupMembers,
    content: [
      ...(value === requestValue ? [{ type: "text", text: questionText }] : []),
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
    message: groupPost(sender, byte, value),
    recordHash: recordHashOf(byte),
  });

const answer = (id: string, slot: string) => ({
  kind: "response",
  id,
  action: "accept",
  content: { slot },
});

const close = (id: string, included: readonly number[]) => ({
  kind: "close",
  id,
  included: included.map(recordHashOf),
});

const allGatherInput = (to = group) => ({
  to,
  text: questionText,
  collective: { op: "all_gather", deadline: 60, requestedSchema: slotSchema },
});

/** Start the all_gather `allGatherInput` describes and return its id; dies when the send names none. */
const startAllGather = (layer: CollectiveOperations) =>
  send(layer, allGatherInput()).pipe(Effect.flatMap(operationIdOf));

const respond = (layer: CollectiveOperations, slot: string) =>
  send(layer, {
    to: group,
    collectiveResponse: { action: "accept", content: { slot } },
  });

function sendsOneRequestPostToTheGroup() {
  const observed = newObserved();

  return Effect.gen(function* () {
    const layer = yield* makeLayer(observed);
    const id = yield* startAllGather(layer);
    const { nonce } = yield* firstRequestOf(observed);

    expect(collectiveIdOf(alice, nonce)).toBe(id);
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
                id,
                nonce,
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

function namesEveryMemberWithThePostReasonWhenTheGroupPostIsRefused() {
  const observed = newObserved();

  return Effect.gen(function* () {
    const layer = yield* makeLayer(observed, {
      sendPost: () =>
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
 * A group post that failed after it was queued still reaches the group, so
 * the refusal says so for every member rather than that it was not sent.
 */
function saysEveryMemberIsStillSentAQueuedGroupPost() {
  return Effect.gen(function* () {
    const layer = yield* makeLayer(newObserved(), {
      sendPost: () =>
        Effect.fail(new SendError({ reason: "delivery-pending" })),
    });
    const refusal = yield* Effect.flip(send(layer, allGatherInput()));

    expect(refusal.message).toBe(
      `send failed: agent:bob could not be reached: ${queuedText}; agent:carol could not be reached: ${queuedText}`,
    );
  });
}

function refusesAnAllGatherWithAnUnknownMemberBeforePosting() {
  const observed = newObserved();

  return Effect.gen(function* () {
    const posts = { attempted: 0 };
    const layer = yield* makeLayer(observed, {
      unknown: ["agent:carol"],
      sendPost: (input) => {
        posts.attempted += 1;
        return certifyNext(observed, input);
      },
    });
    const failure = yield* collectiveFailureOf(send(layer, allGatherInput()));

    expect(failure).toEqual({
      kind: "members-unreachable",
      members: [{ member: "agent:carol", reason: "unknown-agent" }],
    });
    expect(posts.attempted).toBe(0);
  });
}

function namesEveryMemberWhenTheGroupPostIsNotCertifiedInTime() {
  const observed = newObserved();

  return Effect.gen(function* () {
    const layer = yield* makeLayer(observed, {
      sendPost: () => Effect.never,
    });
    const sending = yield* Effect.fork(
      collectiveFailureOf(send(layer, allGatherInput())),
    );
    yield* TestClock.adjust(requestSendWait);

    expect(yield* Fiber.join(sending)).toEqual({
      kind: "members-unreachable",
      members: [
        { member: "agent:bob", reason: "certification-unavailable" },
        { member: "agent:carol", reason: "certification-unavailable" },
      ],
    });
  });
}

/**
 * One second short of the all_gather request wait. It intentionally
 * duplicates the private `request-sends.ts → REQUEST_SEND_WAIT` instead of
 * deriving from the `requestSendWait` mirror, so shortening the production
 * wait fails the test below even when the mirror is shortened with it.
 */
const JUST_WITHIN_REQUEST_SEND_WAIT = Duration.seconds(19);

/**
 * A group post that certifies `JUST_WITHIN_REQUEST_SEND_WAIT` after the send
 * starts the all_gather. Protects the lower side of the request wait, which a
 * cold group's GENESIS needs; fails when that wait is shortened by a second or
 * more.
 */
function startsWhenTheGroupPostCertifiesWithinTheWait() {
  const observed = newObserved();

  return Effect.gen(function* () {
    const layer = yield* makeLayer(observed, {
      sendPost: (input) =>
        Effect.sleep(JUST_WITHIN_REQUEST_SEND_WAIT).pipe(
          Effect.zipRight(certifyNext(observed, input)),
        ),
    });
    const sending = yield* Effect.fork(send(layer, allGatherInput()));
    yield* TestClock.adjust(JUST_WITHIN_REQUEST_SEND_WAIT);
    const outcome = yield* Fiber.join(sending);
    const { id } = yield* firstRequestOf(observed);

    expect(outcome).toEqual({ postIds: [postId(101)], operationId: id });
  });
}

/**
 * Runs on the live clock. The one-second deadline lies within the send's
 * wait, so the wait ends at the deadline; the deadline timer is scheduled just
 * before the group post's wait, so it fires first. Effect's TestClock wakes
 * sleeps due at one instant newest first, so under it the wait fires first and
 * the send is refused. The test waits on the result's emission, not on a fixed
 * delay.
 */
function endsInItsResultAloneWhenTheDeadlinePassesBeforeTheGroupPostCertifies() {
  const observed = newObserved();
  const advice = localGuidance(9);

  return Effect.gen(function* () {
    const emitted = yield* Deferred.make<undefined>();
    const bound: EngineSendInput[] = [];
    const layer = yield* makeLayer(observed, {
      ...signalEmitted(observed, emitted),
      admission: {
        bindPost: (input, hold) =>
          hold.pipe(
            Effect.zipLeft(
              Effect.sync(() => {
                bound.push(input);
              }),
            ),
            Effect.as({ certified: Effect.never, guidance: advice }),
          ),
        admitGather: () => Effect.dieMessage("an all_gather admits no gather"),
      },
    });
    const completed = yield* send(layer, {
      ...allGatherInput(),
      collective: {
        op: "all_gather",
        deadline: 1,
        requestedSchema: slotSchema,
      },
    });
    yield* Deferred.await(emitted);

    expect(bound.map(({ to }) => to)).toEqual([group]);
    expect(completed).toMatchObject({ postIds: [], guidance: advice });
    expect(observed.emitted).toMatchObject([
      { kind: "collectiveResult", to: group },
    ]);
  }).pipe(Effect.scoped);
}

function closesWithTheRecordHashOfEachCountedAnswer() {
  const observed = newObserved();

  return Effect.gen(function* () {
    const emitted = yield* Deferred.make<undefined>();
    const layer = yield* makeLayer(observed, signalEmitted(observed, emitted));
    const id = yield* startAllGather(layer);
    yield* classify(layer, "agent:bob", 11, answer(id, "mon"));
    yield* classify(layer, "agent:bob", 12, answer(id, "tue"));
    yield* classify(layer, "agent:carol", 13, answer(id, "tue"));
    yield* Deferred.await(emitted);

    expect(observed.sent[1]).toEqual({
      to: group,
      content: [
        {
          type: "data",
          value: {
            [collectiveKey]: {
              kind: "close",
              id,
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
    const id = yield* startAllGather(layer);
    yield* classify(layer, "agent:bob", 11, answer(id, "mon"));
    yield* classify(layer, "agent:carol", 13, answer(id, "tue"));
    yield* Deferred.await(emitted);

    expect(observed.emitted).toEqual([
      {
        kind: "collectiveResult",
        op: "all_gather",
        id,
        to: group,
        question: questionText,
        outcomes: [
          {
            member: "agent:bob",
            outcome: { kind: "answered", content: { slot: "mon" } },
          },
          {
            member: "agent:carol",
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
    const id = yield* startAllGather(layer);
    yield* classify(layer, "agent:bob", 11, answer(id, "mon"));
    yield* TestClock.adjust(Duration.seconds(60));
    yield* Deferred.await(emitted);

    expect(observed.emitted).toMatchObject([
      {
        outcomes: [
          { member: "agent:bob", outcome: { kind: "answered" } },
          { member: "agent:carol", outcome: { kind: "no-answer" } },
        ],
      },
    ]);
    expect(observed.sent[1]?.content).toMatchObject([
      { value: { [collectiveKey]: { included: [recordHashOf(11)] } } },
    ]);
  });
}

function ignoresAnAnswerThatArrivesAfterTheClose() {
  const observed = newObserved();

  return Effect.gen(function* () {
    const emitted = yield* Deferred.make<undefined>();
    const supervisor = yield* Supervisor.track;
    const layer = yield* makeLayer(observed, signalEmitted(observed, emitted));
    const id = yield* startAllGather(layer);
    yield* TestClock.adjust(Duration.seconds(60));
    yield* Deferred.await(emitted);
    const late = yield* classify(
      layer,
      "agent:carol",
      13,
      answer(id, "tue"),
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
      sendPost: (input) =>
        observed.sent.length === 0
          ? certifyNext(observed, input)
          : Effect.fail(new SendError({ reason: "network-unavailable" })),
    });
    const id = yield* startAllGather(layer);
    yield* TestClock.adjust(Duration.seconds(60));
    yield* Deferred.await(emitted);

    expect(observed.emitted).toEqual([
      {
        kind: "operationFailed",
        id,
        to: group,
        error:
          "all_gather failed: the result could not be shared with the group: Social Harness is unavailable (network unavailable)",
      },
    ]);
    yield* Effect.repeat(Effect.yieldNow(), {
      until: () => closed().length > 0,
    });
    expect(closed()).toMatchObject([{ operationId: id, outcome: "failed" }]);
  }).pipe(
    Effect.provide(
      NodeSdk.layer(() => ({
        spanProcessor: new SimpleSpanProcessor(exporter),
      })),
    ),
  );
}

/**
 * A close that failed after it was queued still reaches the group, so the
 * asker's failure says so rather than that no member will see a result.
 */
function saysAQueuedCloseWillStillReachTheGroup() {
  const observed = newObserved();

  return Effect.gen(function* () {
    const emitted = yield* Deferred.make<undefined>();
    const layer = yield* makeLayer(observed, {
      ...signalEmitted(observed, emitted),
      sendPost: (input) =>
        observed.sent.length === 0
          ? certifyNext(observed, input)
          : Effect.fail(new SendError({ reason: "delivery-pending" })),
    });
    const id = yield* startAllGather(layer);
    yield* TestClock.adjust(Duration.seconds(60));
    yield* Deferred.await(emitted);

    expect(observed.emitted).toEqual([
      {
        kind: "operationFailed",
        id,
        to: group,
        error: `all_gather failed: the result could not be shared with the group: ${queuedText}`,
      },
    ]);
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
        id: requestId,
        postId: postId(10),
        from: "agent:alice",
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

function consumesASecondRequestPostThatReusesAHeldId() {
  const observed = newObserved();

  return Effect.gen(function* () {
    const layer = yield* makeLayer(observed, { self: "agent:bob" });
    yield* classify(layer, "agent:alice", 10, requestValue);
    const reused = yield* layer.classify({
      message: Schema.decodeUnknownSync(InboundMessage)({
        kind: "direct",
        postId: postId(20),
        address: "agent:alice",
        sender: "agent:alice",
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
          { member: "agent:bob", outcome: { kind: "no-answer" } },
          { member: "agent:carol", outcome: { kind: "answered" } },
        ],
      },
    ]);
  });
}

function postsAMemberAnswerToTheGroup() {
  const observed = newObserved();

  return Effect.gen(function* () {
    const layer = yield* makeLayer(observed, { self: "agent:bob" });
    yield* classify(layer, "agent:alice", 10, requestValue);
    yield* respond(layer, "mon");

    expect(observed.sent.map((post) => post.to)).toEqual([group]);
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
        op: "all_gather",
        id: requestId,
        to: group,
        question: questionText,
        outcomes: [
          {
            member: "agent:bob",
            outcome: { kind: "answered", content: { slot: "mon" } },
          },
          { member: "agent:carol", outcome: { kind: "no-answer" } },
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
          { member: "agent:bob", outcome: { kind: "no-answer" } },
          {
            member: "agent:carol",
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
      ...holdPosts(observed, attempted, certified),
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
          { member: "agent:bob", outcome: { kind: "answered" } },
          { member: "agent:carol", outcome: { kind: "no-answer" } },
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
 * still returns its certified answer post, since that post exists.
 */
function keepsAnAnswerThatReleasesAnUnkeptClose() {
  const observed = newObserved();

  return Effect.gen(function* () {
    const attempted = yield* Deferred.make<undefined>();
    const certified = yield* Deferred.make<undefined>();
    const layer = yield* makeLayer(observed, {
      self: "agent:bob",
      emit: unkeptEmit,
      ...holdPosts(observed, attempted, certified),
    });
    yield* classify(layer, "agent:alice", 10, requestValue);
    const answering = yield* Effect.fork(respond(layer, "mon"));
    yield* Deferred.await(attempted);
    yield* classify(layer, "agent:alice", 14, close(requestId, [101]));
    yield* Deferred.succeed(certified, undefined);

    const outcome = yield* Fiber.join(answering);

    expect(outcome.operationId).toBe(requestId);
    expect(outcome.postIds).toHaveLength(1);
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
          { member: "agent:bob", outcome: { kind: "no-answer" } },
          { member: "agent:carol", outcome: { kind: "no-answer" } },
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
      ...holdPosts(observed, attempted, certified),
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
      ...holdPosts(observed, attempted, certified),
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
          { member: "agent:bob", outcome: { kind: "answered" } },
          { member: "agent:carol", outcome: { kind: "no-answer" } },
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
 * An admitted answer whose post fails after binding settles unanswered with
 * its advice, applying the close held while it was in flight: that close
 * lists the answer this member will not hold, so it ends the request
 * without a result.
 */
function appliesAHeldCloseWhenAnAdmittedAnswerFailsAfterBinding() {
  const observed = newObserved();
  const advice = localGuidance(4);

  return Effect.gen(function* () {
    const attempted = yield* Deferred.make<undefined>();
    const failing = yield* Deferred.make<undefined>();
    const layer = yield* makeLayer(observed, {
      self: "agent:bob",
      admission: {
        bindPost: (input, hold) =>
          hold.pipe(
            Effect.as({
              certified: Deferred.succeed(attempted, undefined).pipe(
                Effect.zipRight(Deferred.await(failing)),
                Effect.zipRight(
                  Effect.fail(new SendError({ reason: "delivery-pending" })),
                ),
                Effect.zipLeft(Effect.sync(() => observed.sent.push(input))),
              ),
              guidance: advice,
            }),
          ),
        admitGather: () => Effect.dieMessage("a member admits no gather"),
      },
    });
    yield* classify(layer, "agent:alice", 10, requestValue);
    yield* layer.settleRequest(requestId, true);
    const answering = yield* Effect.fork(
      send(
        layer,
        {
          to: group,
          collectiveResponse: { action: "accept", content: { slot: "mon" } },
        },
        "inbound",
      ),
    );
    yield* Deferred.await(attempted);
    yield* classify(layer, "agent:alice", 14, close(requestId, [101]));
    yield* Deferred.succeed(failing, undefined);
    const completed = yield* Fiber.join(answering);
    const again = yield* collectiveFailureOf(respond(layer, "tue"));

    expect(completed).toMatchObject({ postIds: [], guidance: advice });
    expect(observed.emitted).toMatchObject([
      { kind: "operationFailed", id: requestId },
    ]);
    expect(again).toEqual({ kind: "request-expired" });
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

describe("an admitted answer whose post fails after binding", () => {
  itOnTestClock(
    "settles unanswered with its advice and applies the close held meanwhile",
    appliesAHeldCloseWhenAnAdmittedAnswerFailsAfterBinding,
  );
});

describe("all_gather at the requester", () => {
  itOnTestClock(
    "sends one request post to the group",
    sendsOneRequestPostToTheGroup,
  );
  itOnTestClock(
    "refuses an all_gather to an agent address",
    refusesAnAllGatherToAnAgentAddress,
  );
  itOnTestClock(
    "names every member with the post's reason when the group post is refused",
    namesEveryMemberWithThePostReasonWhenTheGroupPostIsRefused,
  );
  itOnTestClock(
    "names every member when the group post is not certified in time",
    namesEveryMemberWhenTheGroupPostIsNotCertifiedInTime,
  );
  itOnTestClock(
    "starts when its group post certifies within the send's wait",
    startsWhenTheGroupPostCertifiesWithinTheWait,
  );
  it(
    "ends in its result alone when the deadline passes before the group post certifies",
    endsInItsResultAloneWhenTheDeadlinePassesBeforeTheGroupPostCertifies,
  );
  itOnTestClock(
    "refuses an all_gather with an unknown member before posting",
    refusesAnAllGatherWithAnUnknownMemberBeforePosting,
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

describe("all_gather posts that failed once queued", () => {
  itOnTestClock(
    "says every member is still sent a group post that failed once queued",
    saysEveryMemberIsStillSentAQueuedGroupPost,
  );
  itOnTestClock(
    "says a close that failed once queued will still reach the group",
    saysAQueuedCloseWillStillReachTheGroup,
  );
});

describe("all_gather at a member", () => {
  itOnTestClock(
    "delivers a group request as an item addressed to the group",
    deliversAGroupRequestAsAnItemAddressedToTheGroup,
  );
  itOnTestClock(
    "consumes a group request whose id does not derive from its sender",
    consumesAGroupRequestWhoseIdDoesNotDeriveFromItsSender,
  );
  itOnTestClock(
    "consumes a second request post that reuses a held id",
    consumesASecondRequestPostThatReusesAHeldId,
  );
  itOnTestClock(
    "keeps a request first seen after its deadline for the close",
    keepsARequestFirstSeenAfterItsDeadlineForTheClose,
  );
  itOnTestClock("posts its answer to the group", postsAMemberAnswerToTheGroup);
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
    "ignores a close for an unknown id",
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
