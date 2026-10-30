/** @file Shares one SQLite lifetime and commits changes spanning communication, policy and delivery. */

import * as FileSystem from "@effect/platform/FileSystem";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as SqlClient from "@effect/sql/SqlClient";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { Cause, Effect, Layer, Option } from "effect";
import { join } from "node:path";
import { completeCollectiveDelivery } from "../communication/store/collectives.js";
import {
  createCommunicationTables,
  inspectStoreState,
  storeOperation,
  transaction,
  type StoreOpening,
} from "../communication/store/database/index.js";
import {
  EndpointStoreError,
  OutboxTooOldError,
  mapStoreFailure,
  readText,
  requireSameBytes,
} from "../communication/store/database/values.js";
import { retirePendingDelivery } from "../communication/store/queues/peer-deliveries.js";
import type { DeliveryToken } from "../communication/store/types.js";
import {
  queueFirewallItem as retainQueuedItem,
  requireQueueFrontier,
  retireQueuedItem,
  saveCheckDecision,
  settleLocalItem,
  settleQueuedItem,
} from "../firewall/store/firewall.js";
import { createFirewallTables } from "../firewall/store/schema.js";
import type {
  FirewallCompletion,
  FirewallInboxEntry,
  FirewallLocalAdmission,
  ItemProjection,
} from "../firewall/store/types.js";
import {
  createInboxTables,
  putInboxItem,
  readInboxItem,
  type CollectiveDelivery,
} from "./inbox/store.js";

const DATABASE_NAME = "sharnessd.sqlite3";

/** Startup rejects incompatible state and expired pending bytes before accepting requests. */
export function layer(options: {
  readonly stateDirectory: string;
  readonly liveWireVersions: readonly string[];
}): Layer.Layer<SqlClient.SqlClient, EndpointStoreError | OutboxTooOldError> {
  const connection = SqliteClient.layer({
    filename: join(options.stateDirectory, DATABASE_NAME),
    disableWAL: true,
  });
  const initialized = Layer.effectDiscard(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const opening = yield* inspectStoreState();
      if (opening === "reopen") {
        const pending = yield* sql.unsafe<Readonly<Record<string, unknown>>>(
          "SELECT wire_version FROM outbound_messages WHERE disposition='pending'",
        );
        for (const row of pending)
          if (!options.liveWireVersions.includes(readText(row, "wire_version")))
            return yield* new OutboxTooOldError();
      }
      yield* sql.unsafe<Readonly<Record<string, unknown>>>(
        "PRAGMA locking_mode = EXCLUSIVE",
      );
      yield* sql.unsafe<Readonly<Record<string, unknown>>>(
        "PRAGMA foreign_keys = ON",
      );
      yield* sql.unsafe<Readonly<Record<string, unknown>>>(
        "PRAGMA busy_timeout = 0",
      );
      yield* sql.unsafe<Readonly<Record<string, unknown>>>(
        "PRAGMA journal_mode = WAL",
      );
      yield* sql.unsafe<Readonly<Record<string, unknown>>>(
        "PRAGMA synchronous = FULL",
      );
      yield* transaction(
        Effect.gen(function* () {
          if (opening === "create") {
            yield* createCommunicationTables();
            yield* createInboxTables();
            yield* createFirewallTables();
          }
        }),
      );
      const filesystem = yield* FileSystem.FileSystem;
      yield* filesystem.chmod(options.stateDirectory, 0o700);
      yield* filesystem.chmod(
        join(options.stateDirectory, DATABASE_NAME),
        0o600,
      );
    }),
  );
  return Layer.unwrapEffect(
    Effect.gen(function* () {
      const filesystem = yield* FileSystem.FileSystem;
      yield* filesystem.makeDirectory(options.stateDirectory, {
        recursive: true,
        mode: 0o700,
      });
      return initialized.pipe(Layer.provideMerge(connection));
    }),
  ).pipe(
    Layer.provide(NodeFileSystem.layer),
    Layer.catchAllCause(
      (cause): Layer.Layer<never, EndpointStoreError | OutboxTooOldError> => {
        if (Cause.isInterruptedOnly(cause))
          return Layer.failCause(Cause.stripFailures(cause));
        const failure = Option.getOrUndefined(Cause.failureOption(cause));
        return failure instanceof OutboxTooOldError
          ? Layer.fail(failure)
          : Layer.fail(
              mapStoreFailure(
                failure ?? Option.getOrUndefined(Cause.dieOption(cause)),
                "persistence",
              ),
            );
      },
    ),
  );
}

/** Registration can distinguish a fresh directory without changing its saved state. */
export function inspectEndpointStore(
  stateDirectory: string,
): Effect.Effect<StoreOpening, EndpointStoreError> {
  return Effect.gen(function* () {
    const filesystem = yield* FileSystem.FileSystem;
    const filename = join(stateDirectory, DATABASE_NAME);
    if (!(yield* filesystem.exists(filename))) return "create" as const;
    return yield* inspectStoreState().pipe(
      Effect.provide(
        SqliteClient.layer({ filename, readonly: true, disableWAL: true }),
      ),
    );
  }).pipe(Effect.provide(NodeFileSystem.layer), storeOperation);
}

/** Completed operation ownership and its host view commit before notification. */
export function publishCollectiveItem(delivery: CollectiveDelivery) {
  return transaction(
    Effect.gen(function* () {
      yield* completeCollectiveDelivery(
        delivery.operationId,
        delivery.deliveryToken,
      );
      if (delivery.firewall) yield* queueFirewallItem(delivery);
      else yield* putInboxItem(delivery);
    }),
  );
}

/** A completed decision and the host's immutable message become durable together. */
export function saveMessageDecision(
  item: ItemProjection,
  completion: FirewallCompletion,
) {
  return transaction(
    Effect.gen(function* () {
      yield* requireQueueFrontier(item.deliveryToken, item.canonicalItem);
      if (completion.direction !== "incoming")
        return yield* new EndpointStoreError({ reason: "conflict" });
      requireSameBytes(completion.canonicalCandidate, item.canonicalItem);
      const disposition = yield* saveCheckDecision(completion);
      if (disposition === "admitted") yield* putInboxItem(item);
      else yield* retirePendingDelivery(item.deliveryToken);
      yield* settleQueuedItem(
        item.deliveryToken,
        disposition,
        completion.checkId,
      );
      return disposition;
    }),
  );
}

/** Result text, answer visibility and saved evidence share the same publication. */
export function saveResultDecision(admission: FirewallLocalAdmission) {
  return transaction(
    Effect.gen(function* () {
      yield* settleLocalItem(admission);
      yield* putInboxItem(admission.item);
      return "admitted" as const;
    }),
  );
}

/** An expired request remains protocol context while leaving the pending host queue. */
export function retireFirewallItem(token: DeliveryToken) {
  return transaction(
    Effect.gen(function* () {
      yield* retireQueuedItem(token);
      yield* retirePendingDelivery(token);
    }),
  );
}

/** A saved host view wins over later attempts to queue the same item. */
export function queueFirewallItem(item: Omit<FirewallInboxEntry, "sequence">) {
  return Effect.gen(function* () {
    const presented = yield* readInboxItem(item.deliveryToken);
    if (presented !== undefined) {
      requireSameBytes(presented.canonicalItem, item.canonicalItem);
      return;
    }
    yield* retainQueuedItem(item);
  }).pipe(storeOperation);
}
