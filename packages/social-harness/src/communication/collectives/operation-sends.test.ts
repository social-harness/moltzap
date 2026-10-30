/** @file Pins the messages each collective send certifies, what it returns, and how it is refused. */

import { scoped as it } from "@effect/vitest";
import { Duration, Effect, Fiber, TestClock } from "effect";
import { describe, expect } from "vitest";
import { testAgentView } from "../../__tests__/agent-card-fixtures.js";
import {
  alice,
  answerMessage,
  classifyMessage,
  collectiveFailureOf,
  collectiveKey,
  firstRequestOf,
  gatherInput,
  lateMessageDelay,
  makeLayer,
  msgId,
  multicastPart,
  newObserved,
  operationIdOf,
  questionText,
  requestSendWait,
  send,
  slotSchema,
  startGather,
} from "../../__tests__/collective-operation-fixtures.js";
import { SendError } from "../conversations/errors.js";
import { collectiveRequesterOf } from "./wire/index.js";

function certifiesAMulticastAsItsTextAndAnExplicitMulticastPart() {
  const observed = newObserved();

  return Effect.gen(function* () {
    const layer = yield* makeLayer(observed);
    yield* send(layer, { to: "agent:bob", text: "Hello" });

    expect(observed.sent).toEqual([
      {
        to: "agent:bob",
        content: [{ type: "text", text: "Hello" }, multicastPart],
      },
    ]);
  });
}

function returnsAGroupMulticastSCompleteCanonicalAddress() {
  return Effect.gen(function* () {
    const layer = yield* makeLayer(newObserved());
    const sent = yield* send(layer, { to: "group:carol,bob", text: "Hi" });

    expect(sent).toMatchObject({ address: "group:alice,bob,carol" });
  });
}

function failsAMulticastWhoseTextAndPartExceedTheContentLimit() {
  const observed = newObserved();

  return Effect.gen(function* () {
    const layer = yield* makeLayer(observed);
    const failure = yield* collectiveFailureOf(
      send(layer, { to: "agent:bob", text: "a".repeat(32_741) }),
    );

    expect(failure).toMatchObject({ reason: "content-invalid" });
  });
}

function fansAGatherOutAsOneRequestMessagePerMemberButTheRequester() {
  const observed = newObserved();

  return Effect.gen(function* () {
    const layer = yield* makeLayer(observed);
    const operationId = yield* startGather(layer);
    const request = yield* firstRequestOf(observed);

    expect(request.operationId).toBe(operationId);
    expect(collectiveRequesterOf(operationId)).toBe(
      testAgentView(alice).agentId,
    );
    expect(observed.sent.map((message) => message.to)).toEqual([
      "agent:bob",
      "agent:carol",
    ]);
    expect(observed.sent[0]?.content).toEqual([
      { type: "text", text: questionText },
      {
        type: "data",
        value: {
          [collectiveKey]: {
            kind: "operation",
            op: "gather",
            operationId,
            deadlineAt: 60_000,
            requestedSchema: slotSchema,
          },
        },
      },
    ]);
  });
}

function refusesAGatherWithAnUnknownMemberBeforeAnyMessage() {
  const observed = newObserved();

  return Effect.gen(function* () {
    const layer = yield* makeLayer(observed, {
      unknown: ["agent:carol"],
    });
    const failure = yield* collectiveFailureOf(send(layer, gatherInput()));

    expect(failure).toEqual({
      kind: "members-unreachable",
      members: [{ member: "agent:carol", reason: "unknown-agent" }],
    });
    expect(observed.sent).toEqual([]);
  });
}

/**
 * A refused message makes its member `no-answer`; a message still certifying when
 * the send returns leaves its member `no-answer` only if it is still pending
 * at the deadline. The send reports neither: the result does.
 */
function continuesAGatherPastMembersItCouldNotReach() {
  const observed = newObserved();

  return Effect.gen(function* () {
    const layer = yield* makeLayer(observed, {
      refused: { "agent:carol": "network-unavailable", "agent:dave": "slow" },
    });
    const sending = yield* Effect.fork(
      send(layer, { ...gatherInput(), to: "group:alice,bob,carol,dave" }),
    );
    yield* TestClock.adjust(requestSendWait);
    const outcome = yield* Fiber.join(sending);
    const { operationId } = yield* firstRequestOf(observed);

    expect(outcome).toEqual({
      kind: "collective",
      msgIds: [msgId(101)],
      operationId,
    });
    expect(observed.sent.map((message) => message.to)).toEqual(["agent:bob"]);

    yield* classifyMessage(
      layer,
      answerMessage("agent:bob", operationId, { action: "decline" }),
    );

    expect(observed.emitted).toEqual([]);

    yield* TestClock.adjust(Duration.seconds(60));

    expect(observed.emitted).toEqual([
      {
        kind: "collectiveResult",
        closedAt: 60_000,
        closedBy: "deadline",
        op: "gather",
        operationId,
        to: "group:alice,bob,carol,dave",
        question: questionText,
        outcomes: [
          { member: testAgentView("agent:bob"), outcome: { kind: "declined" } },
          {
            member: testAgentView("agent:carol"),
            outcome: { kind: "no-answer" },
          },
          {
            member: testAgentView("agent:dave"),
            outcome: { kind: "no-answer" },
          },
        ],
      },
    ]);
  });
}

/** A message certified after the send stopped waiting still asks its member. */
function countsAnAnswerToAMessageCertifiedAfterTheWait() {
  const observed = newObserved();

  return Effect.gen(function* () {
    const layer = yield* makeLayer(observed, {
      refused: { "agent:carol": "late" },
    });
    const sending = yield* Effect.fork(send(layer, gatherInput()));
    yield* TestClock.adjust(requestSendWait);
    const outcome = yield* Fiber.join(sending);
    yield* TestClock.adjust(lateMessageDelay);
    const operationId = yield* operationIdOf(outcome);
    yield* classifyMessage(
      layer,
      answerMessage("agent:bob", operationId, { action: "decline" }),
    );
    yield* classifyMessage(
      layer,
      answerMessage("agent:carol", operationId, {
        action: "accept",
        content: { slot: "tue" },
      }),
    );

    expect(observed.sent.map((message) => message.to)).toEqual([
      "agent:bob",
      "agent:carol",
    ]);
    expect(observed.emitted).toMatchObject([
      {
        kind: "collectiveResult",
        op: "gather",
        outcomes: [
          { member: testAgentView("agent:bob"), outcome: { kind: "declined" } },
          {
            member: testAgentView("agent:carol"),
            outcome: { kind: "answered", content: { slot: "tue" } },
          },
        ],
      },
    ]);
  });
}

function failsAGatherNoneOfWhoseMessagesWasDelivered() {
  const observed = newObserved();

  return Effect.gen(function* () {
    const layer = yield* makeLayer(observed, {
      refused: {
        "agent:bob": "network-unavailable",
        "agent:carol": "persistence-failed",
      },
    });
    const failure = yield* collectiveFailureOf(send(layer, gatherInput()));
    yield* TestClock.adjust(Duration.seconds(60));

    expect(failure).toEqual({
      kind: "members-unreachable",
      members: [
        { member: "agent:bob", reason: "network-unavailable" },
        { member: "agent:carol", reason: "persistence-failed" },
      ],
    });
    expect(observed.emitted).toEqual([]);
  });
}

/**
 * Request messages that failed after they were queued still reach their
 * members, so the refusal says so rather than that they were not sent.
 */
function saysEachMemberIsStillSentAQueuedRequestMessage() {
  return Effect.gen(function* () {
    const observed = newObserved();
    const layer = yield* makeLayer(observed, {
      sendMessage: () =>
        Effect.fail(new SendError({ reason: "delivery-pending" })),
    });
    const outcome = yield* send(layer, gatherInput());
    expect(outcome).toMatchObject({ kind: "collective" });
    yield* TestClock.adjust(Duration.seconds(60));
    expect(observed.emitted).toMatchObject([
      { kind: "collectiveResult", operationId: outcome.operationId },
    ]);
  });
}

function failsAGatherWhoseSchemaIsOutsideTheFormModeGrammar() {
  const observed = newObserved();

  return Effect.gen(function* () {
    const layer = yield* makeLayer(observed);
    const failure = yield* collectiveFailureOf(
      send(
        layer,
        gatherInput(60, {
          type: "object",
          properties: { slot: { type: "object" } },
        }),
      ),
    );

    expect(failure).toMatchObject({ kind: "schema-invalid" });
    expect(observed.sent).toEqual([]);
  });
}

/**
 * A multi-select whose `items` omit `"type":"string"` is the form requesters
 * most often get wrong, so the refusal names the property, the keyword and
 * the shape that would pass.
 */
function namesTheFailingKeywordAndTheExpectedShapeOfAnInvalidProperty() {
  const observed = newObserved();

  return Effect.gen(function* () {
    const layer = yield* makeLayer(observed);
    const failure = yield* collectiveFailureOf(
      send(
        layer,
        gatherInput(60, {
          type: "object",
          properties: {
            note: { type: "string" },
            slots: { type: "array", items: { enum: ["mon", "tue"] } },
          },
        }),
      ),
    );

    expect(failure).toEqual({
      kind: "schema-invalid",
      detail:
        'properties.slots: items.type: Invalid input: expected "string"; a multi-select is {"type":"array","items":{"type":"string","enum":["a","b"]}}',
    });
  });
}

function namesTheUndeclaredRequiredField() {
  const observed = newObserved();

  return Effect.gen(function* () {
    const layer = yield* makeLayer(observed);
    const failure = yield* collectiveFailureOf(
      send(
        layer,
        gatherInput(60, {
          type: "object",
          properties: { note: { type: "string" } },
          required: ["slot"],
        }),
      ),
    );

    expect(failure).toEqual({
      kind: "schema-invalid",
      detail: 'required: names "slot", which properties does not declare',
    });
  });
}

function returnsAnInvalidGatherAsARefusal() {
  const observed = newObserved();

  return Effect.gen(function* () {
    const layer = yield* makeLayer(observed, { unknown: ["agent:carol"] });
    const failure = yield* collectiveFailureOf(send(layer, gatherInput()));

    expect(failure).toMatchObject({
      kind: "members-unreachable",
      members: [{ member: "agent:carol", reason: "unknown-agent" }],
    });
    expect(observed.emitted).toEqual([]);
  });
}

function asksTheOneAgentOfAGroupAddressNamingOneOtherAgent() {
  const observed = newObserved();

  return Effect.gen(function* () {
    const layer = yield* makeLayer(observed);
    yield* send(layer, { ...gatherInput(), to: "group:bob" });

    expect(observed.sent.map((message) => message.to)).toEqual(["agent:bob"]);
  });
}

// @agent-code-guard/regression-only: examples pin the messages each operation certifies.
describe("collective sends", () => {
  it(
    "certifies a multicast as its text and an explicit multicast part",
    certifiesAMulticastAsItsTextAndAnExplicitMulticastPart,
  );

  it(
    "fails a multicast whose text and part exceed the content limit",
    failsAMulticastWhoseTextAndPartExceedTheContentLimit,
  );

  it(
    "fans a gather out as one request message per member but the requester",
    fansAGatherOutAsOneRequestMessagePerMemberButTheRequester,
  );

  it(
    "refuses a gather with an unknown member before sending to anyone",
    refusesAGatherWithAnUnknownMemberBeforeAnyMessage,
  );
  it(
    "continues a gather past refused and pending members, which end as no-answer",
    continuesAGatherPastMembersItCouldNotReach,
  );
  it(
    "counts an answer to a request message certified after the wait",
    countsAnAnswerToAMessageCertifiedAfterTheWait,
  );
  it(
    "fails a gather none of whose request messages was delivered",
    failsAGatherNoneOfWhoseMessagesWasDelivered,
  );
  it(
    "says each member is still sent a request message that failed once queued",
    saysEachMemberIsStillSentAQueuedRequestMessage,
  );

  it(
    "fails a gather whose schema is outside the form-mode grammar",
    failsAGatherWhoseSchemaIsOutsideTheFormModeGrammar,
  );

  it(
    "names the failing keyword and the expected shape of an invalid property",
    namesTheFailingKeywordAndTheExpectedShapeOfAnInvalidProperty,
  );

  it(
    "names a required field the schema does not declare",
    namesTheUndeclaredRequiredField,
  );

  it(
    "returns an invalid gather as a refusal",
    returnsAnInvalidGatherAsARefusal,
  );
});

// @agent-code-guard/regression-only: examples pin that sends share the canonical address rule.
describe("canonical addresses", () => {
  it(
    "asks the one agent of a group address naming one other agent",
    asksTheOneAgentOfAGroupAddressNamingOneOtherAgent,
  );

  it(
    "returns a group multicast's complete canonical address",
    returnsAGroupMulticastSCompleteCanonicalAddress,
  );
});
