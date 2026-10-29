/** @file Shared group results wait for one certified close and its exact answer records. */
import { Effect, Exit, Option, Schema } from "effect";
import type { InboundMessage } from "../conversations/message.js";
import type { CertifiedPost, ResultProvenance } from "./ports.js";
import type { OpenRequest, ReceivedRequest } from "./received-request.js";
import type { CollectiveState, GatherRequest, OpenGather } from "./state.js";
import { SendError } from "../conversations/errors.js";
import { PostId } from "../records/index.js";
import {
  encodeRuntimeValue,
  type StoredCollectivePost,
} from "../store/index.js";
import {
  closeFailureText,
  type CollectiveEmitError,
  type CollectiveId,
} from "./contracts.js";
import { durableEmit, emitTerminal } from "./persistence.js";
import {
  type CollectiveResultItem,
  type HeldClose,
  keepFirstAnswer,
  listedAnswers,
  memberOutcomes,
  type ResponseValue,
} from "./shared-answers.js";
import { outcomeOfResponse } from "./validation.js";
import { type CollectiveValue, encodeCollectiveContent } from "./wire/index.js";
type ClosedOutcome = "completed" | "failed" | "refused";
type CloseValue = Extract<CollectiveValue, { readonly kind: "close" }>;
const contentInvalid = () => new SendError({ reason: "content-invalid" });

/**
 * Post an all_gather's close, listing the certified record of every answer
 * its result counts, and emit the result once the close is certified. A close
 * already bound stays pending on its original post until certification.
 * `close` records the operation's `collective.closed` span once
 * the result or failure is emitted, or could not be.
 */
export function closeAllGather(
  state: CollectiveState,
  open: OpenGather,
  result: CollectiveResultItem,
  close: (outcome: ClosedOutcome) => Effect.Effect<void>,
): Effect.Effect<void, CollectiveEmitError> {
  return certifyClose(state, open, result.id).pipe(
    Effect.matchEffect({
      onFailure: (error) =>
        error._tag === "CollectiveEmitError"
          ? Effect.fail(error)
          : emitTerminal(state, {
              kind: "operationFailed",
              id: result.id,
              to: open.to,
              error: closeFailureText(error),
            }).pipe(Effect.as<ClosedOutcome>("failed")),
      onSuccess: () =>
        emitTerminal(state, result, countedProvenance(open)).pipe(
          Effect.as<ClosedOutcome>("completed"),
        ),
    }),
    Effect.onExit((exit) =>
      close(Exit.isSuccess(exit) ? exit.value : "failed"),
    ),
    Effect.asVoid,
  );
}

/** The record of every answer an operation this endpoint started counted, in member order. */
export function countedProvenance(open: GatherRequest): ResultProvenance {
  return {
    answers: open.members.flatMap((member) => {
      const recordHash = open.answerHashes.get(member);
      return recordHash === undefined ? [] : [{ member, recordHash }];
    }),
  };
}

/** Only first member answers in this request's group can enter its close selection. */
export function recordPeerAnswer(
  request: Extract<ReceivedRequest, { readonly kind: "all_gather" }>,
  post: CertifiedPost,
  value: ResponseValue,
): void {
  const { message } = post;
  if (
    request.state === "closed" ||
    message.kind !== "group" ||
    message.address !== request.to
  ) {
    return;
  }
  keepFirstAnswer(request.shared, message.sender, {
    recordHash: post.recordHash,
    response: value,
  });
}

/**
 * Receive an all_gather's close. Only the requester's close in the group
 * conversation of a request this endpoint holds counts. The held request's id
 * derives from its requester, so a close from any other sender names an id
 * that does not derive from that sender; it, and a close for an id this
 * endpoint does not hold, is consumed and logged. Only the first close in the
 * conversation counts, as at every other member: a later one, including one
 * that arrives while the first is held, changes nothing.
 */
export function receiveClose(
  state: CollectiveState,
  message: InboundMessage,
  value: CloseValue,
): Effect.Effect<void, CollectiveEmitError> {
  return Effect.suspend(() => {
    const request = state.requests.get(value.id);
    if (
      request?.kind !== "all_gather" ||
      message.kind !== "group" ||
      message.address !== request.to ||
      message.sender !== request.from
    ) {
      return Effect.logWarning(
        `consumed close ${message.postId} from ${message.sender}: it closes no all_gather this endpoint was asked by its sender`,
      );
    }
    if (request.state === "closed" || request.shared.heldClose !== undefined) {
      return Effect.void;
    }
    return applyClose(
      state,
      { id: value.id, request },
      { postId: message.postId, included: value.included },
    );
  });
}

/**
 * Build a member's all_gather result from exactly the answers a close lists,
 * and emit it.
 *
 * Every listed answer precedes the close in the group conversation's
 * certified chain. The store appends a conversation's records only in chain
 * order and pending deliveries are read in that order, so each peer answer
 * the close lists was recorded before the close is classified. The member's
 * own answer is not delivered inbound: it is recorded when its send returns,
 * and a close that arrives while that send is in flight is held until it
 * returns. A listed record the endpoint still does not hold, or one listed
 * twice, means the close does not describe this endpoint's history; it is
 * consumed and logged, and no result
 * is emitted. Once closed, the request keeps no answers.
 */
export function applyClose(
  state: CollectiveState,
  asked: OpenRequest<Extract<ReceivedRequest, { readonly kind: "all_gather" }>>,
  close: HeldClose,
): Effect.Effect<void, CollectiveEmitError> {
  const { id, request } = asked;
  if (state.recovering) {
    request.shared.heldClose ??= close;
    return Effect.void;
  }
  return durableEmit(
    state,
    closeSelection(close).pipe(
      Effect.flatMap((selection) =>
        state.ports.store.finalizeCollectiveOperation(id, selection),
      ),
    ),
  ).pipe(Effect.zipRight(finishPeerClose(state, asked, close)));
}

function certifyClose(
  state: CollectiveState,
  open: OpenGather,
  id: CollectiveId,
) {
  return Effect.gen(function* () {
    const posts = yield* durableEmit(
      state,
      state.ports.store.readCollectivePosts(),
    );
    const request = posts.find(
      (post) => post.operationId === id && post.role === "request",
    );
    if (request !== undefined) {
      yield* observeBoundPost(state, request);
    }
    const close = posts.find(
      (post) => post.operationId === id && post.role === "close",
    );
    return yield* close === undefined
      ? sendClose(state, open, id)
      : observeBoundPost(state, close);
  });
}

function sendClose(state: CollectiveState, open: OpenGather, id: CollectiveId) {
  return Effect.gen(function* () {
    const included = open.members.flatMap((member) =>
      Option.toArray(Option.fromNullable(open.answerHashes.get(member))),
    );
    const content = yield* encodeCollectiveContent({
      kind: "close",
      id,
      included,
    }).pipe(Effect.mapError(contentInvalid));
    yield* state.ports
      .sendPost({
        to: open.to,
        content,
        collective: { operationId: id, role: "close", destination: open.to },
      })
      .pipe(
        Effect.catchTag("SendError", (error) =>
          continueBoundClose(state, id, error),
        ),
      );
  });
}

function continueBoundClose(
  state: CollectiveState,
  id: CollectiveId,
  error: SendError,
): Effect.Effect<void, SendError | CollectiveEmitError> {
  return Effect.gen(function* () {
    const posts = yield* durableEmit(
      state,
      state.ports.store.readCollectivePosts(),
    );
    const bound = posts.find(
      (post) => post.operationId === id && post.role === "close",
    );
    if (bound !== undefined) {
      return yield* observeBoundPost(state, bound).pipe(Effect.asVoid);
    }
    if (
      error.reason === "delivery-pending" ||
      error.reason === "outcome-unknown"
    ) {
      return yield* Effect.never;
    }
    return yield* error;
  });
}

function observeBoundPost(state: CollectiveState, post: StoredCollectivePost) {
  return Schema.decodeUnknown(PostId)(post.intent.postId).pipe(
    Effect.mapError(contentInvalid),
    Effect.flatMap(state.ports.observePost),
  );
}

type GroupRequest = OpenRequest<
  Extract<ReceivedRequest, { readonly kind: "all_gather" }>
>;
type SelectedAnswers = ReturnType<typeof listedAnswers>["answers"];

function finishPeerClose(
  state: CollectiveState,
  asked: GroupRequest,
  close: HeldClose,
): Effect.Effect<void, CollectiveEmitError> {
  return Effect.suspend(() => {
    const { id, request } = asked;
    const { answers, missing, repeated } = listedAnswers(
      request.shared,
      close.included,
    );
    if (missing && request.state === "sending") {
      request.shared.heldClose = close;
      return Effect.void;
    }
    request.state = "closed";
    request.shared.answers.clear();
    if (missing || repeated) {
      return durableEmit(
        state,
        closeSelection(close).pipe(
          Effect.flatMap((selection) =>
            state.ports.store.retireCollectiveOperation(id, selection),
          ),
        ),
      ).pipe(
        Effect.zipRight(
          Effect.logWarning(
            `consumed close ${close.postId} of ${id}: it lists answers this endpoint does not hold`,
          ),
        ),
      );
    }
    return emitPeerResult(state, asked, answers);
  });
}

function emitPeerResult(
  state: CollectiveState,
  asked: GroupRequest,
  answers: SelectedAnswers,
) {
  const { id, request } = asked;
  return Effect.forEach(
    answers,
    (answer) =>
      outcomeOfResponse(request.requestedSchema, answer.response).pipe(
        Effect.map((outcome) => [answer.member, outcome] as const),
      ),
    { concurrency: 1 },
  ).pipe(
    Effect.flatMap((outcomes) =>
      emitTerminal(
        state,
        {
          kind: "collectiveResult",
          op: "all_gather",
          id,
          to: request.to,
          question: request.question,
          outcomes: memberOutcomes(request.shared.members, new Map(outcomes)),
        },
        {
          answers: answers
            .filter((answer) => answer.member !== state.ports.self)
            .map(({ member, recordHash }) => ({ member, recordHash })),
          request: request.recordHash,
        },
      ),
    ),
  );
}

function closeSelection(close: HeldClose) {
  return encodeRuntimeValue({
    kind: "close",
    postId: close.postId,
    included: close.included,
  });
}
