/** @file Collective persistence failures and terminal publication share one boundary. */
import { Effect, Schema } from "effect";
import type { EndpointStoreError } from "../store/index.js";
import type { InboundItem } from "./inbound.js";
import type { ResultProvenance } from "./ports.js";
import type { CollectiveState } from "./state.js";
import { SendError } from "../conversations/errors.js";
import { CollectiveEmitError, CollectiveId } from "./forms.js";

/** Refresh the same retained state on a caller-facing send boundary. */
export function refreshRetainedSend(
  state: CollectiveState,
): Effect.Effect<void, SendError> {
  return durableSend(state, refreshRetained(state));
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
  return durableEmit(state, refreshRetained(state)).pipe(
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
): Effect.Effect<void, EndpointStoreError> {
  return state.ports.store.readCollectiveOperations().pipe(
    Effect.tap((operations) =>
      Effect.sync(() => {
        for (const operation of operations) {
          state.retained.set(
            Schema.decodeUnknownSync(CollectiveId)(operation.operationId),
            operation,
          );
        }
      }),
    ),
    Effect.asVoid,
  );
}
