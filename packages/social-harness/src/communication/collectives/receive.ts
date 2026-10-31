/** @file Interprets verified collective traffic in its delivery transaction. */

import type * as SqlClient from "@effect/sql/SqlClient";
import { Clock, Effect, Option } from "effect";
import type { Environment } from "./environment.js";
import type { CollectivesError } from "./errors.js";
import type { InboundItem as IncomingItem } from "./inbound.js";
import { Message } from "../message.js";
import { agentAddressOf } from "../records/values.js";
import { transaction } from "../store/database/index.js";
import * as Store from "../store/index.js";
import {
  decodeRuntimeValue,
  encodeRuntimeValue,
  type EndpointStoreError,
} from "../store/index.js";
import {
  operationParticipants,
  requestItem,
  sameMessage,
  sameParticipants,
  self,
} from "./operations.js";
import {
  collectiveRequesterOf,
  type CollectiveValue,
  readCollectiveValue,
  type ResponseValue,
} from "./wire/index.js";

/** Only durable interpretation runs in the communication handoff transaction. */
export function receive(environment: Environment, message: Message) {
  return readCollectiveValue(message.content).pipe(
    Effect.matchEffect({
      onFailure: () => Effect.succeed(Option.none<IncomingItem>()),
      onSuccess: (decoded) =>
        Option.match(decoded, {
          onNone: () =>
            Effect.succeed(
              Option.some<IncomingItem>({ kind: "multicast", message }),
            ),
          onSome: (value) =>
            transaction(receivePart(environment, message, value)),
        }),
    }),
    Effect.withSpan("receive"),
  );
}

function receivePart(
  environment: Environment,
  message: Message,
  value: CollectiveValue,
): Effect.Effect<
  Option.Option<IncomingItem>,
  EndpointStoreError | CollectivesError,
  SqlClient.SqlClient
> {
  switch (value.kind) {
    case "operation":
      return receiveRequest(environment, message, value);
    case "response":
      return receiveAnswer(message, value).pipe(Effect.as(Option.none()));
    case "close":
      return receiveClose(message, value).pipe(Effect.as(Option.none()));
    default: {
      const exhaustive: never = value;
      return exhaustive;
    }
  }
}

function receiveRequest(
  environment: Environment,
  message: Message,
  value: Extract<CollectiveValue, { readonly kind: "operation" }>,
) {
  return Effect.gen(function* () {
    const local = yield* self(environment);
    if (
      !requestEligible(
        message,
        value,
        local.agentId,
        yield* Clock.currentTimeMillis,
      )
    ) {
      return Option.none<IncomingItem>();
    }
    const existing = yield* Store.readCollectiveOperation(value.operationId);
    if (existing !== undefined) {
      if (existing.origin !== "remote") {
        return Option.none<IncomingItem>();
      }
      const saved = yield* decodeRuntimeValue(
        Message,
        existing.canonicalRequest,
      );
      return sameMessage(saved, message)
        ? Option.some<IncomingItem>(requestItem(message, value))
        : Option.none<IncomingItem>();
    }
    yield* Store.putCollectiveOperation({
      operationId: value.operationId,
      creatorAgentId: message.author.agentId,
      origin: "remote",
      canonicalRequest: yield* encodeRuntimeValue(message),
      deadlineAt: value.deadlineAt,
    });
    return Option.some<IncomingItem>(requestItem(message, value));
  });
}

function receiveAnswer(message: Message, response: ResponseValue) {
  return Effect.gen(function* () {
    const operation = yield* Store.readCollectiveOperation(
      response.operationId,
    );
    if (operation === undefined || operation.phase === "completed") {
      return;
    }
    const participants = yield* operationParticipants(operation);
    if (
      !participants.members.some(
        (member) => member.agentId === message.author.agentId,
      )
    ) {
      return;
    }
    if (
      participants.op === "all_gather"
        ? !sameParticipants(participants.request, message)
        : message.recipients.length !== 1 ||
          message.recipients[0]?.agentId !== operation.creatorAgentId
    ) {
      return;
    }
    yield* Store.recordCollectiveAnswer(
      {
        operationId: response.operationId,
        member: agentAddressOf(message.author),
        canonicalMessage: yield* encodeRuntimeValue(message),
      },
      yield* Clock.currentTimeMillis,
    );
  });
}

function receiveClose(
  message: Message,
  value: Extract<CollectiveValue, { readonly kind: "close" }>,
) {
  return Effect.gen(function* () {
    const operation = yield* Store.readCollectiveOperation(value.operationId);
    if (
      operation === undefined ||
      operation.origin !== "remote" ||
      operation.phase !== "collecting" ||
      operation.creatorAgentId !== message.author.agentId
    ) {
      return;
    }
    const request = yield* decodeRuntimeValue(
      Message,
      operation.canonicalRequest,
    );
    const participants = yield* operationParticipants(operation);
    if (
      participants.op !== "all_gather" ||
      !sameParticipants(request, message)
    ) {
      return;
    }
    yield* Store.finalizeCollectiveOperation(
      value.operationId,
      yield* encodeRuntimeValue(message),
    );
  });
}

function requestEligible(
  message: Message,
  value: Extract<CollectiveValue, { readonly kind: "operation" }>,
  localAgentId: Message["author"]["agentId"],
  now: number,
) {
  const matchingAuthor =
    collectiveRequesterOf(value.operationId) === message.author.agentId;
  const addressedToLocal = message.recipients.some(
    (recipient) => recipient.agentId === localAgentId,
  );
  const audience =
    value.op === "gather"
      ? message.recipients.length === 1
      : message.recipients.length >= 2;
  return (
    matchingAuthor && addressedToLocal && audience && value.deadlineAt > now
  );
}
