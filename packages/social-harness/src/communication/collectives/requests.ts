/** @file Captures questions and claims exact outgoing answers. */

import { Clock, Effect, Option, Schema } from "effect";
import type { Environment } from "./environment.js";
import { AgentView } from "../../identity/cards.js";
import { Message } from "../message.js";
import { transaction } from "../store/database/index.js";
import * as Store from "../store/index.js";
import {
  decodeRuntimeValue,
  encodeRuntimeValue,
  EndpointStoreError,
} from "../store/index.js";
import {
  answerFieldsText,
  type CollectiveId,
  describeIssues,
} from "./contracts.js";
import { CollectivesError } from "./errors.js";
import { Question } from "./model.js";
import {
  makeMessage,
  outgoingAddress,
  requestItem,
  sameMessage,
  sameParticipants,
  saveMessage,
  self,
} from "./operations.js";
import { validateAnswer } from "./validation.js";
import {
  collectiveRequesterOf,
  encodeCollectiveContent,
  readCollectiveValue,
} from "./wire/index.js";

/** A retry of the same captured question resumes its saved message custody. */
export const ask = Effect.fn("ask")(function* (
  environment: Environment,
  input: Question,
) {
  const question = yield* Schema.decodeUnknown(Question)(input).pipe(
    Effect.catchTag(
      "ParseError",
      (error) =>
        new CollectivesError({
          reason: "invalid-question",
          detail: describeIssues(error),
        }),
    ),
  );
  const author = yield* self(environment);
  if (
    !Schema.equivalence(AgentView)(question.author, author) ||
    collectiveRequesterOf(question.operationId) !== author.agentId ||
    (question.op === "all_gather" && question.recipients.length < 2)
  ) {
    return yield* new CollectivesError({ reason: "invalid-question" });
  }
  yield* transaction(saveQuestion(question));
  const messages = yield* Store.readCollectiveMessages(question.operationId);
  const accepted = yield* Effect.forEach(
    messages.filter((message) => message.role === "request"),
    (message) => decodeRuntimeValue(Message, message.canonicalMessage),
    { concurrency: 1 },
  );
  return {
    kind: "collective" as const,
    operationId: question.operationId,
    msgIds: accepted.map((message) => message.msgId),
  };
});

/** Request content stays fixed while liveness is rechecked when an answer is accepted. */
export const getRequest = Effect.fn("getRequest")(function* (
  operationId: CollectiveId,
) {
  const operation = yield* Store.readCollectiveOperation(operationId);
  if (operation === undefined || operation.origin !== "remote") {
    return yield* new CollectivesError({ reason: "request-none" });
  }
  const message = yield* decodeRuntimeValue(
    Message,
    operation.canonicalRequest,
  );
  const value = yield* readCollectiveValue(message.content).pipe(
    Effect.catchTag(
      "CollectivePartInvalidError",
      () => new EndpointStoreError({ reason: "corrupt" }),
    ),
  );
  if (Option.isNone(value) || value.value.kind !== "operation") {
    return yield* new EndpointStoreError({ reason: "corrupt" });
  }
  return requestItem(message, value.value).message;
});

/** A saved answer remains claimed even when its network submission is pending. */
export const answer = Effect.fn("answer")(function* (
  environment: Environment,
  input: Message,
) {
  const message = yield* decodeRuntimeValue(
    Message,
    yield* encodeRuntimeValue(input),
  );
  const author = yield* self(environment);
  const response = yield* readResponse(message);
  if (!Schema.equivalence(AgentView)(message.author, author)) {
    return yield* new CollectivesError({ reason: "answer-invalid" });
  }
  const request = yield* getRequest(response.operationId);
  if (response.action === "accept") {
    yield* validateAnswer(
      request.content.requestedSchema,
      response.content,
    ).pipe(
      Effect.matchEffect({
        onFailure: (fields) =>
          new CollectivesError({
            reason: "answer-invalid",
            detail: answerFieldsText(fields),
          }),
        onSuccess: () => Effect.void,
      }),
    );
  }
  yield* transaction(claimAnswer(message, response.operationId));
  return {
    kind: "response" as const,
    operationId: response.operationId,
    msgId: message.msgId,
    msgIds: [message.msgId],
    address: outgoingAddress(message),
  };
});

function saveQuestion(question: Question) {
  return Effect.gen(function* () {
    const existing = yield* Store.readCollectiveOperation(question.operationId);
    if (
      existing === undefined &&
      question.deadlineAt <= (yield* Clock.currentTimeMillis)
    ) {
      return yield* new CollectivesError({ reason: "invalid-question" });
    }
    yield* Store.putCollectiveOperation({
      operationId: question.operationId,
      creatorAgentId: question.author.agentId,
      origin: "local",
      canonicalRequest: yield* encodeRuntimeValue(question),
      deadlineAt: question.deadlineAt,
    });
    if (existing !== undefined) {
      return;
    }
    for (const message of yield* requestMessages(question)) {
      yield* saveMessage(question.operationId, "request", message);
    }
  });
}

function requestMessages(question: Question) {
  return Effect.gen(function* () {
    const content = yield* encodeCollectiveContent(
      {
        kind: "operation",
        op: question.op,
        operationId: question.operationId,
        deadlineAt: question.deadlineAt,
        requestedSchema: question.requestedSchema,
      },
      question.text,
    ).pipe(
      Effect.catchTag(
        "CollectiveContentError",
        () => new CollectivesError({ reason: "invalid-question" }),
      ),
    );
    const audiences =
      question.op === "gather"
        ? question.recipients.map((recipient) => [recipient])
        : [question.recipients];
    return yield* Effect.forEach(
      audiences,
      (recipients) => makeMessage(question.author, recipients, content),
      { concurrency: 1 },
    );
  });
}

function readResponse(message: Message) {
  return Effect.gen(function* () {
    const value = yield* readCollectiveValue(message.content).pipe(
      Effect.catchTag(
        "CollectivePartInvalidError",
        () => new CollectivesError({ reason: "answer-invalid" }),
      ),
    );
    if (Option.isNone(value) || value.value.kind !== "response") {
      return yield* new CollectivesError({ reason: "answer-invalid" });
    }
    return value.value;
  });
}

function claimAnswer(message: Message, operationId: CollectiveId) {
  return Effect.gen(function* () {
    const operation = yield* Store.readCollectiveOperation(operationId);
    if (operation === undefined) {
      return yield* new CollectivesError({ reason: "request-none" });
    }
    const prior = (yield* Store.readCollectiveMessages(operationId)).find(
      (entry) => entry.role === "response",
    );
    if (prior !== undefined) {
      const saved = yield* decodeRuntimeValue(Message, prior.canonicalMessage);
      if (!sameMessage(saved, message)) {
        return yield* new CollectivesError({ reason: "request-answered" });
      }
      return;
    }
    if (operation.phase !== "collecting") {
      return yield* new CollectivesError({ reason: "request-none" });
    }
    if ((yield* Clock.currentTimeMillis) >= operation.deadlineAt) {
      return yield* new CollectivesError({ reason: "request-expired" });
    }
    const source = yield* decodeRuntimeValue(
      Message,
      operation.canonicalRequest,
    );
    if (!sameParticipants(source, message)) {
      return yield* new CollectivesError({ reason: "answer-invalid" });
    }
    yield* saveMessage(operationId, "response", message);
  });
}
