/** @file Shared group results wait for one certified close and its exact answer records. */

import type * as SqlClient from "@effect/sql/SqlClient";
import { Effect, Exit, Schema } from "effect";
import type { CollectiveResultItem } from "./inbound.js";
import type { CertifiedMessage, ResultProvenance } from "./ports.js";
import type { OpenRequest, ReceivedRequest } from "./received-request.js";
import type { CollectiveState, GatherRequest, OpenGather } from "./state.js";
import { SendError } from "../conversations/errors.js";
import { type Message, replyAddress } from "../message.js";
import { MsgId } from "../records/index.js";
import { agentAddressOf } from "../records/values.js";
import * as Store from "../store/index.js";
import {
  encodeRuntimeValue,
  type StoredCollectiveMessage,
} from "../store/index.js";
import {
  closeFailureText,
  type CollectiveClosure,
  type CollectiveEmitError,
  type CollectiveId,
} from "./contracts.js";
import { durableEmit, emitTerminal } from "./persistence.js";
import {
  type HeldClose,
  keepFirstAnswer,
  listedAnswers,
  memberOutcomes,
} from "./shared-answers.js";
import { outcomeOfResponse } from "./validation.js";
import {
  type CollectiveValue,
  encodeCollectiveContent,
  type ResponseValue,
} from "./wire/index.js";
type ClosedOutcome = "completed" | "failed" | "refused";
type CloseValue = Extract<CollectiveValue, { readonly kind: "close" }>;
const contentInvalid = () => new SendError({ reason: "content-invalid" });

/**
 * Send an all_gather's close, listing the message identity of every answer
 * its result counts, and emit the result once the close is certified. A close
 * already bound stays pending on its original message until certification.
 * `close` records the operation's `collective.closed` span once
 * the result or failure is emitted, or could not be.
 */
export function closeAllGather(
  state: CollectiveState,
  open: OpenGather,
  result: CollectiveResultItem,
  close: (
    outcome: ClosedOutcome,
  ) => Effect.Effect<void, never, SqlClient.SqlClient>,
): Effect.Effect<void, CollectiveEmitError, SqlClient.SqlClient> {
  return certifyClose(state, open, result).pipe(
    Effect.matchEffect({
      onFailure: (error) =>
        error._tag === "CollectiveEmitError"
          ? Effect.fail(error)
          : emitTerminal(state, {
              kind: "operationFailed",
              operationId: result.operationId,
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
    answers: open.members.map(agentAddressOf).flatMap((member) => {
      const recordHash = open.answers.get(member)?.recordHash;
      return recordHash === undefined ? [] : [{ member, recordHash }];
    }),
  };
}

/** Only first member answers in this request's group can enter its close selection. */
export function recordPeerAnswer(
  request: Extract<ReceivedRequest, { readonly kind: "all_gather" }>,
  certified: CertifiedMessage,
  value: ResponseValue,
): void {
  const { message } = certified;
  if (
    request.state === "closed" ||
    message.recipients.length <= 1 ||
    replyAddress(message) !== request.to
  ) {
    return;
  }
  keepFirstAnswer(request.shared, agentAddressOf(message.author), {
    authorAgentId: message.author.agentId,
    msgId: message.msgId,
    recordHash: certified.recordHash,
    response: value,
  });
}

/** Only the requester's first close in the original group selects the result. */
export function receiveClose(
  state: CollectiveState,
  message: Message,
  value: CloseValue,
): Effect.Effect<void, CollectiveEmitError, SqlClient.SqlClient> {
  return Effect.suspend(() => {
    const request = state.requests.get(value.operationId);
    if (
      request?.kind !== "all_gather" ||
      message.recipients.length <= 1 ||
      replyAddress(message) !== request.to ||
      message.author.agentId !== request.from.agentId
    ) {
      return Effect.logWarning(
        `consumed close ${message.msgId} from ${agentAddressOf(message.author)}: it closes no all_gather this endpoint was asked by its sender`,
      );
    }
    if (request.state === "closed" || request.shared.heldClose !== undefined) {
      return Effect.void;
    }
    return applyClose(
      state,
      { operationId: value.operationId, request },
      {
        msgId: message.msgId,
        included: value.included,
        closedAt: value.closedAt,
        closedBy: value.closedBy,
      },
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
): Effect.Effect<void, CollectiveEmitError, SqlClient.SqlClient> {
  const { operationId, request } = asked;
  if (state.recovering) {
    request.shared.heldClose ??= close;
    return Effect.void;
  }
  return durableEmit(
    state,
    closeSelection(close).pipe(
      Effect.flatMap((selection) =>
        Store.finalizeCollectiveOperation(operationId, selection),
      ),
    ),
  ).pipe(Effect.zipRight(finishPeerClose(state, asked, close)));
}

function certifyClose(
  state: CollectiveState,
  open: OpenGather,
  result: CollectiveResultItem,
) {
  const { operationId } = result;
  return Effect.gen(function* () {
    const messages = yield* durableEmit(
      state,
      Store.readCollectiveMessages({ operationId }),
    );
    const request = messages.find((message) => message.role === "request");
    if (request !== undefined) {
      yield* observeBoundMessage(state, request);
    }
    const close = messages.find((message) => message.role === "close");
    return yield* close === undefined
      ? sendClose(state, open, result)
      : observeBoundMessage(state, close);
  });
}

function sendClose(
  state: CollectiveState,
  open: OpenGather,
  result: CollectiveResultItem,
) {
  const { operationId, closedAt, closedBy } = result;
  return Effect.gen(function* () {
    const included = open.members.map(agentAddressOf).flatMap((member) => {
      const answer = open.answers.get(member);
      return answer === undefined
        ? []
        : [{ authorAgentId: answer.authorAgentId, msgId: answer.msgId }];
    });
    const content = yield* encodeCollectiveContent({
      kind: "close",
      operationId,
      closedAt,
      closedBy,
      included,
    }).pipe(Effect.mapError(contentInvalid));
    yield* state.ports
      .sendMessage({
        to: open.to,
        content,
        collective: { operationId, role: "close", destination: open.to },
      })
      .pipe(
        Effect.catchTag("SendError", (error) =>
          continueBoundClose(state, operationId, error),
        ),
      );
  });
}

function continueBoundClose(
  state: CollectiveState,
  operationId: CollectiveId,
  error: SendError,
): Effect.Effect<void, SendError | CollectiveEmitError, SqlClient.SqlClient> {
  return Effect.gen(function* () {
    const messages = yield* durableEmit(
      state,
      Store.readCollectiveMessages({
        operationId,
        role: "close",
      }),
    );
    const [bound] = messages;
    if (bound !== undefined) {
      return yield* observeBoundMessage(state, bound).pipe(Effect.asVoid);
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

function observeBoundMessage(
  state: CollectiveState,
  message: StoredCollectiveMessage,
) {
  return Schema.decodeUnknown(MsgId)(message.intent.msgId).pipe(
    Effect.mapError(contentInvalid),
    Effect.flatMap(state.ports.observeMessage),
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
): Effect.Effect<void, CollectiveEmitError, SqlClient.SqlClient> {
  return Effect.suspend(() => {
    const { operationId, request } = asked;
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
            Store.retireCollectiveOperation(operationId, selection),
          ),
        ),
      ).pipe(
        Effect.zipRight(
          Effect.logWarning(
            `consumed close ${close.msgId} of ${operationId}: it lists answers this endpoint does not hold`,
          ),
        ),
      );
    }
    return emitPeerResult(state, asked, answers, close);
  });
}

function emitPeerResult(
  state: CollectiveState,
  asked: GroupRequest,
  answers: SelectedAnswers,
  { closedAt, closedBy }: CollectiveClosure,
) {
  const { operationId, request } = asked;
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
          operationId,
          closedAt,
          closedBy,
          to: request.to,
          question: request.question,
          outcomes: memberOutcomes(request.shared.members, new Map(outcomes)),
        },
        {
          answers: answers
            .filter(
              (answer) => answer.member !== agentAddressOf(state.ports.self),
            )
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
    closedAt: close.closedAt,
    closedBy: close.closedBy,
    msgId: close.msgId,
    included: close.included,
  });
}
