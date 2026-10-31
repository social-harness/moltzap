/** @file Gather results preserve member outcomes and accepted sends when local publication fails. */

import { scoped as it } from "@effect/vitest";
import {
  Deferred,
  Duration,
  Effect,
  Fiber,
  Option,
  Supervisor,
  TestClock,
} from "effect";
import { describe, expect } from "vitest";
import type { InboundItem } from "./inbound.js";
import { testAgentView } from "../../__tests__/agent-card-fixtures.js";
import {
  answerMessage,
  certifyNext,
  classifyMessage,
  firstRequestOf,
  gatherInput,
  gatherTo,
  makeLayer,
  msgId,
  newObserved,
  questionText,
  requestId,
  send,
  startGather,
  unkeptEmit,
} from "../../__tests__/collective-operation-fixtures.js";
import { CollectiveEmitError } from "./contracts.js";

function consumesAMemberSAnswerRatherThanDeliveringIt() {
  return Effect.gen(function* () {
    const layer = yield* makeLayer(newObserved());
    const operationId = yield* startGather(layer);
    const item = yield* classifyMessage(
      layer,
      answerMessage("agent:bob", operationId, {
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
    const operationId = yield* startGather(layer);
    yield* classifyMessage(
      layer,
      answerMessage("agent:bob", operationId, {
        action: "accept",
        content: { slot: "mon" },
      }),
    );
    yield* classifyMessage(
      layer,
      answerMessage("agent:carol", operationId, { action: "decline" }),
    );

    expect(observed.emitted).toEqual([
      {
        kind: "collectiveResult",
        closedAt: 0,
        closedBy: "settled",
        op: "gather",
        operationId,
        to: gatherTo,
        question: questionText,
        outcomes: [
          {
            member: testAgentView("agent:bob"),
            outcome: { kind: "answered", content: { slot: "mon" } },
          },
          {
            member: testAgentView("agent:carol"),
            outcome: { kind: "declined" },
          },
        ],
      },
    ]);
  });
}

function reportsASilentMemberAsNoAnswerAtTheDeadline() {
  const observed = newObserved();

  return Effect.gen(function* () {
    const layer = yield* makeLayer(observed);
    const operationId = yield* startGather(layer);
    yield* classifyMessage(
      layer,
      answerMessage("agent:bob", operationId, { action: "decline" }),
    );
    yield* TestClock.adjust(Duration.seconds(60));

    expect(observed.emitted).toEqual([
      {
        kind: "collectiveResult",
        closedAt: 60_000,
        closedBy: "deadline",
        op: "gather",
        operationId,
        to: gatherTo,
        question: questionText,
        outcomes: [
          { member: testAgentView("agent:bob"), outcome: { kind: "declined" } },
          {
            member: testAgentView("agent:carol"),
            outcome: { kind: "no-answer" },
          },
        ],
      },
    ]);
  });
}

function recordsAnAnswerThatFailsTheSchemaAsInvalid() {
  const observed = newObserved();

  return Effect.gen(function* () {
    const layer = yield* makeLayer(observed);
    const operationId = yield* startGather(layer);
    yield* classifyMessage(
      layer,
      answerMessage("agent:bob", operationId, {
        action: "accept",
        content: { slot: "sun" },
      }),
    );
    yield* classifyMessage(
      layer,
      answerMessage("agent:carol", operationId, {
        action: "accept",
        content: {},
      }),
    );

    expect(observed.emitted).toEqual([
      {
        kind: "collectiveResult",
        closedAt: 0,
        closedBy: "settled",
        op: "gather",
        operationId,
        to: gatherTo,
        question: questionText,
        outcomes: [
          {
            member: testAgentView("agent:bob"),
            outcome: {
              kind: "invalid",
              reason:
                'field "slot" is invalid (enum: must be one of the allowed values)',
            },
          },
          {
            member: testAgentView("agent:carol"),
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
    const operationId = yield* startGather(layer);
    yield* classifyMessage(
      layer,
      answerMessage("agent:bob", operationId, { action: "decline" }),
    );
    yield* classifyMessage(
      layer,
      answerMessage("agent:bob", operationId, {
        action: "accept",
        content: { slot: "mon" },
      }),
    );
    yield* TestClock.adjust(Duration.seconds(60));

    expect(observed.emitted[0]).toMatchObject({
      outcomes: [
        { member: testAgentView("agent:bob"), outcome: { kind: "declined" } },
        {},
      ],
    });
  });
}

function changesNothingForAnAnswerThatArrivesAfterTheDeadline() {
  const observed = newObserved();

  return Effect.gen(function* () {
    const layer = yield* makeLayer(observed);
    const operationId = yield* startGather(layer);
    yield* TestClock.adjust(Duration.seconds(60));
    const late = yield* classifyMessage(
      layer,
      answerMessage("agent:bob", operationId, {
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

function returnsTheGatherSIdWithTheRequestMessagesItCertified() {
  const observed = newObserved();

  return Effect.gen(function* () {
    const layer = yield* makeLayer(observed);
    const outcome = yield* send(layer, gatherInput());
    const { operationId } = yield* firstRequestOf(observed);

    expect(outcome).toEqual({
      kind: "collective",
      msgIds: [msgId(101), msgId(102)],
      operationId,
    });
  });
}

/**
 * A deadline no later than the send wait, with every message still pending,
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

    expect(outcome.msgIds).toEqual([]);
    expect(observed.emitted).toEqual([
      {
        kind: "collectiveResult",
        closedAt: 1_000,
        closedBy: "deadline",
        op: "gather",
        operationId: outcome.operationId,
        to: gatherTo,
        question: questionText,
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

function stopsTheDeadlineTimerOfAGatherEveryMemberAnswered() {
  const observed = newObserved();

  return Effect.gen(function* () {
    const supervisor = yield* Supervisor.track;
    const layer = yield* makeLayer(observed);
    const operationId = yield* startGather(layer).pipe(
      Effect.supervised(supervisor),
    );
    yield* classifyMessage(
      layer,
      answerMessage("agent:bob", operationId, { action: "decline" }),
    );
    yield* classifyMessage(
      layer,
      answerMessage("agent:carol", operationId, { action: "decline" }),
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
    const operationId = yield* startGather(layer);
    yield* classifyMessage(
      layer,
      answerMessage("agent:bob", operationId, { action: "decline" }),
    );
    const failure = yield* Effect.flip(
      classifyMessage(
        layer,
        answerMessage("agent:carol", operationId, { action: "decline" }),
      ),
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
        collectiveResponse: { operationId: requestId, action: "decline" },
      }),
    );

    expect(failure).toMatchObject({
      _tag: "CollectiveError",
      failure: { kind: "request-none" },
    });
  });
}

/** A failed local result publication does not replace an accepted send's outcome. */
function keepsAcceptedSendWhenDeadlineResultCannotBeKept() {
  const observed = newObserved();
  const attempted: InboundItem[] = [];

  return Effect.gen(function* () {
    const bobCertified = yield* Deferred.make<undefined>();
    const layer = yield* makeLayer(observed, {
      refused: { "agent:carol": "slow" },
      sendMessage: (input) =>
        certifyNext(observed, input).pipe(
          Effect.tap(() => Deferred.succeed(bobCertified, undefined)),
        ),
      emit: (item) =>
        Effect.sync(() => attempted.push(item)).pipe(
          Effect.zipRight(unkeptEmit()),
        ),
    });
    const sending = yield* Effect.fork(send(layer, gatherInput(1)));
    yield* Deferred.await(bobCertified);
    const { operationId } = yield* firstRequestOf(observed);
    yield* classifyMessage(
      layer,
      answerMessage("agent:bob", operationId, { action: "decline" }),
    );
    yield* TestClock.adjust(Duration.seconds(1));
    const outcome = yield* Fiber.join(sending);

    expect(outcome).toEqual({
      kind: "collective",
      operationId,
      msgIds: [msgId(101)],
    });
    expect(attempted).toEqual([
      {
        kind: "collectiveResult",
        operationId,
        closedAt: 1_000,
        closedBy: "deadline",
        op: "gather",
        to: gatherTo,
        question: questionText,
        outcomes: [
          { member: testAgentView("agent:bob"), outcome: { kind: "declined" } },
          {
            member: testAgentView("agent:carol"),
            outcome: { kind: "no-answer" },
          },
        ],
      },
    ]);
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
    "returns the gather's operationId with the request messages it certified",
    returnsTheGatherSIdWithTheRequestMessagesItCertified,
  );

  it(
    "ends a gather whose messages are all pending at a deadline within the wait in one result and no refusal",
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
    "keeps an accepted gather send when its deadline result cannot be kept",
    keepsAcceptedSendWhenDeadlineResultCannotBeKept,
  );
});
