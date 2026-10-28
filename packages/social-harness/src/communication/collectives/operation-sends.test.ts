/** @file Pins the posts each collective send certifies and the refusals it returns. */

import { scoped as it } from "@effect/vitest";
import { Duration, Effect, Fiber, TestClock } from "effect";
import { describe, expect } from "vitest";
import {
  alice,
  answerPost,
  classifyPost,
  collectiveFailureOf,
  collectiveKey,
  firstRequestOf,
  gatherInput,
  gatherTo,
  latePostDelay,
  makeLayer,
  multicastPart,
  newObserved,
  operationIdOf,
  postId,
  questionText,
  requestSendWait,
  send,
  slotSchema,
  startGather,
} from "../../__tests__/collective-operation-fixtures.js";
import { SendError } from "../conversations/errors.js";
import { collectiveIdOf } from "./part/index.js";

/** What a send that failed after queueing its post says about it. */
const queuedText =
  "the message is pending and Social Harness will still deliver it";

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

function returnsAMulticastSPostAndItsCanonicalConversationAddress() {
  const observed = newObserved();

  return Effect.gen(function* () {
    const layer = yield* makeLayer(observed);
    const direct = yield* send(layer, { to: "agent:bob", text: "Hello" });
    const group = yield* send(layer, {
      to: "group:carol,bob",
      text: "Hello both",
    });

    expect(direct).toMatchObject({
      postId: postId(101),
      address: "agent:bob",
    });
    expect(group).toMatchObject({
      postId: postId(102),
      address: "group:alice,bob,carol",
    });
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

function fansAGatherOutAsOneRequestPostPerMemberButTheRequester() {
  const observed = newObserved();

  return Effect.gen(function* () {
    const layer = yield* makeLayer(observed);
    const id = yield* startGather(layer);
    const { nonce } = yield* firstRequestOf(observed);

    expect(collectiveIdOf(alice, nonce)).toBe(id);
    expect(observed.sent.map((post) => post.to)).toEqual([
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
            id,
            nonce,
            deadlineAt: 60_000,
            requestedSchema: slotSchema,
          },
        },
      },
    ]);
  });
}

function refusesAGatherWithAnUnknownMemberBeforeAnyPost() {
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
 * A refused post makes its member `no-answer`; a post still certifying when
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
    const { id } = yield* firstRequestOf(observed);

    expect(outcome).toEqual({ postIds: [postId(101)], operationId: id });
    expect(observed.sent.map((post) => post.to)).toEqual(["agent:bob"]);

    yield* classifyPost(
      layer,
      answerPost("agent:bob", id, { action: "decline" }),
    );

    expect(observed.emitted).toEqual([]);

    yield* TestClock.adjust(Duration.seconds(60));

    expect(observed.emitted).toEqual([
      {
        kind: "collectiveResult",
        op: "gather",
        id,
        to: "group:alice,bob,carol,dave",
        question: questionText,
        outcomes: [
          { member: "agent:bob", outcome: { kind: "declined" } },
          { member: "agent:carol", outcome: { kind: "no-answer" } },
          { member: "agent:dave", outcome: { kind: "no-answer" } },
        ],
      },
    ]);
  });
}

/** A post certified after the send stopped waiting still asks its member. */
function countsAnAnswerToAPostCertifiedAfterTheWait() {
  const observed = newObserved();

  return Effect.gen(function* () {
    const layer = yield* makeLayer(observed, {
      refused: { "agent:carol": "late" },
    });
    const sending = yield* Effect.fork(send(layer, gatherInput()));
    yield* TestClock.adjust(requestSendWait);
    const outcome = yield* Fiber.join(sending);
    yield* TestClock.adjust(latePostDelay);
    const id = yield* operationIdOf(outcome);
    yield* classifyPost(
      layer,
      answerPost("agent:bob", id, { action: "decline" }),
    );
    yield* classifyPost(
      layer,
      answerPost("agent:carol", id, {
        action: "accept",
        content: { slot: "tue" },
      }),
    );

    expect(observed.sent.map((post) => post.to)).toEqual([
      "agent:bob",
      "agent:carol",
    ]);
    expect(observed.emitted).toMatchObject([
      {
        kind: "collectiveResult",
        op: "gather",
        outcomes: [
          { member: "agent:bob", outcome: { kind: "declined" } },
          {
            member: "agent:carol",
            outcome: { kind: "answered", content: { slot: "tue" } },
          },
        ],
      },
    ]);
  });
}

function failsAGatherNoneOfWhosePostsWasDelivered() {
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
 * Request posts that failed after they were queued still reach their
 * members, so the refusal says so rather than that they were not sent.
 */
function saysEachMemberIsStillSentAQueuedRequestPost() {
  return Effect.gen(function* () {
    const layer = yield* makeLayer(newObserved(), {
      sendPost: () =>
        Effect.fail(new SendError({ reason: "delivery-pending" })),
    });
    const refusal = yield* Effect.flip(send(layer, gatherInput()));

    expect(refusal.message).toBe(
      `send failed: agent:bob could not be reached: ${queuedText}; agent:carol could not be reached: ${queuedText}`,
    );
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

function emitsARefusedGatherAsAnOperationFailedItemWhenFailuresGoInbound() {
  const observed = newObserved();

  return Effect.gen(function* () {
    const layer = yield* makeLayer(observed, { unknown: ["agent:carol"] });
    const outcome = yield* send(layer, gatherInput(), "inbound");

    expect(observed.emitted).toEqual([
      {
        kind: "operationFailed",
        id: outcome.operationId,
        to: gatherTo,
        error: "send failed: agent:carol is not a known agent",
      },
    ]);
  });
}

function asksTheOneAgentOfAGroupAddressNamingOneOtherAgent() {
  const observed = newObserved();

  return Effect.gen(function* () {
    const layer = yield* makeLayer(observed);
    yield* send(layer, { ...gatherInput(), to: "group:bob" });

    expect(observed.sent.map((post) => post.to)).toEqual(["agent:bob"]);
  });
}

function refusesAGatherToAGroupThatNamesAMemberTwice() {
  const observed = newObserved();

  return Effect.gen(function* () {
    const layer = yield* makeLayer(observed);
    const failure = yield* collectiveFailureOf(
      send(layer, { ...gatherInput(), to: "group:bob,carol,bob" }),
    );

    expect(failure).toMatchObject({ reason: "membership-invalid" });
    expect(observed.sent).toEqual([]);
  });
}

function asksTheOneAgentOfAnAgentAddress() {
  const observed = newObserved();

  return Effect.gen(function* () {
    const layer = yield* makeLayer(observed);
    yield* send(layer, { ...gatherInput(), to: "agent:bob" });

    expect(observed.sent.map((post) => post.to)).toEqual(["agent:bob"]);
  });
}

// @agent-code-guard/regression-only: examples pin the posts each operation certifies.
describe("collective sends", () => {
  it(
    "certifies a multicast as its text and an explicit multicast part",
    certifiesAMulticastAsItsTextAndAnExplicitMulticastPart,
  );

  it(
    "returns a multicast's post and its canonical conversation address",
    returnsAMulticastSPostAndItsCanonicalConversationAddress,
  );

  it(
    "fails a multicast whose text and part exceed the content limit",
    failsAMulticastWhoseTextAndPartExceedTheContentLimit,
  );

  it(
    "fans a gather out as one request post per member but the requester",
    fansAGatherOutAsOneRequestPostPerMemberButTheRequester,
  );

  it(
    "refuses a gather with an unknown member before posting to anyone",
    refusesAGatherWithAnUnknownMemberBeforeAnyPost,
  );
  it(
    "continues a gather past refused and pending members, which end as no-answer",
    continuesAGatherPastMembersItCouldNotReach,
  );
  it(
    "counts an answer to a request post certified after the wait",
    countsAnAnswerToAPostCertifiedAfterTheWait,
  );
  it(
    "fails a gather none of whose request posts was delivered",
    failsAGatherNoneOfWhosePostsWasDelivered,
  );
  it(
    "says each member is still sent a request post that failed once queued",
    saysEachMemberIsStillSentAQueuedRequestPost,
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
    "emits a refused gather as an operationFailed item when failures go inbound",
    emitsARefusedGatherAsAnOperationFailedItemWhenFailuresGoInbound,
  );
});

// @agent-code-guard/regression-only: examples pin that a gather shares the send address rule.
describe("gather addressing", () => {
  it(
    "asks the one agent of a group address naming one other agent",
    asksTheOneAgentOfAGroupAddressNamingOneOtherAgent,
  );

  it(
    "refuses a gather to a group that names a member twice",
    refusesAGatherToAGroupThatNamesAMemberTwice,
  );

  it("asks the one agent of an agent address", asksTheOneAgentOfAnAgentAddress);
});
