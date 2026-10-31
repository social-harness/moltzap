/** @file One retained response claim stays attached to its original certified message. */

import type * as SqlClient from "@effect/sql/SqlClient";
import { Clock, Effect, Either, Option, Schema } from "effect";
import type { CollectiveSendError } from "./ports.js";
import type { RecordedAnswer } from "./shared-answers.js";
import type { CollectiveState } from "./state.js";
import { SendError } from "../conversations/errors.js";
import {
  type BindHold,
  type EngineSentMessage,
  type PreparedSend,
  preparedSendData,
  resolutionFailure,
} from "../conversations/index.js";
import { MessageIntent, MsgId, RecordHash } from "../records/index.js";
import {
  type AgentAddress,
  agentAddressOf,
  type GroupAddress,
} from "../records/values.js";
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
  type ReceivedRequest,
  unmatchedAnswerError,
} from "./received-request.js";
import { validateAnswer } from "./validation.js";
import {
  encodeCollectiveContent,
  readCollectiveValue,
  type ResponseValue,
} from "./wire/index.js";
const contentInvalid = () => new SendError({ reason: "content-invalid" });
const collectiveFailure = (
  operationId: CollectiveId,
  failure: CollectiveFailure,
) => new CollectiveError({ operationId, failure });

/** Validate the named request and create one immutable answer message. */
export function makeAnswerMessage(
  state: CollectiveState,
  to: AgentAddress | GroupAddress,
  response: CollectiveResponse,
) {
  return Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const { operationId, request } = yield* matchOpenRequest(
      state.requests,
      to,
      now,
      response,
    ).pipe(Effect.mapError((unmatched) => unmatchedAnswerError(unmatched)));
    const value: ResponseValue = { ...response, kind: "response", operationId };
    if (value.action === "accept") {
      yield* validateAnswer(request.requestedSchema, value.content).pipe(
        Effect.mapError((fields) =>
          collectiveFailure(operationId, { kind: "answer-invalid", fields }),
        ),
      );
    }
    const content = yield* encodeCollectiveContent(value).pipe(
      Effect.mapError(contentInvalid),
    );
    return yield* state.ports
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
  }).pipe(Effect.withSpan("makeAnswerMessage"));
}

/** Claim one answer using the exact message assessed by the caller. */
export function answer(
  state: CollectiveState,
  message: PreparedSend,
): Effect.Effect<
  CollectiveSendOutcome,
  CollectiveSendError,
  SqlClient.SqlClient
> {
  return Effect.gen(function* () {
    const value = yield* decodeAnswer(message);
    const { operationId } = value;
    const request = state.requests.get(operationId);
    if (
      request === undefined ||
      request.to !== message.collective?.destination
    ) {
      return yield* collectiveFailure(operationId, { kind: "request-none" });
    }
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
          Effect.ignore(recordOwnAnswer(state, request, value, sent)),
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
  }).pipe(Effect.withSpan("answer"));
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
      yield* recordOwnAnswer(state, request, response, {
        msgId: intent.msgId,
        recordHash,
      }).pipe(
        Effect.catchTag("CollectiveEmitError", () =>
          Effect.fail(new EndpointStoreError({ reason: "persistence" })),
        ),
      );
    } else {
      yield* observeResponse(state, request, response, intent.msgId);
    }
  }).pipe(Effect.withSpan("restoreResponse"));
}

/** The answer payload and durable claim must name the same request. */
function decodeAnswer(
  message: PreparedSend,
): Effect.Effect<ResponseValue, SendError> {
  return Effect.gen(function* () {
    const snapshot = yield* readCollectiveValue(
      (yield* preparedSendData(message)).intent.content,
    ).pipe(
      Effect.catchTag("CollectivePartInvalidError", () => contentInvalid()),
    );
    if (
      Option.isNone(snapshot) ||
      snapshot.value.kind !== "response" ||
      message.collective?.role !== "response" ||
      snapshot.value.operationId !== message.collective.operationId
    ) {
      return yield* contentInvalid();
    }
    return snapshot.value;
  });
}

/**
 * Hold the selected request's one answer while it is still open in its
 * conversation and before its deadline,
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
    Effect.flatMap((sent) => recordOwnAnswer(state, request, response, sent)),
    Effect.ignore,
    Effect.interruptible,
    Effect.forkIn(state.ports.scope),
    Effect.asVoid,
  );
}

/** A member's own certified answer participates in the same close selection as peer answers. */
function recordOwnAnswer(
  state: CollectiveState,
  request: ReceivedRequest,
  response: ResponseValue,
  sent: EngineSentMessage,
) {
  return settleAnswer(
    state,
    response.operationId,
    request,
    Option.some({
      authorAgentId: state.ports.self.agentId,
      ...sent,
      response,
    }),
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
  certified: Option.Option<RecordedAnswer>,
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
