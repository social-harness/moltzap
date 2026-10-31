/** @file Records answers and completes collective operations this endpoint starts. */

import type * as SqlClient from "@effect/sql/SqlClient";
import { Clock, Effect, Exit, Fiber } from "effect";
import type { SendError } from "../conversations/errors.js";
import type { RecordHash } from "../records/index.js";
import type { CollectiveResultItem } from "./inbound.js";
import type { CertifiedMessage } from "./ports.js";
import type { ResponseValue } from "./wire/index.js";
import { type Message, replyAddress } from "../message.js";
import { type AgentAddress, agentAddressOf } from "../records/values.js";
import * as Store from "../store/index.js";
import { encodeRuntimeValue, EndpointStoreError } from "../store/index.js";
import { closeAllGather, countedProvenance } from "./all-gather.js";
import {
  type CollectiveClosure,
  type CollectiveEmitError,
  CollectiveError,
  type CollectiveId,
} from "./contracts.js";
import {
  durableEmit,
  durableSend,
  emitTerminal,
  refreshRetained,
} from "./persistence.js";
import { type RequestRefusal, sleepUntil } from "./request-sends.js";
import { memberOutcomes } from "./shared-answers.js";
import {
  type CollectiveState,
  type OpenGather,
  type PreparedGather,
  readCollectiveSelection,
} from "./state.js";
import { outcomeOfResponse } from "./validation.js";

type ClosedOutcome = "completed" | "failed" | "refused";

/** A confirmed refusal and its no-answer outcome settle the member in one retained transition. */
export function recordRefusal(
  state: CollectiveState,
  operationId: CollectiveId,
  refusal: RequestRefusal,
): Effect.Effect<void, never, SqlClient.SqlClient> {
  if (
    refusal.reason === "delivery-pending" ||
    refusal.reason === "outcome-unknown"
  ) {
    return Effect.void;
  }
  return state.transitions
    .withPermits(1)(
      Effect.uninterruptible(
        Effect.gen(function* () {
          const open = state.gathers.get(operationId);
          if (open === undefined) {
            return;
          }
          yield* durableEmit(
            state,
            encodeRuntimeValue(refusal).pipe(
              Effect.flatMap((canonicalRefusal) =>
                Store.recordCollectiveRefusal({
                  operationId,
                  destination: refusal.member,
                  canonicalRefusal,
                }),
              ),
            ),
          );
          if (!open.outcomes.has(refusal.member)) {
            open.outcomes.set(refusal.member, { kind: "no-answer" });
          }
        }),
      ),
    )
    .pipe(
      Effect.zipRight(completeAnsweredGather(state, operationId)),
      Effect.ignore,
      Effect.withSpan("recordRefusal"),
    );
}

/**
 * Apply a change to an open gather, then complete it once its send has
 * returned and every member has an outcome. Until the send returns, only the
 * send decides whether the gather is refused, so no path can emit both a
 * refusal and a result.
 */
export function updateGather(
  state: CollectiveState,
  operationId: CollectiveId,
  change: (open: OpenGather) => void,
): Effect.Effect<void, CollectiveEmitError, SqlClient.SqlClient> {
  return state.transitions
    .withPermits(1)(
      Effect.sync(() => {
        const open = state.gathers.get(operationId);
        if (open !== undefined) {
          change(open);
        }
      }),
    )
    .pipe(Effect.zipRight(completeAnsweredGather(state, operationId)));
}

/**
 * Opens answer matching for a live or recovered request.
 * Rejects expired requests outside recovery.
 */
export function openGather(
  state: CollectiveState,
  prepared: PreparedGather,
  requestsSettled: boolean,
): Effect.Effect<void, CollectiveError, SqlClient.SqlClient> {
  return Effect.gen(function* () {
    if (
      !state.recovering &&
      (yield* Clock.currentTimeMillis) >= prepared.deadlineAt
    ) {
      return yield* new CollectiveError({
        operationId: prepared.operationId,
        failure: { kind: "deadline-passed" },
      });
    }
    const firstOpening = yield* Effect.sync(() => {
      state.gathers.set(prepared.operationId, {
        ...prepared.open,
        deadlineAt: prepared.deadlineAt,
        requestsSettled,
      });
      const first = !state.announced.has(prepared.operationId);
      state.announced.add(prepared.operationId);
      return first;
    });
    if (!firstOpening) {
      return;
    }
    yield* Effect.withSpan(Effect.void, "collective.opened", {
      captureStackTrace: false,
      attributes: {
        operationId: prepared.operationId,
        op: prepared.open.op,
        deadlineAt: prepared.deadlineAt,
      },
    });
  });
}

/**
 * Releases an unaccepted operation so admission can retry without repeating
 * its opening event. An accepted operation starts or keeps its deadline timer.
 */
export function releaseUnboundGather(
  state: CollectiveState,
  operationId: CollectiveId,
): Effect.Effect<void, never, SqlClient.SqlClient> {
  return durableEmit(state, refreshRetained(state, operationId)).pipe(
    Effect.flatMap(() =>
      state.retained.has(operationId)
        ? armRetainedGather(state, operationId)
        : releaseGather(state, operationId),
    ),
    Effect.ignore,
  );
}

/**
 * Starts the deadline timer only after durable acceptance.
 */
export function armRetainedGather(
  state: CollectiveState,
  operationId: CollectiveId,
): Effect.Effect<void, never, SqlClient.SqlClient> {
  return durableEmit(state, refreshRetained(state, operationId)).pipe(
    Effect.flatMap(() =>
      state.transitions.withPermits(1)(
        Effect.gen(function* () {
          const open = state.gathers.get(operationId);
          if (
            open === undefined ||
            open.timer !== undefined ||
            state.retained.get(operationId)?.phase !== "collecting"
          ) {
            return;
          }
          const timer = yield* sleepUntil(open.deadlineAt).pipe(
            Effect.zipRight(Effect.ignore(completeGather(state, operationId))),
            Effect.interruptible,
            Effect.forkIn(state.ports.scope),
          );
          open.timer = timer;
        }),
      ),
    ),
    Effect.ignore,
    Effect.withSpan("armRetainedGather"),
  );
}

/** Retains the first matching answer before updating its outcome under the transition permit. */
export function recordCountedAnswer(
  state: CollectiveState,
  open: OpenGather,
  certified: CertifiedMessage,
  value: ResponseValue,
): Effect.Effect<void, CollectiveEmitError, SqlClient.SqlClient> {
  return state.transitions
    .withPermits(1)(
      Effect.uninterruptible(
        Effect.gen(function* () {
          const { message } = certified;
          const member = open.members.find(
            (candidate) => candidate.agentId === message.author.agentId,
          );
          if (
            state.gathers.get(value.operationId) !== open ||
            !answeredInConversation(open, message) ||
            member === undefined ||
            open.outcomes.has(agentAddressOf(member))
          ) {
            return;
          }
          const answer = {
            operationId: value.operationId,
            member: agentAddressOf(member),
            recordHash: certified.recordHash,
            authorAgentId: message.author.agentId,
            msgId: message.msgId,
          };
          if (!(yield* retainCountedAnswer(state, open, answer))) {
            return;
          }
          const outcome = yield* outcomeOfResponse(open.requestedSchema, value);
          open.outcomes.set(answer.member, outcome);
          open.answers.set(answer.member, answer);
        }),
      ),
    )
    .pipe(
      Effect.zipRight(completeAnsweredGather(state, value.operationId)),
      Effect.withSpan("recordCountedAnswer"),
    );
}

/**
 * Completes an operation at most once and owns its closing span until
 * publication finishes. Waits for a gather's result. All-gather sends its close
 * in the endpoint scope because certification may depend on the calling
 * publication pass. The caller remains responsible for stopping the deadline
 * timer.
 */
export function completeGather(
  state: CollectiveState,
  operationId: CollectiveId,
): Effect.Effect<void, CollectiveEmitError, SqlClient.SqlClient> {
  return Effect.uninterruptibleMask((restore) =>
    state.transitions
      .withPermits(1)(takeGatherCompletion(state, operationId))
      .pipe(
        Effect.flatMap((completion) =>
          completion === undefined
            ? Effect.void
            : finishGather(state, operationId, completion).pipe(
                Effect.interruptible,
                Effect.forkIn(state.ports.scope),
                Effect.flatMap((fiber) =>
                  completion.open.op === "gather"
                    ? restore(Fiber.join(fiber))
                    : Effect.void,
                ),
              ),
        ),
      ),
  );
}

/**
 * Retirement and deadline selection claim one terminal outcome before either cancels the timer.
 */
export function forgetGather(
  state: CollectiveState,
  operationId: CollectiveId,
): Effect.Effect<boolean, SendError, SqlClient.SqlClient> {
  return state.transitions
    .withPermits(1)(
      Effect.uninterruptible(
        Effect.gen(function* () {
          const operation = yield* durableSend(
            state,
            Store.readCollectiveOperation(operationId),
          );
          if (operation !== undefined && operation.phase !== "collecting") {
            return;
          }
          if (operation !== undefined) {
            const selection = yield* durableSend(
              state,
              encodeRuntimeValue({ kind: "refused" }),
            );
            yield* durableSend(
              state,
              Store.retireCollectiveOperation(operationId, selection),
            );
          }
          const open = state.gathers.get(operationId);
          state.gathers.delete(operationId);
          const announced = state.announced.delete(operationId);
          return { timer: open?.timer, announced };
        }).pipe(Effect.withSpan("forgetGather")),
      ),
    )
    .pipe(
      Effect.flatMap((retired) => {
        if (retired === undefined) {
          return Effect.succeed(false);
        }
        const stopped =
          retired.timer === undefined
            ? Effect.void
            : Fiber.interrupt(retired.timer);
        const closed = retired.announced
          ? closedSpan(operationId, "refused")
          : Effect.void;
        return stopped.pipe(Effect.zipRight(closed), Effect.as(true));
      }),
    );
}

/**
 * Record `collective.closed` as `refused` for an abandoned operation that
 * recorded `collective.opened` and whose completion does not already own the
 * span.
 */
export function markRefused(
  state: CollectiveState,
  operationId: CollectiveId,
): Effect.Effect<void, never, SqlClient.SqlClient> {
  return Effect.suspend(() =>
    state.announced.delete(operationId)
      ? closedSpan(operationId, "refused")
      : Effect.void,
  );
}

function completeAnsweredGather(
  state: CollectiveState,
  operationId: CollectiveId,
): Effect.Effect<void, CollectiveEmitError, SqlClient.SqlClient> {
  return Effect.suspend(() => {
    const open = state.gathers.get(operationId);
    if (open === undefined) {
      return Effect.void;
    }
    if (
      state.recovering ||
      !open.requestsSettled ||
      open.outcomes.size !== open.members.length
    ) {
      return Effect.void;
    }
    return completeGather(state, operationId).pipe(
      Effect.zipRight(
        open.timer === undefined ? Effect.void : Fiber.interrupt(open.timer),
      ),
    );
  });
}

function takeGatherCompletion(
  state: CollectiveState,
  operationId: CollectiveId,
) {
  return Effect.gen(function* () {
    const open = state.gathers.get(operationId);
    if (open === undefined) {
      return;
    }
    const closure = yield* freezeResult(state, operationId, open);
    state.gathers.delete(operationId);
    const announced = state.announced.delete(operationId);
    return { open, announced, closure };
  });
}

/** Retains the first completion decision. The caller holds the transition permit through selection. */
function freezeResult(
  state: CollectiveState,
  operationId: CollectiveId,
  open: OpenGather,
): Effect.Effect<CollectiveClosure, CollectiveEmitError, SqlClient.SqlClient> {
  return durableEmit(
    state,
    Effect.gen(function* () {
      const operation = yield* Store.readCollectiveOperation(operationId);
      if (operation?.canonicalSelection !== undefined) {
        const selection = yield* readCollectiveSelection(
          operation.canonicalSelection,
        );
        if (selection.kind !== "result") {
          return yield* new EndpointStoreError({ reason: "corrupt" });
        }
        return { closedAt: selection.closedAt, closedBy: selection.closedBy };
      }
      const closure: CollectiveClosure = {
        closedAt: yield* Clock.currentTimeMillis,
        closedBy:
          open.outcomes.size === open.members.length ? "settled" : "deadline",
      };
      const selection = yield* encodeRuntimeValue({
        kind: "result",
        ...closure,
        answers: [...open.answers].map(([member, answer]) => ({
          member,
          recordHash: answer.recordHash,
        })),
      });
      yield* Store.finalizeCollectiveOperation(operationId, selection);
      return closure;
    }),
  ).pipe(Effect.withSpan("freezeResult"));
}

function finishGather(
  state: CollectiveState,
  operationId: CollectiveId,
  {
    open,
    announced,
    closure,
  }: {
    readonly open: OpenGather;
    readonly announced: boolean;
    readonly closure: CollectiveClosure;
  },
): Effect.Effect<void, CollectiveEmitError, SqlClient.SqlClient> {
  const close = (outcome: ClosedOutcome) =>
    announced ? closedSpan(operationId, outcome) : Effect.void;
  const result: CollectiveResultItem = {
    kind: "collectiveResult",
    op: open.op,
    operationId,
    ...closure,
    to: open.to,
    question: open.question,
    outcomes: memberOutcomes(open.members, open.outcomes),
  };
  switch (open.op) {
    case "gather":
      return emitTerminal(state, result, countedProvenance(open)).pipe(
        Effect.onExit((exit) =>
          close(Exit.isSuccess(exit) ? "completed" : "failed"),
        ),
      );
    case "all_gather":
      return closeAllGather(state, open, result, close);
    default: {
      const exhaustive: never = open.op;
      return exhaustive;
    }
  }
}

function retainCountedAnswer(
  state: CollectiveState,
  open: OpenGather,
  answer: {
    readonly operationId: CollectiveId;
    readonly member: AgentAddress;
    readonly recordHash: RecordHash;
  },
) {
  return Effect.gen(function* () {
    if (state.recovering) {
      return (
        state.counted.get(answer.operationId)?.get(answer.member) ===
        answer.recordHash
      );
    }
    if ((yield* Clock.currentTimeMillis) >= open.deadlineAt) {
      return false;
    }
    return (
      (yield* durableEmit(state, Store.recordCollectiveAnswer(answer))) ===
      answer.recordHash
    );
  });
}

function answeredInConversation(open: OpenGather, message: Message): boolean {
  switch (open.op) {
    case "gather":
      return message.recipients.length === 1;
    case "all_gather":
      return message.recipients.length > 1 && replyAddress(message) === open.to;
    default: {
      const exhaustive: never = open.op;
      return exhaustive;
    }
  }
}

function releaseGather(
  state: CollectiveState,
  operationId: CollectiveId,
): Effect.Effect<void, never, SqlClient.SqlClient> {
  return Effect.suspend(() => {
    const open = state.gathers.get(operationId);
    state.gathers.delete(operationId);
    return open?.timer === undefined
      ? Effect.void
      : Fiber.interrupt(open.timer);
  });
}

function closedSpan(operationId: CollectiveId, outcome: ClosedOutcome) {
  return Effect.withSpan(Effect.void, "collective.closed", {
    captureStackTrace: false,
    attributes: { operationId, outcome },
  });
}
