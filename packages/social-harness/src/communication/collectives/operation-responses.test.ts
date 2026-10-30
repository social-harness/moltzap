/** @file Pins how a member answers a gather request it received. */

import { scoped as it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { describe, expect } from "vitest";
import { testAgentView } from "../../__tests__/agent-card-fixtures.js";
import { collectiveOperationId } from "../../__tests__/collective-id-fixtures.js";
import {
  classifyMessage,
  collectiveFailureOf,
  collectiveKey,
  directMessage,
  makeLayer,
  msgId,
  newObserved,
  questionText,
  requestId,
  requestMessage,
  send,
  slotSchema,
} from "../../__tests__/collective-operation-fixtures.js";
import { AgentAddress } from "../records/values.js";

const bob = Schema.decodeUnknownSync(AgentAddress)("agent:bob");

/** A second gather Bob asks in the same direct conversation, open for a minute. */
const secondRequestId = collectiveOperationId(testAgentView(bob).agentId, 1);
const secondRequestMessage = directMessage("agent:bob", [
  { type: "text", text: questionText },
  {
    type: "data",
    value: {
      [collectiveKey]: {
        kind: "operation",
        op: "gather",
        operationId: secondRequestId,
        deadlineAt: 60_000,
        requestedSchema: slotSchema,
      },
    },
  },
]);

/** The data part of a response message answering `operationId`. */
const responsePart = (operationId: string, answer: object) => ({
  type: "data",
  value: { [collectiveKey]: { kind: "response", operationId, ...answer } },
});

function sendsAValidAnswerToTheRequesterSDirectConversation() {
  const observed = newObserved();

  return Effect.gen(function* () {
    const layer = yield* makeLayer(observed);
    yield* classifyMessage(layer, requestMessage("agent:bob", 60_000));
    yield* send(layer, {
      to: "agent:bob",
      collectiveResponse: {
        operationId: requestId,
        action: "accept",
        content: { slot: "mon" },
      },
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
                operationId: requestId,
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

function returnsTheAnswerSMessageAndTheRequestItAnswered() {
  const observed = newObserved();

  return Effect.gen(function* () {
    const layer = yield* makeLayer(observed);
    yield* classifyMessage(layer, requestMessage("agent:bob", 60_000));
    const sent = yield* send(layer, {
      to: "agent:bob",
      collectiveResponse: { operationId: requestId, action: "decline" },
    });

    expect(sent).toMatchObject({
      operationId: requestId,
      msgId: msgId(101),
      address: "agent:bob",
    });
  });
}

function refusesAnAnswerThatFailsTheRequestSSchemaNamingTheField() {
  const observed = newObserved();

  return Effect.gen(function* () {
    const layer = yield* makeLayer(observed);
    yield* classifyMessage(layer, requestMessage("agent:bob", 60_000));
    const failure = yield* collectiveFailureOf(
      send(layer, {
        to: "agent:bob",
        collectiveResponse: {
          operationId: requestId,
          action: "accept",
          content: { slot: "sun" },
        },
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
    yield* classifyMessage(layer, requestMessage("agent:bob", 60_000));
    const decline = {
      to: "agent:bob",
      collectiveResponse: { operationId: requestId, action: "decline" },
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
        collectiveResponse: { operationId: requestId, action: "decline" },
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
    yield* classifyMessage(layer, requestMessage("agent:bob", 60_000));
    yield* classifyMessage(layer, secondRequestMessage);
    yield* send(layer, {
      to: "agent:bob",
      collectiveResponse: {
        operationId: secondRequestId,
        action: "decline",
      },
    });
    yield* send(layer, {
      to: "agent:bob",
      collectiveResponse: {
        action: "accept",
        operationId: requestId,
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

// @agent-code-guard/regression-only: examples pin how a member answers a request.
describe("collective responses", () => {
  it(
    "sends a valid answer to the request open in the requester's direct conversation",
    sendsAValidAnswerToTheRequesterSDirectConversation,
  );

  it(
    "returns the answer's message, its conversation and the request it answered",
    returnsTheAnswerSMessageAndTheRequestItAnswered,
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
    "answers each of two open requests in one conversation by its operationId",
    answersEachOfTwoOpenRequestsByItsId,
  );
});
