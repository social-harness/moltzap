/** @file One retained response claim stays attached to its original certified message. */
import { Clock, Effect, Either, Option, Schema } from "effect";
import type { CertifiedAnswer } from "./shared-answers.js";
import type { CollectiveState } from "./state.js";
import { canonicalMessageAddress } from "../conversations/address.js";
import { SendError } from "../conversations/errors.js";
import {
  agentNameOf,
  type Content,
  type MessageAddressInput,
  MsgId,
  MessageIntent,
  RecordHash,
} from "../records/index.js";
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
  bindAuthoredMessage,
  type BindHold,
  type CollectiveSendError,
} from "./ports.js";
import {
  matchOpenRequest,
  type OpenRequest,
  type ReceivedRequest,
  unmatchedAnswerError,
} from "./received-request.js";
import { validateAnswer } from "./validation.js";
import {
  encodeCollectiveContent,
  mintCollectiveId,
  readCollectiveValue,
  type ResponseValue,
} from "./wire/index.js";
type MessageContent = Content;
const contentInvalid = () => new SendError({ reason: "content-invalid" });
const collectiveFailure = (id: CollectiveId, failure: CollectiveFailure) =>
  new CollectiveError({ id, failure });

/**
 * Answer a request open in the conversation `to` names: the one the answer's
 * `id` names, or without one the one request open there; when no request is
 * matched, nothing is sent. An installed firewall checks the answer before
 * `claimRequest` claims the matched request by its id, so a close or the
 * deadline landing during the check refuses the answer without sending, and a
 * request opening during it does not change which one is answered. When the
 * item that settling the answer emits cannot be kept, the answer keeps its own
 * outcome, its message or its refusal.
 */
export function respond(
  state: CollectiveState,
  to: MessageAddressInput,
  response: CollectiveResponse,
): Effect.Effect<CollectiveSendOutcome, CollectiveSendError> {
  return Effect.gen(function* () {
    const { id, request } = yield* openRequest(state, to, response);
    const value: ResponseValue = { ...response, kind: "response", id };
    const { certified, guidance } = yield* bindResponse(state, request, value);
    const { msgId } = yield* certified.pipe(
      Effect.tapBoth({
        onFailure: (error) =>
          settleUncertifiedAnswer(state, request, value, error),
        onSuccess: (sent) =>
          Effect.ignore(
            settleAnswer(
              state,
              id,
              request,
              Option.some({ recordHash: sent.recordHash, response: value }),
            ),
          ),
      }),
      Effect.onInterrupt(() => settleUncertifiedAnswer(state, request, value)),
    );
    return {
      kind: "response",
      operationId: id,
      msgIds: [msgId],
      msgId,
      address: request.to,
      ...(guidance === undefined ? {} : { guidance }),
    } satisfies CollectiveSendOutcome;
  }).pipe(Effect.withSpan("respond"));
}

/** A retained response claim stays unavailable while its original intent certifies. */
export function restoreResponse(
  state: CollectiveState,
  message: StoredCollectiveMessage,
): Effect.Effect<void, EndpointStoreError> {
  return Effect.gen(function* () {
    const intent = yield* decodeRuntimeValue(
      MessageIntent,
      message.intent.canonicalIntent,
    );
    const value = yield* readCollectiveValue(intent.content).pipe(
      Effect.catchTag("CollectivePartInvalidError", () =>
        Effect.fail(new EndpointStoreError({ reason: "corrupt" })),
      ),
    );
    if (Option.isNone(value) || value.value.kind !== "response") {
      return yield* new EndpointStoreError({ reason: "corrupt" });
    }
    const response = value.value;
    const request = state.requests.get(response.id);
    if (request === undefined || request.state === "closed") {
      return;
    }
    request.state = "sending";
    if (message.intent.completedRecordHash !== undefined) {
      const recordHash = yield* Schema.decodeUnknown(RecordHash)(
        message.intent.completedRecordHash,
      ).pipe(
        Effect.catchTag("ParseError", () =>
          Effect.fail(new EndpointStoreError({ reason: "corrupt" })),
        ),
      );
      yield* settleAnswer(
        state,
        response.id,
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

/** Response binding confirms a still-open request and distinguishes a close from storage uncertainty. */
function bindResponse(
  state: CollectiveState,
  request: ReceivedRequest,
  value: ResponseValue,
) {
  return Effect.gen(function* () {
    const id = value.id;
    const content = yield* responseContent(request, value);
    return yield* bindAuthoredMessage(
      state.ports,
      {
        to: request.to,
        content,
        collective: {
          operationId: id,
          role: "response",
          destination: request.to,
        },
      },
      claimRequest(state, request, value),
    ).pipe(
      Effect.catchTag("SendError", (error) =>
        closedResponseFailure(state, request, id, error),
      ),
    );
  });
}

/**
 * The request `response` answers in the conversation `to` names. A refusal
 * names an id minted for it, since no request is answered.
 */
function openRequest(
  state: CollectiveState,
  to: MessageAddressInput,
  response: CollectiveResponse,
): Effect.Effect<OpenRequest<ReceivedRequest>, SendError | CollectiveError> {
  return Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const { id } = yield* mintCollectiveId(state.ports.self);
    const self = agentNameOf(state.ports.self);
    const { address } = yield* canonicalMessageAddress(to, self);
    return yield* matchOpenRequest(state.requests, address, now, response).pipe(
      Effect.mapError((unmatched) => unmatchedAnswerError(id, unmatched)),
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
): Effect.Effect<MessageContent, SendError | CollectiveError> {
  const validated =
    response.action === "accept"
      ? validateAnswer(request.requestedSchema, response.content).pipe(
          Effect.mapError((fields) =>
            collectiveFailure(response.id, { kind: "answer-invalid", fields }),
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
 * again by its id, still open in its conversation and before its deadline,
 * and claim it. The match and the claim run in one step, with no yield
 * between them, so of two concurrent answers only one is sent. The hold's
 * release reopens a request whose answer bound nothing.
 */
function claimRequest(
  state: CollectiveState,
  request: ReceivedRequest,
  response: ResponseValue,
): BindHold<CollectiveError> {
  const { id } = response;
  return Clock.currentTimeMillis.pipe(
    Effect.flatMap((now) =>
      Effect.suspend(() =>
        Either.match(
          matchOpenRequest(state.requests, request.to, now, { id }),
          {
            onLeft: (unmatched) =>
              Effect.fail(unmatchedAnswerError(id, unmatched)),
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
): Effect.Effect<void> {
  const id = response.id;
  return durableEmit(
    state,
    state.ports.store.readCollectiveMessages({
      operationId: id,
      role: "response",
    }),
  ).pipe(
    Effect.flatMap((messages) => {
      const [bound] = messages;
      if (bound === undefined) {
        return failure?.reason === "delivery-pending" ||
          failure?.reason === "outcome-unknown"
          ? Effect.void
          : settleAnswer(state, id, request, Option.none());
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
): Effect.Effect<void> {
  return state.ports.observeMessage(msgId).pipe(
    Effect.flatMap((sent) =>
      settleAnswer(
        state,
        response.id,
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
  id: CollectiveId,
  request: ReceivedRequest,
  certified: Option.Option<CertifiedAnswer>,
): Effect.Effect<void, CollectiveEmitError> {
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
      shared.answers.set(state.ports.self, certified.value);
    }
    const held = shared.heldClose;
    shared.heldClose = undefined;
    return held === undefined
      ? Effect.void
      : applyClose(state, { id, request }, held);
  });
}

/** A close that wins before binding refuses the answer; uncertain commits retain their original outcome. */
function closedResponseFailure(
  state: CollectiveState,
  request: ReceivedRequest,
  id: CollectiveId,
  error: SendError,
): Effect.Effect<never, SendError | CollectiveError> {
  if (request.state !== "closed" || error.reason !== "persistence-failed") {
    return Effect.fail(error);
  }
  return durableSend(
    state,
    state.ports.store.readCollectiveMessages({
      operationId: id,
      role: "response",
    }),
  ).pipe(
    Effect.flatMap((messages) =>
      Effect.fail(
        messages.length === 0
          ? collectiveFailure(id, { kind: "request-expired" })
          : error,
      ),
    ),
  );
}
