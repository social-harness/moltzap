/** @file Collective algorithm tests stub persistence; SQLite restart tests exercise durability. */

import { Effect, Schema } from "effect";
import { randomBytes } from "node:crypto";
import type { CollectivePorts } from "../communication/collectives/ports.js";
import { CollectiveId } from "../communication/collectives/contracts.js";
import { collectiveRequesterOf } from "../communication/collectives/wire/index.js";
import {
  type CollectiveOperationInput,
  DeliveryToken,
  EndpointStoreError,
  type StoredCollectiveOperation,
} from "../communication/store/index.js";

/** The test engine certifies synchronously and records the operation attached at binding. */
export function collectivePersistencePorts(
  sendMessage: CollectivePorts["sendMessage"],
) {
  const store = collectiveStorageStub();
  const send: CollectivePorts["sendMessage"] = (input) =>
    (input.collective?.operation === undefined
      ? Effect.void
      : store
          .putCollectiveOperation(input.collective.operation)
          .pipe(Effect.orDie)
    ).pipe(Effect.zipRight(sendMessage(input)));
  return {
    store,
    bindMessage: <E>(
      input: Parameters<CollectivePorts["sendMessage"]>[0],
      hold: Effect.Effect<Effect.Effect<void>, E>,
    ) => hold.pipe(Effect.as({ certified: send(input) })),
    sendMessage: send,
    sendAdmitted: (input: Parameters<CollectivePorts["sendAdmitted"]>[0]) =>
      send(input),
    observeMessage: () => Effect.never,
    reportStorageFault: () => Effect.void,
  };
}

/** A recording store for classifier-only fixtures whose messages bypass the real certification engine. */
export function collectiveStorageStub(): CollectivePorts["store"] {
  const operations = new Map<string, StoredCollectiveOperation>();
  return {
    putCollectiveOperation: (input) => recordOperation(operations, input),
    readCollectiveOperation: (operationId) =>
      Effect.sync(() => operations.get(operationId)),
    readCollectiveOperations: () => Effect.sync(() => [...operations.values()]),
    readCollectiveMessages: () => Effect.succeed([]),
    recordCollectiveAnswer: (answer) => Effect.succeed(answer.recordHash),
    readCollectiveAnswers: () => Effect.succeed([]),
    recordCollectiveRefusal: () => Effect.void,
    readCollectiveRefusals: () => Effect.succeed([]),
    finalizeCollectiveOperation: (operationId, selection) =>
      finalizeOperation(operations, operationId, selection),
    retireCollectiveOperation: (operationId, canonicalSelection) =>
      Effect.sync(() => {
        const operation = operations.get(operationId);
        if (operation !== undefined) {
          operations.set(operationId, {
            ...operation,
            canonicalSelection,
            phase: "completed",
          });
        }
      }),
    readFirewallRequestAdmission: () => Effect.succeed(undefined),
    readRetainedDeliveries: () => Effect.succeed([]),
  };
}

function recordOperation(
  operations: Map<string, StoredCollectiveOperation>,
  input: CollectiveOperationInput,
) {
  return Effect.sync(() => {
    if (operations.has(input.operationId)) {
      return "existing" as const;
    }
    operations.set(input.operationId, {
      ...input,
      creatorAgentId: collectiveRequesterOf(
        Schema.decodeUnknownSync(CollectiveId)(input.operationId),
      ),
      origin:
        input.origin.kind === "local"
          ? input.origin
          : { ...input.origin, conversationId: "fixture-conversation" },
      phase: "collecting",
      deliveryToken: Schema.decodeUnknownSync(DeliveryToken)(
        `dlv_${randomBytes(32).toString("base64url")}`,
      ),
    });
    return "inserted" as const;
  });
}

function finalizeOperation(
  operations: Map<string, StoredCollectiveOperation>,
  operationId: string,
  canonicalSelection: Uint8Array,
) {
  return Effect.suspend(() => {
    const operation = operations.get(operationId);
    if (operation === undefined) {
      return Effect.fail(new EndpointStoreError({ reason: "not-found" }));
    }
    operations.set(operationId, {
      ...operation,
      canonicalSelection,
      phase: "finalizing",
    });
    return Effect.succeed("inserted" as const);
  });
}
