/** @file Recovery of durable action-certified-record send obligations. */

import type * as SqlClient from "@effect/sql/SqlClient";
import * as Store from "../../store/index.js";
import { Effect, Schema } from "effect";
import type { DisseminationObligation } from "../../store/index.js";
import type { EngineActionFold, EngineRuntime } from "../engine-context.js";
import { type ActionCertifiedRecord, RecordHash } from "../../records/index.js";
import { RouterWorkerPersistenceError } from "../../router/index.js";
import {
  makeActionCertifiedRecord,
  recordAnchorHash,
} from "../history/index.js";

/* eslint-disable agent-code-guard/no-conditional-chaining -- This optional single-conversation filter passes through unchanged to the store, where omission selects all conversations. */
/**
 * Attach every durable certification obligation that lacks an outer envelope.
 * @param runtime Recovered engine state and durable protocol dependencies.
 * @param conversationId One conversation to resume, or none to resume all.
 * @returns Completion after every obligation has one exact retained outbox row.
 */
export function resumeDisseminationObligations(
  runtime: EngineRuntime,
  conversationId?: string,
): Effect.Effect<void, RouterWorkerPersistenceError, SqlClient.SqlClient> {
  return runtime.gate.withPermits(1)(
    (conversationId === undefined
      ? Store.recover()
      : Store.recover(conversationId)
    ).pipe(
      Effect.mapError(persistenceFailure),
      Effect.flatMap((recovery) =>
        Effect.forEach(
          recovery.disseminationObligations,
          (obligation) => attachObligation(runtime, obligation),
          { concurrency: 1, discard: true },
        ),
      ),
    ),
  );
}

/* eslint-enable agent-code-guard/no-conditional-chaining -- The selection is resolved by the store. */

function attachObligation(
  runtime: EngineRuntime,
  obligation: DisseminationObligation,
): Effect.Effect<void, RouterWorkerPersistenceError, SqlClient.SqlClient> {
  return Effect.gen(function* () {
    const fold = yield* obligationFold(runtime, obligation);
    const packet = yield* packetForObligation(fold);
    yield* Effect.uninterruptible(
      runtime.outbox
        .queueActionCertifiedRecord(fold.conversation, packet)
        .pipe(Effect.mapError(persistenceFailure)),
    );
  });
}

function obligationFold(
  runtime: EngineRuntime,
  obligation: DisseminationObligation,
): Effect.Effect<
  EngineActionFold,
  RouterWorkerPersistenceError,
  SqlClient.SqlClient
> {
  return Schema.decodeUnknown(RecordHash)(obligation.recordHash).pipe(
    Effect.mapError(persistenceFailure),
    Effect.flatMap((recordHash) => {
      const fold = runtime.recordFolds.get(recordHash);
      return fold?.conversation.conversationId === obligation.conversationId &&
        fold.recordHash === recordHash
        ? Effect.succeed(fold)
        : Effect.fail(persistenceFailure());
    }),
  );
}

function packetForObligation(
  fold: EngineActionFold,
): Effect.Effect<
  ActionCertifiedRecord,
  RouterWorkerPersistenceError,
  SqlClient.SqlClient
> {
  return recordAnchorHash(fold).pipe(
    Effect.flatMap((anchorHash) => makeActionCertifiedRecord(fold, anchorHash)),
    Effect.mapError(persistenceFailure),
    Effect.filterOrFail(
      (record) => record.recordHash === fold.recordHash,
      persistenceFailure,
    ),
  );
}

function persistenceFailure(): RouterWorkerPersistenceError {
  return new RouterWorkerPersistenceError();
}
