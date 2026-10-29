/** @file Collective persistence failures and terminal publication share one boundary. */
import { Clock, Effect } from "effect";
import type { InboundItem } from "./inbound.js";
import type { ResultProvenance } from "./ports.js";
import { SendError } from "../conversations/errors.js";
import { encodeRuntimeValue, EndpointStoreError } from "../store/index.js";
import {
  type CollectiveClosure,
  CollectiveEmitError,
  type CollectiveId,
} from "./contracts.js";
import {
  type CollectiveState,
  type OpenGather,
  readCollectiveSelection,
} from "./state.js";

/** Refresh the same retained state on a caller-facing send boundary. */
export function refreshRetainedSend(
  state: CollectiveState,
  id: CollectiveId,
): Effect.Effect<void, SendError> {
  return durableSend(state, refreshRetained(state, id));
}

/** An uncertain persistence outcome cannot authorize a second post. */
export function durableSend<A>(
  state: CollectiveState,
  effect: Effect.Effect<A, EndpointStoreError>,
): Effect.Effect<A, SendError> {
  return effect.pipe(
    Effect.catchTag("EndpointStoreError", (error) =>
      state.ports
        .reportStorageFault(error)
        .pipe(
          Effect.zipRight(
            Effect.fail(new SendError({ reason: "outcome-unknown" })),
          ),
        ),
    ),
  );
}

/** Terminal publication reuses the operation's retained token, including after a crash before acknowledgment. */
export function emitTerminal(
  state: CollectiveState,
  item: Extract<
    InboundItem,
    { readonly kind: "collectiveResult" | "operationFailed" }
  >,
  provenance?: ResultProvenance,
): Effect.Effect<void, CollectiveEmitError> {
  return durableEmit(state, refreshRetained(state, item.id)).pipe(
    Effect.flatMap(() => {
      const operation = state.retained.get(item.id);
      return operation === undefined
        ? Effect.fail(new CollectiveEmitError())
        : state.ports.emit(item, provenance, {
            operationId: item.id,
            deliveryToken: operation.deliveryToken,
          });
    }),
  );
}

/** Retains the first completion decision. The caller holds the transition permit through selection. */
export function freezeResult(
  state: CollectiveState,
  id: CollectiveId,
  open: OpenGather,
): Effect.Effect<CollectiveClosure, CollectiveEmitError> {
  return durableEmit(
    state,
    Effect.gen(function* () {
      const operation = yield* state.ports.store.readCollectiveOperation(id);
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
        answers: [...open.answerHashes].map(([member, recordHash]) => ({
          member,
          recordHash,
        })),
      });
      yield* state.ports.store.finalizeCollectiveOperation(id, selection);
      return closure;
    }),
  ).pipe(Effect.withSpan("freezeResult"));
}

/** Persistence failures stop the daemon before a caller can mistake an uncertain write for a retryable refusal. */
export function durableEmit<A>(
  state: CollectiveState,
  effect: Effect.Effect<A, EndpointStoreError>,
): Effect.Effect<A, CollectiveEmitError> {
  return effect.pipe(
    Effect.catchTag("EndpointStoreError", (error) =>
      state.ports
        .reportStorageFault(error)
        .pipe(Effect.zipRight(Effect.fail(new CollectiveEmitError()))),
    ),
  );
}

/** Reload phase and terminal identity after their atomic store transitions. */
export function refreshRetained(
  state: CollectiveState,
  id: CollectiveId,
): Effect.Effect<void, EndpointStoreError> {
  return state.ports.store.readCollectiveOperation(id).pipe(
    Effect.tap((operation) =>
      Effect.sync(() => {
        if (operation === undefined) {
          state.retained.delete(id);
        } else {
          state.retained.set(id, operation);
        }
      }),
    ),
    Effect.asVoid,
  );
}
