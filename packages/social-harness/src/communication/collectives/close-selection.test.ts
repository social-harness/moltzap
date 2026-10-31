/** @file A close selects each answer by its author and message id. */

import { scoped as it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { expect } from "vitest";
import type { TestCollectiveOperations } from "../../__tests__/collective-send.js";
import type { InboundItem } from "../../host-protocol/items.js";
import { testAgentView } from "../../__tests__/agent-card-fixtures.js";
import { collectiveOperationId } from "../../__tests__/collective-id-fixtures.js";
import {
  collectiveFailureOf,
  collectiveKey,
  makeLayer,
  msgId,
  newObserved,
  recordHashOf,
  send,
  slotSchema,
} from "../../__tests__/collective-operation-fixtures.js";
import { Message, type MessageReference } from "../message.js";

const group = "group:alice,bob,carol";
const groupMembers = ["agent:alice", "agent:bob", "agent:carol"];
const requestId = collectiveOperationId(testAgentView("alice").agentId);
const requestValue = {
  kind: "operation",
  op: "all_gather",
  operationId: requestId,
  deadlineAt: 60_000,
  requestedSchema: slotSchema,
};
const answer = (operationId: string, slot: string) => ({
  kind: "response",
  operationId,
  action: "accept",
  content: { slot },
});
const answerReference = (author: string, byte: number): MessageReference => ({
  authorAgentId: testAgentView(author).agentId,
  msgId: msgId(byte),
});
const close = (operationId: string, included: readonly MessageReference[]) => ({
  kind: "close",
  operationId,
  included,
  closedAt: 60_000,
  closedBy: "deadline",
});
const groupMessage = (author: string, byte: number, value: object) =>
  Schema.decodeUnknownSync(Message)({
    author: testAgentView(author),
    recipients: groupMembers
      .filter((member) => member !== author)
      .map(testAgentView),
    msgId: msgId(byte),
    content: [
      ...("op" in value ? [{ type: "text", text: "Choose a time" }] : []),
      { type: "data", value: { [collectiveKey]: value } },
    ],
  });
const classify = (
  layer: TestCollectiveOperations,
  author: string,
  byte: number,
  value: object,
) =>
  layer.classify({
    message: groupMessage(author, byte, value),
    recordHash: recordHashOf(byte),
  });
const respond = (layer: TestCollectiveOperations, slot: string) =>
  send(layer, {
    to: group,
    collectiveResponse: {
      operationId: requestId,
      action: "accept",
      content: { slot },
    },
  });

it("keeps concurrent requesters separate when their random operation bytes match", () =>
  Effect.gen(function* () {
    const observed = newObserved();
    const layer = yield* makeLayer(observed, { self: "agent:carol" });
    const bobOperationId = collectiveOperationId(testAgentView("bob").agentId);
    yield* classify(layer, "agent:alice", 10, requestValue);
    yield* classify(layer, "agent:bob", 11, {
      ...requestValue,
      operationId: bobOperationId,
    });

    yield* send(layer, {
      to: group,
      collectiveResponse: { operationId: requestId, action: "decline" },
    });
    yield* send(layer, {
      to: group,
      collectiveResponse: { operationId: bobOperationId, action: "decline" },
    });
    yield* classify(layer, "agent:bob", 12, answer(requestId, "mon"));
    yield* classify(layer, "agent:alice", 13, answer(bobOperationId, "tue"));
    const selected = [
      answerReference("agent:bob", 12),
      answerReference("agent:carol", 101),
    ];
    yield* classify(layer, "agent:bob", 14, close(requestId, selected));
    expect(observed.emitted).toEqual([]);

    yield* classify(layer, "agent:alice", 15, close(requestId, selected));
    yield* classify(
      layer,
      "agent:bob",
      16,
      close(bobOperationId, [
        answerReference("agent:alice", 13),
        answerReference("agent:carol", 102),
      ]),
    );
    assertIndependentResults(observed.emitted, bobOperationId);
  }));

it("selects the named author when two answers share a message id", () =>
  Effect.gen(function* () {
    const observed = newObserved();
    const layer = yield* makeLayer(observed, { self: "agent:bob" });
    yield* classify(layer, "agent:alice", 10, requestValue);
    yield* respond(layer, "mon");
    yield* layer.classify({
      message: groupMessage("agent:carol", 101, answer(requestId, "tue")),
      recordHash: recordHashOf(13),
    });
    yield* classify(
      layer,
      "agent:alice",
      14,
      close(requestId, [answerReference("agent:carol", 101)]),
    );

    expect(observed.emitted).toMatchObject([
      {
        outcomes: [
          {
            member: testAgentView("agent:bob"),
            outcome: { kind: "no-answer" },
          },
          {
            member: testAgentView("agent:carol"),
            outcome: { kind: "answered", content: { slot: "tue" } },
          },
        ],
      },
    ]);
  }));

it("consumes a close that selects one author twice", () =>
  Effect.gen(function* () {
    const observed = newObserved();
    const layer = yield* makeLayer(observed, { self: "agent:bob" });
    yield* classify(layer, "agent:alice", 10, requestValue);
    yield* classify(layer, "agent:carol", 13, answer(requestId, "tue"));
    const selected = answerReference("agent:carol", 13);
    yield* classify(
      layer,
      "agent:alice",
      14,
      close(requestId, [selected, selected]),
    );

    expect(observed.emitted).toEqual([]);
    expect(yield* collectiveFailureOf(respond(layer, "mon"))).toEqual({
      kind: "request-expired",
    });
  }));

function assertIndependentResults(
  items: readonly InboundItem[],
  bobOperationId: string,
) {
  expect(items).toMatchObject([
    {
      kind: "collectiveResult",
      operationId: requestId,
      outcomes: [
        {
          member: testAgentView("bob"),
          outcome: { kind: "answered", content: { slot: "mon" } },
        },
        { member: testAgentView("carol"), outcome: { kind: "declined" } },
      ],
    },
    {
      kind: "collectiveResult",
      operationId: bobOperationId,
      outcomes: [
        {
          member: testAgentView("alice"),
          outcome: { kind: "answered", content: { slot: "tue" } },
        },
        { member: testAgentView("carol"), outcome: { kind: "declined" } },
      ],
    },
  ]);
}
