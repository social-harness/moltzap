/** @file Pins which certified messages reach the subscriber, in what form, and which received requests a member keeps. */

import { scoped as it } from "@effect/vitest";
import { Duration, Effect, Option, TestClock } from "effect";
import { describe, expect } from "vitest";
import { testAgentView } from "../../__tests__/agent-card-fixtures.js";
import {
  classifyMessage,
  collectiveKey,
  directMessage,
  makeLayer,
  msgId,
  multicastPart,
  newObserved,
  questionText,
  requestId,
  requestMessage,
  slotSchema,
} from "../../__tests__/collective-operation-fixtures.js";
import { decodeCollectiveValue } from "./wire/index.js";

function deliversAMulticastWithoutItsCollectivePart() {
  return Effect.gen(function* () {
    const layer = yield* makeLayer(newObserved());
    const item = yield* classifyMessage(
      layer,
      directMessage("agent:bob", [
        { type: "text", text: "Hello" },
        multicastPart,
      ]),
    );

    expect(item).toEqual(
      Option.some({
        kind: "multicast",
        message: directMessage("agent:bob", [{ type: "text", text: "Hello" }]),
      }),
    );
  });
}

function deliversAMessageWithoutACollectivePartAsAMulticast() {
  const message = directMessage("agent:bob", [{ type: "text", text: "Hello" }]);

  return Effect.gen(function* () {
    const layer = yield* makeLayer(newObserved());

    expect(yield* classifyMessage(layer, message)).toEqual(
      Option.some({ kind: "multicast", message: message }),
    );
  });
}

function consumesAMessageWhoseCollectivePartIsMalformed() {
  return Effect.gen(function* () {
    const layer = yield* makeLayer(newObserved());
    const item = yield* classifyMessage(
      layer,
      directMessage("agent:bob", [
        { type: "text", text: "Hello" },
        { type: "data", value: { [collectiveKey]: { kind: "operation" } } },
      ]),
    );

    expect(item).toEqual(Option.none());
  });
}

function consumesAMulticastWhoseOnlyPartIsTheCollectivePart() {
  return Effect.gen(function* () {
    const layer = yield* makeLayer(newObserved());

    expect(
      yield* classifyMessage(
        layer,
        directMessage("agent:bob", [multicastPart]),
      ),
    ).toEqual(Option.none());
  });
}

function consumesAMessageThatCarriesTwoCollectiveParts() {
  return Effect.gen(function* () {
    const layer = yield* makeLayer(newObserved());
    const item = yield* classifyMessage(
      layer,
      directMessage("agent:bob", [
        { type: "text", text: "Hello" },
        multicastPart,
        multicastPart,
      ]),
    );

    expect(item).toEqual(Option.none());
  });
}

function consumesACloseForAnAllGatherThisEndpointWasNotAsked() {
  const close = {
    kind: "close",
    operationId: requestId,
    included: [],
    closedAt: 60_000,
    closedBy: "deadline",
  };

  return Effect.gen(function* () {
    yield* decodeCollectiveValue(close);
    const layer = yield* makeLayer(newObserved());
    const item = yield* classifyMessage(
      layer,
      directMessage("agent:bob", [
        { type: "data", value: { [collectiveKey]: close } },
      ]),
    );

    expect(item).toEqual(Option.none());
  });
}

function consumesAnAllGatherRequestInADirectConversation() {
  const request = {
    kind: "operation",
    op: "all_gather",
    operationId: requestId,
    deadlineAt: 60_000,
    requestedSchema: slotSchema,
  };

  return Effect.gen(function* () {
    yield* decodeCollectiveValue(request);
    const layer = yield* makeLayer(newObserved());
    const item = yield* classifyMessage(
      layer,
      directMessage("agent:bob", [
        { type: "text", text: questionText },
        { type: "data", value: { [collectiveKey]: request } },
      ]),
    );

    expect(item).toEqual(Option.none());
  });
}

function deliversARequestMessageAsACollectiveRequestItem() {
  return Effect.gen(function* () {
    const layer = yield* makeLayer(newObserved());
    const item = yield* classifyMessage(
      layer,
      requestMessage("agent:bob", 60_000),
    );

    expect(item).toEqual(
      Option.some({
        kind: "collectiveRequest",
        op: "gather",
        operationId: requestId,
        msgId: msgId(9),
        from: testAgentView("agent:bob"),
        to: "agent:bob",
        question: questionText,
        requestedSchema: slotSchema,
        deadlineAt: 60_000,
      }),
    );
  });
}

function consumesARequestMessageWhoseDeadlineHasPassed() {
  return Effect.gen(function* () {
    const layer = yield* makeLayer(newObserved());
    yield* TestClock.adjust(Duration.seconds(61));

    expect(
      yield* classifyMessage(layer, requestMessage("agent:bob", 60_000)),
    ).toEqual(Option.none());
  });
}

function rejectsAnOperationClaimedByAnotherRequester() {
  return Effect.gen(function* () {
    const layer = yield* makeLayer(newObserved());
    const takenOver = yield* classifyMessage(
      layer,
      requestMessage("agent:mallory", 60_000),
    );
    const honest = yield* classifyMessage(
      layer,
      requestMessage("agent:bob", 60_000),
    );

    expect(takenOver).toEqual(Option.none());
    expect(Option.isSome(honest)).toBe(true);
  });
}

function consumesARequestWhoseDeadlineLiesBeyondTheLongestAGatherStates() {
  return Effect.gen(function* () {
    const layer = yield* makeLayer(newObserved());
    const item = yield* classifyMessage(
      layer,
      requestMessage("agent:bob", Duration.toMillis(Duration.days(31)) + 1),
    );

    expect(item).toEqual(Option.none());
  });
}

// @agent-code-guard/regression-only: examples pin which certified messages reach the subscriber and in what form.
describe("inbound classification", () => {
  it(
    "delivers a multicast without its collective part",
    deliversAMulticastWithoutItsCollectivePart,
  );

  it(
    "delivers a message without a collective part as a multicast",
    deliversAMessageWithoutACollectivePartAsAMulticast,
  );

  it(
    "consumes a message whose collective part is malformed",
    consumesAMessageWhoseCollectivePartIsMalformed,
  );

  it(
    "consumes a multicast whose only part is the collective part",
    consumesAMulticastWhoseOnlyPartIsTheCollectivePart,
  );

  it(
    "consumes a message that carries two collective parts",
    consumesAMessageThatCarriesTwoCollectiveParts,
  );

  it(
    "consumes a close for an all_gather this endpoint was not asked",
    consumesACloseForAnAllGatherThisEndpointWasNotAsked,
  );

  it(
    "consumes an all_gather request in a direct conversation",
    consumesAnAllGatherRequestInADirectConversation,
  );

  it(
    "delivers a request message as a collectiveRequest item",
    deliversARequestMessageAsACollectiveRequestItem,
  );

  it(
    "consumes a request message whose deadline has passed",
    consumesARequestMessageWhoseDeadlineHasPassed,
  );
});

// @agent-code-guard/regression-only: examples pin which received requests a member keeps.
describe("received request checks", () => {
  it(
    "rejects an operation claimed by another requester",
    rejectsAnOperationClaimedByAnotherRequester,
  );

  it(
    "consumes a request whose deadline lies beyond the longest a gather states",
    consumesARequestWhoseDeadlineLiesBeyondTheLongestAGatherStates,
  );
});
