/** @file Freezes selected answers and publishes recoverable results. */

import { Clock, Deferred, Effect, Option, Schema } from "effect";
import type { AgentView } from "../../identity/cards.js";
import type { Environment } from "./environment.js";
import { MAXIMUM_RUNTIME_ITEM_BYTES } from "../../encoding/limits.js";
import { Message, type MessageReference } from "../message.js";
import { transaction } from "../store/database/index.js";
import {
  decodeRuntimeValue,
  encodeRuntimeValue,
  EndpointStoreError,
  type StoredCollectiveOperation,
} from "../store/index.js";
import * as Store from "../store/index.js";
import { type collectiveClosure, CollectiveId } from "./contracts.js";
import {
  frozenResult,
  type FrozenResult,
  ResultDelivery,
  ResultSources,
} from "./model.js";
import {
  makeMessage,
  operationParticipants,
  saveMessage,
  self,
} from "./operations.js";
import { outcomeOfResponse } from "./validation.js";
import {
  type CollectiveValue,
  encodeCollectiveContent,
  type FormModeSchema,
  readCollectiveValue,
} from "./wire/index.js";

type Closure = typeof collectiveClosure.Type;
type Participants = Effect.Effect.Success<
  ReturnType<typeof operationParticipants>
>;
type Close = Extract<CollectiveValue, { readonly kind: "close" }>;

/** A group result waits for its saved close to certify before publication. */
export const finishLocal = Effect.fn("finishLocal")(function* (
  operationId: CollectiveId,
) {
  const frozen = yield* transaction(freezeLocal(operationId));
  if (frozen !== undefined && frozen.close === undefined) {
    yield* publishResult(operationId, frozen);
  }
});

/** A close selects only the retained first answer under each named identity. */
export const finishRemote = Effect.fn("finishRemote")(function* (
  environment: Environment,
  operationId: CollectiveId,
) {
  yield* transaction(completeRemote(environment, operationId));
});

/** Public item bytes and private source bytes retain independent size bounds. */
export function publishResult(operationId: string, result: FrozenResult) {
  return Effect.gen(function* () {
    const canonicalResult = yield* encodeRuntimeValue(result.item);
    const canonicalSources = yield* encodeRuntimeValue(result.sources);
    if (
      canonicalResult.byteLength > MAXIMUM_RUNTIME_ITEM_BYTES ||
      canonicalSources.byteLength > MAXIMUM_RUNTIME_ITEM_BYTES
    ) {
      return yield* new EndpointStoreError({ reason: "invalid-input" });
    }
    yield* Store.completeCollectiveOperation({
      operationId,
      canonicalResult,
      canonicalSources,
    });
  }).pipe(Effect.withSpan("publishResult"));
}

/** Handler success and handoff retirement share the caller fiber transaction. */
export function consumeResults<E, R>(
  environment: Environment,
  handle: (result: ResultDelivery) => Effect.Effect<void, E, R>,
) {
  return deliverNextResult(handle).pipe(
    Effect.forever,
    Effect.raceFirst(Deferred.await(environment.failed)),
    Effect.withSpan("consumeResults"),
  );
}

function freezeLocal(operationId: CollectiveId) {
  return Effect.gen(function* () {
    const operation = yield* Store.readCollectiveOperation(operationId);
    if (
      operation === undefined ||
      operation.origin !== "local" ||
      operation.phase === "completed"
    ) {
      return undefined;
    }
    if (operation.canonicalSelection !== undefined) {
      return yield* decodeRuntimeValue(
        frozenResult,
        operation.canonicalSelection,
      );
    }
    const participants = yield* operationParticipants(operation);
    const answers = yield* savedAnswers(operationId);
    const closure = completionAt(
      operation.deadlineAt,
      participants.members.length,
      answers.length,
      yield* Clock.currentTimeMillis,
    );
    if (closure === undefined) {
      return undefined;
    }
    const frozen = yield* selectedResult(
      operation,
      participants,
      answers,
      closure,
    );
    yield* Store.finalizeCollectiveOperation(
      operationId,
      yield* encodeRuntimeValue(frozen),
    );
    if (frozen.close !== undefined) {
      yield* saveMessage(operationId, "close", frozen.close);
    }
    return frozen;
  });
}

function completionAt(
  deadlineAt: number,
  members: number,
  answers: number,
  now: number,
): Closure | undefined {
  if (answers < members && now < deadlineAt) {
    return undefined;
  }
  return {
    closedAt: now,
    closedBy: answers === members ? "settled" : "deadline",
  };
}

function selectedResult(
  operation: StoredCollectiveOperation,
  participants: Participants,
  answers: readonly Message[],
  closure: Closure,
) {
  return Effect.gen(function* () {
    const result = yield* makeResult(operation, answers, closure);
    const close =
      participants.op === "all_gather"
        ? yield* makeGroupClose(operation, participants, answers, closure)
        : undefined;
    return { ...result, ...(close === undefined ? {} : { close }) };
  });
}

function makeGroupClose(
  operation: StoredCollectiveOperation,
  participants: Participants,
  answers: readonly Message[],
  closure: Closure,
) {
  return Effect.gen(function* () {
    const operationId = yield* Schema.decodeUnknown(CollectiveId)(
      operation.operationId,
    ).pipe(
      Effect.catchTag(
        "ParseError",
        () => new EndpointStoreError({ reason: "corrupt" }),
      ),
    );
    const content = yield* encodeCollectiveContent({
      kind: "close",
      operationId,
      ...closure,
      included: answers.map((answer) => ({
        authorAgentId: answer.author.agentId,
        msgId: answer.msgId,
      })),
    }).pipe(
      Effect.catchTag(
        "CollectiveContentError",
        () => new EndpointStoreError({ reason: "corrupt" }),
      ),
    );
    return yield* makeMessage(
      participants.request.author,
      participants.request.recipients,
      content,
    );
  });
}

function completeRemote(environment: Environment, operationId: CollectiveId) {
  return Effect.gen(function* () {
    const operation = yield* Store.readCollectiveOperation(operationId);
    if (
      operation === undefined ||
      operation.origin !== "remote" ||
      operation.phase !== "finalizing" ||
      operation.canonicalSelection === undefined
    ) {
      return;
    }
    const message = yield* decodeRuntimeValue(
      Message,
      operation.canonicalSelection,
    );
    const value = yield* readCollectiveValue(message.content).pipe(
      Effect.catchTag(
        "CollectivePartInvalidError",
        () => new EndpointStoreError({ reason: "corrupt" }),
      ),
    );
    if (Option.isNone(value) || value.value.kind !== "close") {
      return yield* new EndpointStoreError({ reason: "corrupt" });
    }
    const selected = yield* selectAnswers(
      environment,
      operationId,
      value.value,
    );
    if (Option.isSome(selected)) {
      yield* publishResult(
        operationId,
        yield* makeResult(operation, selected.value, {
          closedAt: value.value.closedAt,
          closedBy: value.value.closedBy,
        }),
      );
    }
  });
}

function selectAnswers(
  environment: Environment,
  operationId: CollectiveId,
  close: Close,
) {
  return Effect.gen(function* () {
    if (
      new Set(close.included.map((reference) => reference.authorAgentId))
        .size !== close.included.length
    ) {
      yield* Store.retireCollectiveOperation(operationId);
      return Option.none<readonly Message[]>();
    }
    const answers = yield* savedAnswers(operationId);
    const selected = answersFor(answers, close.included);
    if (selected.length === close.included.length) {
      return Option.some(selected);
    }
    if (
      yield* ownAnswerPending(environment, operationId, answers, close.included)
    ) {
      return Option.none<readonly Message[]>();
    }
    yield* Store.retireCollectiveOperation(operationId);
    return Option.none<readonly Message[]>();
  });
}

function answersFor(
  answers: readonly Message[],
  included: readonly MessageReference[],
) {
  return included.flatMap((reference) => {
    const answer = answers.find(
      (message) =>
        message.author.agentId === reference.authorAgentId &&
        message.msgId === reference.msgId,
    );
    return answer === undefined ? [] : [answer];
  });
}

function ownAnswerPending(
  environment: Environment,
  operationId: CollectiveId,
  answers: readonly Message[],
  included: readonly MessageReference[],
) {
  return Effect.gen(function* () {
    const local = yield* self(environment);
    const own = included.find(
      (reference) => reference.authorAgentId === local.agentId,
    );
    if (
      own === undefined ||
      answers.some(
        (answer) =>
          answer.author.agentId === own.authorAgentId &&
          answer.msgId === own.msgId,
      )
    ) {
      return false;
    }
    return (yield* Store.readCollectiveMessages(operationId)).some(
      (entry) => entry.role === "response",
    );
  });
}

function savedAnswers(operationId: string) {
  return Store.readCollectiveAnswers(operationId).pipe(
    Effect.flatMap((rows) =>
      Effect.forEach(
        rows,
        (row) => decodeRuntimeValue(Message, row.canonicalMessage),
        { concurrency: 1 },
      ),
    ),
  );
}

function makeResult(
  operation: StoredCollectiveOperation,
  answers: readonly Message[],
  closure: Closure,
) {
  return Effect.gen(function* () {
    const participants = yield* operationParticipants(operation);
    const outcomes = yield* Effect.forEach(
      participants.members,
      (member) =>
        memberResult(
          member,
          answers,
          participants.requestedSchema,
          operation.operationId,
        ),
      { concurrency: 1 },
    );
    const [first, ...rest] = outcomes;
    if (first === undefined) {
      return yield* new EndpointStoreError({ reason: "corrupt" });
    }
    const item = yield* Schema.decodeUnknown(ResultDelivery.fields.item)({
      kind: "collectiveResult",
      op: participants.op,
      operationId: operation.operationId,
      ...closure,
      to: participants.to,
      question: participants.question,
      outcomes: [first, ...rest],
    }).pipe(
      Effect.catchTag(
        "ParseError",
        () => new EndpointStoreError({ reason: "corrupt" }),
      ),
    );
    const request =
      operation.origin === "remote"
        ? yield* decodeRuntimeValue(Message, operation.canonicalRequest)
        : undefined;
    return {
      item,
      sources: { answers, ...(request === undefined ? {} : { request }) },
    };
  });
}

function memberResult(
  member: AgentView,
  answers: readonly Message[],
  requestedSchema: FormModeSchema,
  operationId: string,
) {
  return Effect.gen(function* () {
    const message = answers.find(
      (answer) => answer.author.agentId === member.agentId,
    );
    if (message === undefined) {
      return { member, outcome: { kind: "no-answer" as const } };
    }
    const value = yield* readCollectiveValue(message.content).pipe(
      Effect.catchTag(
        "CollectivePartInvalidError",
        () => new EndpointStoreError({ reason: "corrupt" }),
      ),
    );
    if (
      Option.isNone(value) ||
      value.value.kind !== "response" ||
      value.value.operationId !== operationId
    ) {
      return yield* new EndpointStoreError({ reason: "corrupt" });
    }
    return {
      member,
      outcome: yield* outcomeOfResponse(requestedSchema, value.value),
    };
  });
}

function deliverNextResult<E, R>(
  handle: (result: ResultDelivery) => Effect.Effect<void, E, R>,
) {
  return Effect.gen(function* () {
    const operation = yield* Store.readNextCollectiveResult();
    if (operation === undefined) {
      return yield* Effect.sleep("100 millis");
    }
    if (
      operation.canonicalResult === undefined ||
      operation.canonicalSources === undefined
    ) {
      return yield* new EndpointStoreError({ reason: "corrupt" });
    }
    const result = yield* Schema.decodeUnknown(ResultDelivery)({
      operationId: operation.operationId,
      deliveryToken: operation.deliveryToken,
      item: yield* decodeRuntimeValue(
        ResultDelivery.fields.item,
        operation.canonicalResult,
      ),
      sources: yield* decodeRuntimeValue(
        ResultSources,
        operation.canonicalSources,
      ),
    }).pipe(
      Effect.catchTag(
        "ParseError",
        () => new EndpointStoreError({ reason: "corrupt" }),
      ),
    );
    yield* transaction(
      handle(result).pipe(
        Effect.zipRight(Store.retireCollectiveResult(operation.operationId)),
      ),
    );
  });
}
