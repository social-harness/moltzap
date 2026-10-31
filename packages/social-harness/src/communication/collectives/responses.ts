/** @file One retained response claim stays attached to its original certified message. */

import type * as SqlClient from "@effect/sql/SqlClient";
import { Clock, Effect, Either, Option, Schema } from "effect";
import type { CollectiveSendError } from "./ports.js";
import type { PreparedResponse } from "./prepared.js";
import type { CertifiedAnswer } from "./shared-answers.js";
import type { CollectiveState } from "./state.js";
import { canonicalMessageAddress } from "../conversations/address.js";
import { SendError } from "../conversations/errors.js";
import {
  type BindHold,
  preparedSendData,
  resolutionFailure,
} from "../conversations/index.js";
import {
  type Content,
  type MessageAddressInput,
  MessageIntent,
  MsgId,
  RecordHash,
} from "../records/index.js";
import { agentAddressOf } from "../records/values.js";
import * as Store from "../store/index.js";
import {
  decodeRuntimeValue,
  EndpointStoreError,
  type StoredCollectiveMessage,
} from "../store/index.js";
import { applyClose } from "./all-gather.js";
import {
  type CollectiveEmitError,
  CollectiveError,
  type CollectiveFailure,
  type CollectiveId,
  type CollectiveResponse,
  type CollectiveSendOutcome,
} from "./contracts.js";
import { durableEmit, durableSend } from "./persistence.js";
import {
  matchOpenRequest,
  type OpenRequest,
  type ReceivedRequest,
  unmatchedAnswerError,
} from "./received-request.js";
import { validateAnswer } from "./validation.js";
import {
  encodeCollectiveContent,
  readCollectiveValue,
  type ResponseValue,
} from "./wire/index.js";
type MessageContent = Content;
const contentInvalid = () => new SendError({ reason: "content-invalid" });
const collectiveFailure = (
  operationId: CollectiveId,
  failure: CollectiveFailure,
) => new CollectiveError({ operationId, failure });

/** Capture the exact schema-valid answer and its original request before assessment. */
export function prepareResponse(
  state: CollectiveState,
  to: MessageAddressInput,
  response: CollectiveResponse,
) {
  return Effect.gen(function* () {
    const { operationId, request } = yield* openRequest(state, to, response);
    const value: ResponseValue = { ...response, kind: "response", operationId };
    const content = yield* responseContent(request, value);
    const message = yield* state.ports
      .prepareMessage({
        to: request.to,
        content,
        collective: { operationId, role: "response", destination: request.to },
      })
      .pipe(
        Effect.catchTag("RecipientResolutionError", (error) =>
          Effect.fail(resolutionFailure(error)),
        ),
      );
    const snapshot = yield* readCollectiveValue(
      (yield* preparedSendData(message)).intent.content,
    ).pipe(
      Effect.catchTag("CollectivePartInvalidError", () => contentInvalid()),
    );
    if (Option.isNone(snapshot) || snapshot.value.kind !== "response") {
      return yield* contentInvalid();
    }
    return {
      operationId,
      request,
      value: snapshot.value,
      message,
    } satisfies PreparedResponse;
  }).pipe(Effect.withSpan("prepareResponse"));
}

/** Claim and bind the prepared answer only while its original request remains live. */
export function acceptResponse(
  state: CollectiveState,
  prepared: PreparedResponse,
): Effect.Effect<
  CollectiveSendOutcome,
  CollectiveSendError,
  SqlClient.SqlClient
> {
  return Effect.gen(function* () {
    const { operationId, request, value, message } = prepared;
    const { certified } = yield* state.ports
      .acceptMessage(message, claimRequest(state, request, value))
      .pipe(
        Effect.catchTag("SendError", (error) =>
          closedResponseFailure(state, request, operationId, error),
        ),
      );
    const { msgId } = yield* certified.pipe(
      Effect.tapBoth({
        onFailure: (error) =>
          settleUncertifiedAnswer(state, request, value, error),
        onSuccess: (sent) =>
          Effect.ignore(
            settleAnswer(
              state,
              operationId,
              request,
              Option.some({ recordHash: sent.recordHash, response: value }),
            ),
          ),
      }),
      Effect.onInterrupt(() => settleUncertifiedAnswer(state, request, value)),
    );
    return {
      kind: "response",
      operationId,
      msgIds: [msgId],
      msgId,
      address: request.to,
    } satisfies CollectiveSendOutcome;
  }).pipe(Effect.withSpan("acceptResponse"));
}

/** A retained response claim stays unavailable while its original intent certifies. */
export function restoreResponse(
  state: CollectiveState,
  message: StoredCollectiveMessage,
): Effect.Effect<void, EndpointStoreError, SqlClient.SqlClient> {
  return Effect.gen(function* () {
    const { canonicalIntent, completedRecordHash } = message.intent;
    const intent = yield* decodeRuntimeValue(MessageIntent, canonicalIntent);
    const value = yield* readCollectiveValue(intent.content).pipe(
      Effect.catchTag("CollectivePartInvalidError", () =>
        Effect.fail(new EndpointStoreError({ reason: "corrupt" })),
      ),
    );
    if (
      Option.isNone(value) ||
      value.value.kind !== "response" ||
      value.value.operationId !== message.operationId ||
      intent.authorAgentId !== state.ports.self.agentId
    ) {
      return yield* new EndpointStoreError({ reason: "corrupt" });
    }
    const response = value.value;
    const request = state.requests.get(response.operationId);
    if (request === undefined || request.state === "closed") {
      return;
    }
    request.state = "sending";
    if (completedRecordHash !== undefined) {
      const recordHash = yield* Schema.decodeUnknown(RecordHash)(
        completedRecordHash,
      ).pipe(
        Effect.catchTag("ParseError", () =>
          Effect.fail(new EndpointStoreError({ reason: "corrupt" })),
        ),
      );
      yield* settleAnswer(
        state,
        response.operationId,
        request,
        Option.some({ recordHash, response }),
      ).pipe(
        Effect.catchTag("CollectiveEmitError", () =>
          Effect.fail(new EndpointStoreError({ reason: "persistence" })),
        ),
      );
    } else {
      yield* observeResponse(state, request, response, intent.msgId);
    }
  }).pipe(Effect.withSpan("restoreResponse"));
}

/**
 * Resolve the request before checking an answer or reserving its one response.
 */
function openRequest(
  state: CollectiveState,
  to: MessageAddressInput,
  response: CollectiveResponse,
): Effect.Effect<
  OpenRequest<ReceivedRequest>,
  SendError | CollectiveError,
  SqlClient.SqlClient
> {
  return Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const self = state.ports.self.agentName;
    const { address } = yield* canonicalMessageAddress(to, self);
    return yield* matchOpenRequest(state.requests, address, now, response).pipe(
      Effect.mapError((unmatched) => unmatchedAnswerError(unmatched)),
    );
  });
}

/**
 * Validate an `accept` answer against the request's stored schema and build
 * the response message's content, which carries no text.
 */
function responseContent(
  request: ReceivedRequest,
  response: ResponseValue,
): Effect.Effect<
  MessageContent,
  SendError | CollectiveError,
  SqlClient.SqlClient
> {
  const validated =
    response.action === "accept"
      ? validateAnswer(request.requestedSchema, response.content).pipe(
          Effect.mapError((fields) =>
            collectiveFailure(response.operationId, {
              kind: "answer-invalid",
              fields,
            }),
          ),
        )
      : Effect.void;
  return validated.pipe(
    Effect.zipRight(
      encodeCollectiveContent(response).pipe(Effect.mapError(contentInvalid)),
    ),
  );
}

/**
 * Hold the request's one answer: match the request `openRequest` matched
 * again by its operationId, still open in its conversation and before its deadline,
 * and claim it. The match and the claim run in one step, with no yield
 * between them, so of two concurrent answers only one is sent. The hold's
 * release reopens a request whose answer bound nothing.
 */
function claimRequest(
  state: CollectiveState,
  request: ReceivedRequest,
  response: ResponseValue,
): BindHold<CollectiveError> {
  const { operationId } = response;
  return Clock.currentTimeMillis.pipe(
    Effect.flatMap((now) =>
      Effect.suspend(() =>
        Either.match(
          matchOpenRequest(state.requests, request.to, now, { operationId }),
          {
            onLeft: (unmatched) => Effect.fail(unmatchedAnswerError(unmatched)),
            onRight: () => {
              request.state = "sending";
              return Effect.succeed(
                settleUncertifiedAnswer(state, request, response),
              );
            },
          },
        ),
      ),
    ),
  );
}

/** An uncertain invocation keeps its durable answer claim and observes that same message. */
function settleUncertifiedAnswer(
  state: CollectiveState,
  request: ReceivedRequest,
  response: ResponseValue,
  failure?: SendError,
): Effect.Effect<void, never, SqlClient.SqlClient> {
  const operationId = response.operationId;
  return durableEmit(
    state,
    Store.readCollectiveMessages({
      operationId,
      role: "response",
    }),
  ).pipe(
    Effect.flatMap((messages) => {
      const [bound] = messages;
      if (bound === undefined) {
        return failure?.reason === "delivery-pending" ||
          failure?.reason === "outcome-unknown"
          ? Effect.void
          : settleAnswer(state, operationId, request, Option.none());
      }
      return observeResponse(
        state,
        request,
        response,
        Schema.decodeUnknownSync(MsgId)(bound.intent.msgId),
      );
    }),
    Effect.ignore,
  );
}

function observeResponse(
  state: CollectiveState,
  request: ReceivedRequest,
  response: ResponseValue,
  msgId: MsgId,
): Effect.Effect<void, never, SqlClient.SqlClient> {
  return state.ports.observeMessage(msgId).pipe(
    Effect.flatMap((sent) =>
      settleAnswer(
        state,
        response.operationId,
        request,
        Option.some({ recordHash: sent.recordHash, response }),
      ),
    ),
    Effect.ignore,
    Effect.interruptible,
    Effect.forkIn(state.ports.scope),
    Effect.asVoid,
  );
}

/**
 * Settle a request's answer send: answered with the certified answer, or
 * reopened when it was refused. A member's own answer never arrives inbound,
 * so an all_gather member records it here, and applies a close that was
 * waiting for it; after a refused answer that close lists a record this
 * endpoint will not hold, so applying it drops it. A request already closed
 * stays closed: its result is out, and a close delivered again must not
 * apply a second time.
 */
function settleAnswer(
  state: CollectiveState,
  operationId: CollectiveId,
  request: ReceivedRequest,
  certified: Option.Option<CertifiedAnswer>,
): Effect.Effect<void, CollectiveEmitError, SqlClient.SqlClient> {
  return Effect.suspend(() => {
    if (request.state === "closed") {
      return Effect.void;
    }
    request.state = Option.isSome(certified) ? "answered" : "open";
    if (request.kind === "gather") {
      return Effect.void;
    }
    const { shared } = request;
    if (Option.isSome(certified)) {
      shared.answers.set(agentAddressOf(state.ports.self), certified.value);
    }
    const held = shared.heldClose;
    shared.heldClose = undefined;
    return held === undefined
      ? Effect.void
      : applyClose(state, { operationId, request }, held);
  });
}

/** A close that wins before binding refuses the answer; uncertain commits retain their original outcome. */
function closedResponseFailure(
  state: CollectiveState,
  request: ReceivedRequest,
  operationId: CollectiveId,
  error: SendError,
): Effect.Effect<never, SendError | CollectiveError, SqlClient.SqlClient> {
  if (request.state !== "closed" || error.reason !== "persistence-failed") {
    return Effect.fail(error);
  }
  return durableSend(
    state,
    Store.readCollectiveMessages({
      operationId,
      role: "response",
    }),
  ).pipe(
    Effect.flatMap((messages) =>
      Effect.fail(
        messages.length === 0
          ? collectiveFailure(operationId, { kind: "request-expired" })
          : error,
      ),
    ),
  );
}
