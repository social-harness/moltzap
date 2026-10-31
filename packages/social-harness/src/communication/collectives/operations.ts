/** @file Keeps operation audiences and message identities fixed. */

import { Effect, Option, Schema } from "effect";
import type { Environment } from "./environment.js";
import { AgentView } from "../../identity/cards.js";
import {
  Message,
  messageFromIntent,
  messageMembers,
  replyAddress,
} from "../message.js";
import { mintMsgId } from "../records/index.js";
import { agentAddressOf } from "../records/values.js";
import {
  decodeRuntimeValue,
  encodeRuntimeValue,
  EndpointStoreError,
  type StoredCollectiveOperation,
} from "../store/index.js";
import * as Store from "../store/index.js";
import { CollectivesError } from "./errors.js";
import { Question } from "./model.js";
import { questionText } from "./render.js";
import { type CollectiveValue, readCollectiveValue } from "./wire/index.js";

/** Identity registration is independent of protocol startup. */
export function self(environment: Environment) {
  return environment.identity.me().pipe(
    Effect.catchTag(
      "IdentityError",
      () => new CollectivesError({ reason: "not-registered" }),
    ),
    Effect.flatMap((status) =>
      status.kind === "registered"
        ? Effect.succeed(status.agent)
        : Effect.fail(new CollectivesError({ reason: "not-registered" })),
    ),
  );
}

/** The author mints one identity before the message enters outgoing custody. */
export function makeMessage(
  author: AgentView,
  recipients: readonly AgentView[],
  content: Message["content"],
) {
  return Effect.gen(function* () {
    return yield* messageFromIntent([author, ...recipients], {
      authorAgentId: author.agentId,
      msgId: yield* mintMsgId().pipe(
        Effect.catchTag(
          "ClientRepresentationError",
          () => new CollectivesError({ reason: "invalid-question" }),
        ),
      ),
      content,
    }).pipe(
      Effect.catchTag(
        "ParseError",
        () => new CollectivesError({ reason: "invalid-question" }),
      ),
    );
  }).pipe(Effect.withSpan("makeMessage"));
}

/** The recognized question keeps the original message identity and participants. */
export function requestItem(
  message: Message,
  value: Extract<CollectiveValue, { readonly kind: "operation" }>,
) {
  const question = questionText(message.content);
  return {
    kind: "collectiveRequest" as const,
    message: {
      ...message,
      content: {
        op: value.op,
        operationId: value.operationId,
        question,
        requestedSchema: value.requestedSchema,
        deadlineAt: value.deadlineAt,
      },
    },
  };
}

/** Local questions and received requests preserve their original audiences. */
export function operationParticipants(operation: StoredCollectiveOperation) {
  return Effect.gen(function* () {
    if (operation.origin === "local") {
      const question = yield* decodeRuntimeValue(
        Question,
        operation.canonicalRequest,
      );
      const request = {
        author: question.author,
        recipients: question.recipients,
      };
      return {
        op: question.op,
        members: question.recipients,
        question: question.text,
        requestedSchema: question.requestedSchema,
        request,
        to: outgoingAddress(request),
      };
    }
    const request = yield* decodeRuntimeValue(
      Message,
      operation.canonicalRequest,
    );
    const value = yield* readCollectiveValue(request.content).pipe(
      Effect.catchTag(
        "CollectivePartInvalidError",
        () => new EndpointStoreError({ reason: "corrupt" }),
      ),
    );
    if (Option.isNone(value) || value.value.kind !== "operation") {
      return yield* new EndpointStoreError({ reason: "corrupt" });
    }
    return {
      op: value.value.op,
      members: request.recipients,
      question: requestItem(request, value.value).message.content.question,
      requestedSchema: value.value.requestedSchema,
      request,
      to: replyAddress(request),
    };
  }).pipe(Effect.withSpan("operationParticipants"));
}

/** Role and destination select one immutable outgoing message for retries. */
export function saveMessage(
  operationId: string,
  role: "request" | "response" | "close",
  message: Message,
) {
  return Effect.gen(function* () {
    yield* Store.putCollectiveMessage({
      operationId,
      role,
      destination: outgoingAddress(message),
      canonicalMessage: yield* encodeRuntimeValue(message),
    });
  }).pipe(Effect.withSpan("saveMessage"));
}

/** A direct outgoing message names its recipient rather than its author. */
export function outgoingAddress(
  message: Pick<Message, "author" | "recipients">,
) {
  return message.recipients.length === 1
    ? agentAddressOf(message.recipients[0])
    : replyAddress(message);
}

/** Fixed identities, names and principals must agree before operation traffic is accepted. */
export function sameParticipants(
  left: Pick<Message, "author" | "recipients">,
  right: Pick<Message, "author" | "recipients">,
) {
  return Schema.equivalence(Schema.Array(AgentView))(
    messageMembers(left),
    messageMembers(right),
  );
}

/** The author and id cannot be reused with changed content or participants. */
export function sameMessage(left: Message, right: Message) {
  return Schema.equivalence(Message)(left, right);
}
