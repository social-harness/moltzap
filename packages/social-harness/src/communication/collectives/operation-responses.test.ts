/** @file Pins how a member answers a gather request it received. */

import { scoped as it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { describe, expect } from "vitest";
import {
  classifyPost,
  collectiveFailureOf,
  collectiveKey,
  directPost,
  makeLayer,
  newObserved,
  postId,
  questionText,
  requestId,
  requestPost,
  send,
  slotSchema,
} from "../../__tests__/collective-operation-fixtures.js";
import { AgentAddress } from "../records/values.js";
import { CollectiveError } from "./forms.js";
import { collectiveIdOf } from "./part/index.js";

const bob = Schema.decodeUnknownSync(AgentAddress)("agent:bob");

/** A second gather Bob asks in the same direct conversation, open for a minute. */
const secondNonce = "S".repeat(43);
const secondRequestId = collectiveIdOf(bob, secondNonce);
const secondRequestPost = directPost("agent:bob", [
  { type: "text", text: questionText },
  {
    type: "data",
    value: {
      [collectiveKey]: {
        kind: "operation",
        op: "gather",
        id: secondRequestId,
        nonce: secondNonce,
        deadlineAt: 60_000,
        requestedSchema: slotSchema,
      },
    },
  },
]);

/** The data part of a response post answering `id`. */
const responsePart = (id: string, answer: object) => ({
  type: "data",
  value: { [collectiveKey]: { kind: "response", id, ...answer } },
});

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

function returnsTheAnswerSPostAndTheRequestItAnswered() {
  const observed = newObserved();

  return Effect.gen(function* () {
    const layer = yield* makeLayer(observed);
    yield* classifyPost(layer, requestPost("agent:bob", 60_000));
    const sent = yield* send(layer, {
      to: "agent:bob",
      collectiveResponse: { action: "decline" },
    });

    expect(sent).toMatchObject({
      operationId: requestId,
      postId: postId(101),
      address: "agent:bob",
    });
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

function refusesAnAnswerWithoutAnOpenRequest() {
  const observed = newObserved();

  return Effect.gen(function* () {
    const layer = yield* makeLayer(observed);
    const failure = yield* collectiveFailureOf(
      send(layer, {
        to: "agent:bob",
        collectiveResponse: { action: "decline" },
      }),
    );

    expect(failure).toEqual({ kind: "request-none" });
    expect(observed.sent).toEqual([]);
    expect(observed.emitted).toEqual([]);
  });
}

function answersEachOfTwoOpenRequestsByItsId() {
  const observed = newObserved();

  return Effect.gen(function* () {
    const layer = yield* makeLayer(observed);
    yield* classifyPost(layer, requestPost("agent:bob", 60_000));
    yield* classifyPost(layer, secondRequestPost);
    yield* send(layer, {
      to: "agent:bob",
      collectiveResponse: { action: "decline", id: secondRequestId },
    });
    yield* send(layer, {
      to: "agent:bob",
      collectiveResponse: {
        action: "accept",
        id: requestId,
        content: { slot: "mon" },
      },
    });

    expect(observed.sent).toEqual([
      {
        to: "agent:bob",
        content: [responsePart(secondRequestId, { action: "decline" })],
      },
      {
        to: "agent:bob",
        content: [
          responsePart(requestId, {
            action: "accept",
            content: { slot: "mon" },
          }),
        ],
      },
    ]);
  });
}

function refusesAnAnswerNamingNoRequestWhileTwoAreOpen() {
  const observed = newObserved();

  return Effect.gen(function* () {
    const layer = yield* makeLayer(observed);
    yield* classifyPost(layer, requestPost("agent:bob", 60_000));
    yield* classifyPost(layer, secondRequestPost);
    const refused = yield* Effect.flip(
      send(layer, {
        to: "agent:bob",
        collectiveResponse: { action: "decline" },
      }),
    );

    expect(refused).toBeInstanceOf(CollectiveError);
    expect(refused.message).toContain(requestId);
    expect(refused.message).toContain(secondRequestId);
    expect(observed.sent).toEqual([]);
  });
}

// @agent-code-guard/regression-only: examples pin how a member answers a request.
describe("collective responses", () => {
  it(
    "posts a valid answer to the request open in the requester's direct conversation",
    postsAValidAnswerToTheRequesterSDirectConversation,
  );

  it(
    "returns the answer's post, its conversation and the request it answered",
    returnsTheAnswerSPostAndTheRequestItAnswered,
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
    refusesAnAnswerWithoutAnOpenRequest,
  );

  it(
    "answers each of two open requests in one conversation by its id",
    answersEachOfTwoOpenRequestsByItsId,
  );

  it(
    "refuses an answer that names no request while two are open, listing both ids",
    refusesAnAnswerNamingNoRequestWhileTwoAreOpen,
  );
});
