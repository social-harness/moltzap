/** @file Collective custody keeps immutable messages and first-answer selection across reopening. */

import { live as it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";
import type { Question } from "../collectives/index.js";
import type { Message } from "../message.js";
import type {
  CollectiveAnswerReference,
  StoredCollectiveMessage,
} from "./types.js";
import {
  alice,
  bob,
  question,
  wireMessage,
} from "../../__tests__/collective-service-fixtures.js";
import {
  stateDirectory,
  type TestStore,
  withDaemonStore,
} from "../../__tests__/store-schema-fixtures.js";
import { encodeRuntimeValue, EndpointStoreError } from "./index.js";

it("reopens the exact saved message and refuses changed content under its custody slot", () =>
  Effect.gen(function* () {
    const directory = stateDirectory();
    const captured = question(Date.now() + 5000);
    const message = yield* wireMessage(
      alice,
      [bob],
      {
        kind: "operation",
        op: captured.op,
        operationId: captured.operationId,
        deadlineAt: captured.deadlineAt,
        requestedSchema: captured.requestedSchema,
      },
      { byte: 23, text: captured.text },
    );
    const saved = {
      operationId: captured.operationId,
      role: "request" as const,
      destination: `agent:${bob.agentName}`,
      canonicalMessage: yield* encodeRuntimeValue(message),
    };
    yield* withDaemonStore(directory, (store) =>
      keepMessage(store, captured, saved, message),
    );
    const reopened = yield* withDaemonStore(directory, (store) =>
      store.readCollectiveMessages(captured.operationId),
    );
    expect(reopened).toEqual([saved]);
  }));

it("retains the first saved answer and refuses a first recording at the deadline", () =>
  Effect.gen(function* () {
    const directory = stateDirectory();
    const captured = question(Date.now() + 5000);
    const message = yield* wireMessage(
      bob,
      [alice],
      {
        kind: "response",
        operationId: captured.operationId,
        action: "decline",
      },
      { byte: 24 },
    );
    const answer = {
      operationId: captured.operationId,
      member: `agent:${bob.agentName}`,
      canonicalMessage: yield* encodeRuntimeValue(message),
    };
    yield* withDaemonStore(directory, (store) =>
      recordAnswer(store, captured, answer),
    );
    const reopened = yield* withDaemonStore(directory, (store) =>
      store.readCollectiveAnswers(captured.operationId),
    );
    expect(reopened).toEqual([answer]);
  }));

function keepMessage(
  store: TestStore,
  captured: Question,
  saved: StoredCollectiveMessage,
  message: Message,
) {
  return Effect.gen(function* () {
    yield* store.putCollectiveOperation({
      operationId: captured.operationId,
      creatorAgentId: alice.agentId,
      origin: "local",
      canonicalRequest: yield* encodeRuntimeValue(captured),
      deadlineAt: captured.deadlineAt,
    });
    yield* store.putCollectiveMessage(saved);
    yield* store.putCollectiveMessage(saved);
    const changed = {
      ...message,
      content: [{ type: "text" as const, text: "Changed question" }],
    };
    const failure = yield* store
      .putCollectiveMessage({
        ...saved,
        canonicalMessage: yield* encodeRuntimeValue(changed),
      })
      .pipe(Effect.flip);
    expect(failure).toBeInstanceOf(EndpointStoreError);
  });
}

function recordAnswer(
  store: TestStore,
  captured: Question,
  answer: CollectiveAnswerReference,
) {
  return Effect.gen(function* () {
    yield* store.putCollectiveOperation({
      operationId: captured.operationId,
      creatorAgentId: alice.agentId,
      origin: "local",
      canonicalRequest: yield* encodeRuntimeValue(captured),
      deadlineAt: captured.deadlineAt,
    });
    expect(
      yield* store.recordCollectiveAnswer(answer, captured.deadlineAt),
    ).toBeFalsy();
    expect(
      yield* store.recordCollectiveAnswer(answer, captured.deadlineAt - 1),
    ).toBeTruthy();
    expect(
      yield* store.recordCollectiveAnswer(answer, captured.deadlineAt - 1),
    ).toBeFalsy();
  });
}
