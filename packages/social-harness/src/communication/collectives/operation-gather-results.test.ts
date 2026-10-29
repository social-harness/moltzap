/** @file Pins how a requester completes a gather, and what happens when the service cannot keep what the layer emits. */

import { scoped as it } from "@effect/vitest";
import { Duration, Effect, Fiber, Option, Supervisor, TestClock } from "effect";
import { describe, expect } from "vitest";
import type { CollectivePorts } from "./ports.js";
import {
  answerPost,
  certifyNext,
  classifyPost,
  firstRequestOf,
  gatherInput,
  gatherTo,
  makeLayer,
  newObserved,
  type Observed,
  postId,
  questionText,
  send,
  startGather,
  unkeptEmit,
} from "../../__tests__/collective-operation-fixtures.js";
import { SendError } from "../conversations/errors.js";
import { CollectiveEmitError } from "./forms.js";

/**
 * Certify Bob's post at once and refuse Carol's after half a second, so
 * Carol's refusal lands inside the send's wait.
 */
const refuseCarolLater =
  (observed: Observed): CollectivePorts["sendPost"] =>
  (input) =>
    input.to === "agent:carol"
      ? Effect.sleep(Duration.millis(500)).pipe(
          Effect.zipRight(
            Effect.fail(new SendError({ reason: "network-unavailable" })),
          ),
        )
      : certifyNext(observed, input);

function consumesAMemberSAnswerRatherThanDeliveringIt() {
  return Effect.gen(function* () {
    const layer = yield* makeLayer(newObserved());
    const id = yield* startGather(layer);
    const item = yield* classifyPost(
      layer,
      answerPost("agent:bob", id, {
        action: "accept",
        content: { slot: "mon" },
      }),
    );

    expect(item).toEqual(Option.none());
  });
}

function emitsTheResultOnceEveryMemberHasAnswered() {
  const observed = newObserved();

  return Effect.gen(function* () {
    const layer = yield* makeLayer(observed);
    const id = yield* startGather(layer);
    yield* classifyPost(
      layer,
      answerPost("agent:bob", id, {
        action: "accept",
        content: { slot: "mon" },
      }),
    );
    yield* classifyPost(
      layer,
      answerPost("agent:carol", id, { action: "decline" }),
    );

    expect(observed.emitted).toEqual([
      {
        kind: "collectiveResult",
        op: "gather",
        id,
        to: gatherTo,
        question: questionText,
        outcomes: [
          {
            member: "agent:bob",
            outcome: { kind: "answered", content: { slot: "mon" } },
          },
          { member: "agent:carol", outcome: { kind: "declined" } },
        ],
      },
    ]);
  });
}

function reportsASilentMemberAsNoAnswerAtTheDeadline() {
  const observed = newObserved();

  return Effect.gen(function* () {
    const layer = yield* makeLayer(observed);
    const id = yield* startGather(layer);
    yield* classifyPost(
      layer,
      answerPost("agent:bob", id, { action: "decline" }),
    );
    yield* TestClock.adjust(Duration.seconds(60));

    expect(observed.emitted).toEqual([
      {
        kind: "collectiveResult",
        op: "gather",
        id,
        to: gatherTo,
        question: questionText,
        outcomes: [
          { member: "agent:bob", outcome: { kind: "declined" } },
          { member: "agent:carol", outcome: { kind: "no-answer" } },
        ],
      },
    ]);
  });
}

function recordsAnAnswerThatFailsTheSchemaAsInvalid() {
  const observed = newObserved();

  return Effect.gen(function* () {
    const layer = yield* makeLayer(observed);
    const id = yield* startGather(layer);
    yield* classifyPost(
      layer,
      answerPost("agent:bob", id, {
        action: "accept",
        content: { slot: "sun" },
      }),
    );
    yield* classifyPost(
      layer,
      answerPost("agent:carol", id, { action: "accept", content: {} }),
    );

    expect(observed.emitted).toEqual([
      {
        kind: "collectiveResult",
        op: "gather",
        id,
        to: gatherTo,
        question: questionText,
        outcomes: [
          {
            member: "agent:bob",
            outcome: {
              kind: "invalid",
              reason:
                'field "slot" is invalid (enum: must be one of the allowed values)',
            },
          },
          {
            member: "agent:carol",
            outcome: { kind: "invalid", reason: 'field "slot" is missing' },
          },
        ],
      },
    ]);
  });
}

function keepsAMemberSFirstAnswerAndIgnoresItsSecond() {
  const observed = newObserved();

  return Effect.gen(function* () {
    const layer = yield* makeLayer(observed);
    const id = yield* startGather(layer);
    yield* classifyPost(
      layer,
      answerPost("agent:bob", id, { action: "decline" }),
    );
    yield* classifyPost(
      layer,
      answerPost("agent:bob", id, {
        action: "accept",
        content: { slot: "mon" },
      }),
    );
    yield* TestClock.adjust(Duration.seconds(60));

    expect(observed.emitted[0]).toMatchObject({
      outcomes: [{ member: "agent:bob", outcome: { kind: "declined" } }, {}],
    });
  });
}

function changesNothingForAnAnswerThatArrivesAfterTheDeadline() {
  const observed = newObserved();

  return Effect.gen(function* () {
    const layer = yield* makeLayer(observed);
    const id = yield* startGather(layer);
    yield* TestClock.adjust(Duration.seconds(60));
    const late = yield* classifyPost(
      layer,
      answerPost("agent:bob", id, {
        action: "accept",
        content: { slot: "mon" },
      }),
    );

    expect(late).toEqual(Option.none());
    expect(observed.emitted).toHaveLength(1);
  });
}

function namesTheResultByTheGroupSCanonicalAddress() {
  const observed = newObserved();

  return Effect.gen(function* () {
    const layer = yield* makeLayer(observed);
    yield* send(layer, { ...gatherInput(), to: "group:carol,bob" });
    yield* TestClock.adjust(Duration.seconds(60));

    expect(observed.emitted[0]).toMatchObject({ to: gatherTo });
  });
}

function returnsTheGatherSIdWithTheRequestPostsItCertified() {
  const observed = newObserved();

  return Effect.gen(function* () {
    const layer = yield* makeLayer(observed);
    const outcome = yield* send(layer, gatherInput());
    const { id } = yield* firstRequestOf(observed);

    expect(outcome).toEqual({
      kind: "collective",
      postIds: [postId(101), postId(102)],
      operationId: id,
    });
  });
}

/**
 * A deadline no later than the send wait, with every post still pending,
 * ends the gather in one result and no refusal.
 */
function endsAPendingGatherAtItsDeadlineInOneResult() {
  const observed = newObserved();

  return Effect.gen(function* () {
    const layer = yield* makeLayer(observed, {
      refused: { "agent:bob": "slow", "agent:carol": "slow" },
    });
    const sending = yield* Effect.fork(send(layer, gatherInput(1)));
    yield* TestClock.adjust(Duration.seconds(1));
    const outcome = yield* Fiber.join(sending);
    yield* TestClock.adjust(Duration.seconds(60));

    expect(outcome.postIds).toEqual([]);
    expect(observed.emitted).toEqual([
      {
        kind: "collectiveResult",
        op: "gather",
        id: outcome.operationId,
        to: gatherTo,
        question: questionText,
        outcomes: [
          { member: "agent:bob", outcome: { kind: "no-answer" } },
          { member: "agent:carol", outcome: { kind: "no-answer" } },
        ],
      },
    ]);
  });
}

function stopsTheDeadlineTimerOfAGatherEveryMemberAnswered() {
  const observed = newObserved();

  return Effect.gen(function* () {
    const supervisor = yield* Supervisor.track;
    const layer = yield* makeLayer(observed);
    const id = yield* startGather(layer).pipe(Effect.supervised(supervisor));
    yield* classifyPost(
      layer,
      answerPost("agent:bob", id, { action: "decline" }),
    );
    yield* classifyPost(
      layer,
      answerPost("agent:carol", id, { action: "decline" }),
    );

    expect(yield* supervisor.value).toEqual([]);
  });
}

function completesAGatherWhoseDeadlineIsThirtyDaysAway() {
  const observed = newObserved();

  return Effect.gen(function* () {
    const layer = yield* makeLayer(observed);
    yield* send(layer, gatherInput(2_592_000));
    yield* TestClock.adjust(Duration.days(30));

    expect(observed.emitted).toMatchObject([{ kind: "collectiveResult" }]);
  });
}

/**
 * The answer that completes a gather fails its classification when the result
 * cannot be kept, so the pass classifying it ends instead of waiting.
 */
function failsTheCompletingAnswerWhenTheResultCannotBeKept() {
  return Effect.gen(function* () {
    const layer = yield* makeLayer(newObserved(), { emit: unkeptEmit });
    const id = yield* startGather(layer);
    yield* classifyPost(
      layer,
      answerPost("agent:bob", id, { action: "decline" }),
    );
    const failure = yield* Effect.flip(
      classifyPost(layer, answerPost("agent:carol", id, { action: "decline" })),
    );

    expect(failure).toEqual(new CollectiveEmitError());
  });
}

/**
 * A refused send returns its own error even if the local inbox is unavailable.
 */
function failsASendWithItsRefusalWhenTheInboundCopyCannotBeKept() {
  return Effect.gen(function* () {
    const layer = yield* makeLayer(newObserved(), { emit: unkeptEmit });
    const failure = yield* Effect.flip(
      send(layer, {
        to: "agent:bob",
        collectiveResponse: { action: "decline" },
      }),
    );

    expect(failure).toMatchObject({
      _tag: "CollectiveError",
      failure: { kind: "request-none" },
    });
  });
}

/**
 * A gather whose last outcome arrives before its request sends return
 * completes when they settle; when that result cannot be kept, the send
 * still returns the operation and the request post that exists. Bob's post
 * certifies at once and he declines; Carol's post is refused later, inside
 * the send's wait.
 */
function keepsAGatherSendWhoseSettlingResultCannotBeKept() {
  const observed = newObserved();

  return Effect.gen(function* () {
    const layer = yield* makeLayer(observed, {
      sendPost: refuseCarolLater(observed),
      emit: unkeptEmit,
    });
    const sending = yield* Effect.fork(send(layer, gatherInput()));
    yield* TestClock.adjust(Duration.millis(100));
    const { id } = yield* firstRequestOf(observed);
    yield* classifyPost(
      layer,
      answerPost("agent:bob", id, { action: "decline" }),
    );
    yield* TestClock.adjust(Duration.millis(500));

    const outcome = yield* Fiber.join(sending);

    expect(outcome.operationId).toBe(id);
    expect(outcome.postIds).toHaveLength(1);
  });
}

// @agent-code-guard/regression-only: examples pin how the requester completes a gather.
describe("gather results", () => {
  it(
    "consumes a member's answer rather than delivering it",
    consumesAMemberSAnswerRatherThanDeliveringIt,
  );

  it(
    "emits the result once every member has answered",
    emitsTheResultOnceEveryMemberHasAnswered,
  );

  it(
    "reports a silent member as no-answer at the deadline",
    reportsASilentMemberAsNoAnswerAtTheDeadline,
  );

  it(
    "records an answer that fails the schema as invalid",
    recordsAnAnswerThatFailsTheSchemaAsInvalid,
  );

  it(
    "keeps a member's first answer and ignores its second",
    keepsAMemberSFirstAnswerAndIgnoresItsSecond,
  );

  it(
    "changes nothing for an answer that arrives after the deadline",
    changesNothingForAnAnswerThatArrivesAfterTheDeadline,
  );

  it(
    "names the result by the group's canonical address",
    namesTheResultByTheGroupSCanonicalAddress,
  );

  it(
    "returns the gather's id with the request posts it certified",
    returnsTheGatherSIdWithTheRequestPostsItCertified,
  );

  it(
    "ends a gather whose posts are all pending at a deadline within the wait in one result and no refusal",
    endsAPendingGatherAtItsDeadlineInOneResult,
  );

  it(
    "stops the deadline timer of a gather every member answered",
    stopsTheDeadlineTimerOfAGatherEveryMemberAnswered,
  );

  it(
    "completes a gather whose deadline is thirty days away",
    completesAGatherWhoseDeadlineIsThirtyDaysAway,
  );
});

describe("emitted items the service cannot keep", () => {
  it(
    "fails the completing answer when the result cannot be kept",
    failsTheCompletingAnswerWhenTheResultCannotBeKept,
  );
  it(
    "fails a send with its refusal when the inbound copy cannot be kept",
    failsASendWithItsRefusalWhenTheInboundCopyCannotBeKept,
  );
  it(
    "keeps a gather send's outcome when its settling result cannot be kept",
    keepsAGatherSendWhoseSettlingResultCannotBeKept,
  );
});
