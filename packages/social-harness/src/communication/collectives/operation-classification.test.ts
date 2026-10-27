/** @file Pins which certified posts reach the subscriber, in what form, and which received requests a member keeps. */

import { scoped as it } from "@effect/vitest";
import { Duration, Effect, Option, TestClock } from "effect";
import { describe, expect } from "vitest";
import {
  classifyPost,
  collectiveKey,
  directPost,
  makeLayer,
  multicastPart,
  newObserved,
  postId,
  questionText,
  requestId,
  requestNonce,
  requestPost,
  slotSchema,
} from "../../__tests__/collective-operation-fixtures.js";
import { decodeCollectiveValue } from "./part/index.js";

function deliversAMulticastWithoutItsCollectivePart() {
  return Effect.gen(function* () {
    const layer = yield* makeLayer(newObserved());
    const item = yield* classifyPost(
      layer,
      directPost("agent:bob", [{ type: "text", text: "Hello" }, multicastPart]),
    );

    expect(item).toEqual(
      Option.some({
        kind: "multicast",
        message: directPost("agent:bob", [{ type: "text", text: "Hello" }]),
      }),
    );
  });
}

function deliversAPostWithoutACollectivePartAsAMulticast() {
  const post = directPost("agent:bob", [{ type: "text", text: "Hello" }]);

  return Effect.gen(function* () {
    const layer = yield* makeLayer(newObserved());

    expect(yield* classifyPost(layer, post)).toEqual(
      Option.some({ kind: "multicast", message: post }),
    );
  });
}

function consumesAPostWhoseCollectivePartIsMalformed() {
  return Effect.gen(function* () {
    const layer = yield* makeLayer(newObserved());
    const item = yield* classifyPost(
      layer,
      directPost("agent:bob", [
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
      yield* classifyPost(layer, directPost("agent:bob", [multicastPart])),
    ).toEqual(Option.none());
  });
}

function consumesAPostThatCarriesTwoCollectiveParts() {
  return Effect.gen(function* () {
    const layer = yield* makeLayer(newObserved());
    const item = yield* classifyPost(
      layer,
      directPost("agent:bob", [
        { type: "text", text: "Hello" },
        multicastPart,
        multicastPart,
      ]),
    );

    expect(item).toEqual(Option.none());
  });
}

function consumesACloseForAnAllGatherThisEndpointWasNotAsked() {
  const close = { kind: "close", id: requestId, included: [] };

  return Effect.gen(function* () {
    yield* decodeCollectiveValue(close);
    const layer = yield* makeLayer(newObserved());
    const item = yield* classifyPost(
      layer,
      directPost("agent:bob", [
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
    id: requestId,
    nonce: requestNonce,
    deadlineAt: 60_000,
    requestedSchema: slotSchema,
  };

  return Effect.gen(function* () {
    yield* decodeCollectiveValue(request);
    const layer = yield* makeLayer(newObserved());
    const item = yield* classifyPost(
      layer,
      directPost("agent:bob", [
        { type: "text", text: questionText },
        { type: "data", value: { [collectiveKey]: request } },
      ]),
    );

    expect(item).toEqual(Option.none());
  });
}

function deliversARequestPostAsACollectiveRequestItem() {
  return Effect.gen(function* () {
    const layer = yield* makeLayer(newObserved());
    const item = yield* classifyPost(layer, requestPost("agent:bob", 60_000));

    expect(item).toEqual(
      Option.some({
        kind: "collectiveRequest",
        op: "gather",
        id: requestId,
        postId: postId(9),
        from: "agent:bob",
        to: "agent:bob",
        question: questionText,
        requestedSchema: slotSchema,
        deadlineAt: 60_000,
      }),
    );
  });
}

function consumesARequestPostWhoseDeadlineHasPassed() {
  return Effect.gen(function* () {
    const layer = yield* makeLayer(newObserved());
    yield* TestClock.adjust(Duration.seconds(61));

    expect(
      yield* classifyPost(layer, requestPost("agent:bob", 60_000)),
    ).toEqual(Option.none());
  });
}

function consumesARequestWhoseIdDoesNotDeriveFromItsSender() {
  return Effect.gen(function* () {
    const layer = yield* makeLayer(newObserved());
    const takenOver = yield* classifyPost(
      layer,
      requestPost("agent:mallory", 60_000),
    );
    const honest = yield* classifyPost(layer, requestPost("agent:bob", 60_000));

    expect(takenOver).toEqual(Option.none());
    expect(Option.isSome(honest)).toBe(true);
  });
}

function consumesARequestWhoseDeadlineLiesBeyondTheLongestAGatherStates() {
  return Effect.gen(function* () {
    const layer = yield* makeLayer(newObserved());
    const item = yield* classifyPost(
      layer,
      requestPost("agent:bob", Duration.toMillis(Duration.days(31)) + 1),
    );

    expect(item).toEqual(Option.none());
  });
}

// @agent-code-guard/regression-only: examples pin which certified posts reach the subscriber and in what form.
describe("inbound classification", () => {
  it(
    "delivers a multicast without its collective part",
    deliversAMulticastWithoutItsCollectivePart,
  );

  it(
    "delivers a post without a collective part as a multicast",
    deliversAPostWithoutACollectivePartAsAMulticast,
  );

  it(
    "consumes a post whose collective part is malformed",
    consumesAPostWhoseCollectivePartIsMalformed,
  );

  it(
    "consumes a multicast whose only part is the collective part",
    consumesAMulticastWhoseOnlyPartIsTheCollectivePart,
  );

  it(
    "consumes a post that carries two collective parts",
    consumesAPostThatCarriesTwoCollectiveParts,
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
    "delivers a request post as a collectiveRequest item",
    deliversARequestPostAsACollectiveRequestItem,
  );

  it(
    "consumes a request post whose deadline has passed",
    consumesARequestPostWhoseDeadlineHasPassed,
  );
});

// @agent-code-guard/regression-only: examples pin which received requests a member keeps.
describe("received request checks", () => {
  it(
    "consumes a request whose id does not derive from its sender",
    consumesARequestWhoseIdDoesNotDeriveFromItsSender,
  );

  it(
    "consumes a request whose deadline lies beyond the longest a gather states",
    consumesARequestWhoseDeadlineLiesBeyondTheLongestAGatherStates,
  );
});
