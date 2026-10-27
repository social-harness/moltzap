/** @file Pins how a member answers a gather request it received. */

import { scoped as it } from "@effect/vitest";
import { Duration, Effect, TestClock } from "effect";
import { describe, expect } from "vitest";
import {
  classifyPost,
  collectiveFailureOf,
  collectiveKey,
  makeLayer,
  newObserved,
  requestId,
  requestPost,
  send,
} from "../../__tests__/collective-operation-fixtures.js";

function postsAValidAnswerToTheRequesterSDirectConversation() {
  const observed = newObserved();

  return Effect.gen(function* () {
    const layer = yield* makeLayer(observed);
    yield* classifyPost(layer, requestPost("agent:bob", 60_000));
    yield* send(layer, {
      to: "agent:bob",
      collectiveResponse: { action: "accept", content: { slot: "mon" } },
    });

    expect(observed.sent).toEqual([
      {
        to: "agent:bob",
        content: [
          {
            type: "data",
            value: {
              [collectiveKey]: {
                kind: "response",
                id: requestId,
                action: "accept",
                content: { slot: "mon" },
              },
            },
          },
        ],
      },
    ]);
  });
}

function refusesAnAnswerThatFailsTheRequestSSchemaNamingTheField() {
  const observed = newObserved();

  return Effect.gen(function* () {
    const layer = yield* makeLayer(observed);
    yield* classifyPost(layer, requestPost("agent:bob", 60_000));
    const failure = yield* collectiveFailureOf(
      send(layer, {
        to: "agent:bob",
        collectiveResponse: { action: "accept", content: { slot: "sun" } },
      }),
    );

    expect(failure).toMatchObject({
      kind: "answer-invalid",
      fields: [{ field: "slot", reason: "invalid" }],
    });
    expect(observed.sent).toEqual([]);
  });
}

function refusesASecondAnswerToTheSameRequest() {
  return Effect.gen(function* () {
    const layer = yield* makeLayer(newObserved());
    yield* classifyPost(layer, requestPost("agent:bob", 60_000));
    const decline = {
      to: "agent:bob",
      collectiveResponse: { action: "decline" },
    };
    yield* send(layer, decline);

    expect(yield* collectiveFailureOf(send(layer, decline))).toEqual({
      kind: "request-answered",
    });
  });
}

function reportsAnUnmatchedAnswerInTheConversationItWasSentTo() {
  const observed = newObserved();

  return Effect.gen(function* () {
    const layer = yield* makeLayer(observed);
    const outcome = yield* send(
      layer,
      { to: "agent:bob", collectiveResponse: { action: "decline" } },
      "inbound",
    );

    expect(observed.sent).toEqual([]);
    expect(observed.emitted).toMatchObject([
      {
        kind: "operationFailed",
        id: outcome.operationId,
        to: "agent:bob",
      },
    ]);
  });
}

function refusesAnAnswerAfterTheRequestSDeadline() {
  return Effect.gen(function* () {
    const layer = yield* makeLayer(newObserved());
    yield* classifyPost(layer, requestPost("agent:bob", 60_000));
    yield* TestClock.adjust(Duration.seconds(60));
    const failure = yield* collectiveFailureOf(
      send(layer, {
        to: "agent:bob",
        collectiveResponse: { action: "decline" },
      }),
    );

    expect(failure).toEqual({ kind: "request-expired" });
  });
}

// @agent-code-guard/regression-only: examples pin how a member answers a request.
describe("collective responses", () => {
  it(
    "posts a valid answer to the request open in the requester's direct conversation",
    postsAValidAnswerToTheRequesterSDirectConversation,
  );

  it(
    "refuses an answer that fails the request's schema, naming the field",
    refusesAnAnswerThatFailsTheRequestSSchemaNamingTheField,
  );

  it(
    "refuses a second answer to the same request",
    refusesASecondAnswerToTheSameRequest,
  );

  it(
    "reports an unmatched answer inbound in the conversation it was sent to",
    reportsAnUnmatchedAnswerInTheConversationItWasSentTo,
  );

  it(
    "refuses an answer after the request's deadline",
    refusesAnAnswerAfterTheRequestSDeadline,
  );
});
