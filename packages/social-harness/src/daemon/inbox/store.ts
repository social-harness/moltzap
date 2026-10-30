/** @file Stores host inbox items and tracks delivery and acknowledgment. */

import * as SqlClient from "@effect/sql/SqlClient";
import { Effect, Schema } from "effect";

import type { ItemProjection } from "../../firewall/store/types.js";
import type { InboxSummary } from "../../host-protocol/operations.js";
import {
  EndpointStoreError,
  readBytes,
  readInteger,
  readOptionalBytes,
  readText,
  requireBytes,
  requireSameBytes,
  requireSameOptionalBytes,
  storeOperation,
  StoreSignal,
  transaction,
} from "../../communication/store/database/index.js";
import { retirePendingDelivery } from "../../communication/store/queues/peer-deliveries.js";
import {
  DeliveryToken,
  type StoreMutation,
} from "../../communication/store/types.js";
import { MAXIMUM_RUNTIME_ITEM_BYTES } from "../../encoding/limits.js";
// safer-arch-ignore file-implicit-boundary-module: Store composition and firewall admission share inbox writes within the caller's transaction; external consumers use the store capability instead of these SQLite primitives.
const MAXIMUM_PAGE_ITEMS = 50;
interface InboxBounds {
  readonly after?: number;
  readonly through?: number;
  readonly limit?: number;
}
/** Immutable classified item retained until the host accepts its delivery. */
export interface InboxEntry extends ItemProjection {
  readonly sequence: number;
}
/** A bounded view below a fixed inbox sequence, independent of later arrivals. */
export interface InboxPage {
  readonly items: readonly InboxEntry[];
  readonly through: number;
  readonly nextAfter?: number;
}
/** Callback progress and retained content share the inbox's persistence lifetime. */
export interface EventStore {
  readonly readEventState: () => Effect.Effect<
    Uint8Array | undefined,
    EndpointStoreError
  >;
  readonly writeEventState: (
    value: Uint8Array,
  ) => Effect.Effect<void, EndpointStoreError>;
  readonly readInbox: (
    input?: InboxBounds,
  ) => Effect.Effect<InboxPage, EndpointStoreError>;
  readonly readInboxItem: (
    token: DeliveryToken,
  ) => Effect.Effect<
    (InboxEntry & { readonly acknowledged: boolean }) | undefined,
    EndpointStoreError
  >;
  readonly readInboxSummary: () => Effect.Effect<
    InboxSummary,
    EndpointStoreError
  >;
  readonly completeWebhookDelivery: (
    token: DeliveryToken,
    state: Uint8Array,
  ) => Effect.Effect<void, EndpointStoreError>;
}
/** The terminal payload and protocol custody settle with its local publication. */
export interface CollectiveDelivery {
  readonly operationId: string;
  readonly deliveryToken: DeliveryToken;
  readonly canonicalItem: Uint8Array;
  readonly conversation: string;
  readonly canonicalProvenance?: Uint8Array;
  readonly firewall: boolean;
}
/** Called only inside the daemon's initial schema transaction. */
export function createInboxTables() {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const statement of `
  CREATE TABLE runtime_inbox (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    delivery_token TEXT NOT NULL UNIQUE,
    canonical_item BLOB NOT NULL,
    canonical_guidance BLOB,
    acknowledged INTEGER NOT NULL DEFAULT 0 CHECK (acknowledged IN (0, 1))
  ) STRICT;
  CREATE INDEX runtime_inbox_unread ON runtime_inbox(sequence) WHERE acknowledged = 0;
  CREATE TABLE runtime_events (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    canonical_state BLOB NOT NULL
  ) STRICT;
`
      .split(";")
      .map((part) => part.trim())
      .filter((part) => part.length > 0)) {
      yield* sql.unsafe<Readonly<Record<string, unknown>>>(statement);
    }
  }).pipe(storeOperation, Effect.withSpan("createInboxTables"));
}
/** Retained bytes remain readable after handoff or request-context retirement. */
export function readInboxItem(deliveryToken: DeliveryToken) {
  return Effect.gen(function* () {
    const database = yield* SqlClient.SqlClient;
    const row = (yield* database.unsafe<Readonly<Record<string, unknown>>>(
      "SELECT sequence, canonical_item, canonical_guidance, acknowledged FROM runtime_inbox WHERE delivery_token = ?",
      [deliveryToken],
    ))[0];
    return row === undefined
      ? undefined
      : {
          deliveryToken,
          sequence: readInteger(row, "sequence"),
          canonicalItem: readBytes(row, "canonical_item"),
          ...guidanceBytes(row),
          acknowledged: readInteger(row, "acknowledged") === 1,
        };
  }).pipe(storeOperation, Effect.withSpan("readInboxItem"));
}
/**
 * Bind a delivery token to exactly one classified payload, including after ack.
 * @param item Immutable classified delivery.
 * @returns Whether this call inserted the binding.
 */
export function putInboxItem(
  item: Omit<InboxEntry, "sequence">,
): Effect.Effect<StoreMutation, EndpointStoreError, SqlClient.SqlClient> {
  return Effect.gen(function* () {
    const database = yield* SqlClient.SqlClient;
    requireBytes(item.canonicalItem);
    if (
      item.canonicalItem.byteLength +
        (item.canonicalGuidance?.byteLength ?? 0) >
      MAXIMUM_RUNTIME_ITEM_BYTES
    ) {
      return yield* new EndpointStoreError({ reason: "invalid-input" });
    }
    const retained = (yield* database.unsafe<Readonly<Record<string, unknown>>>(
      "SELECT canonical_item, canonical_guidance FROM runtime_inbox WHERE delivery_token = ?",
      [item.deliveryToken],
    ))[0];
    if (retained !== undefined) {
      requireSameBytes(
        readBytes(retained, "canonical_item"),
        item.canonicalItem,
      );
      const priorGuidance = readOptionalBytes(retained, "canonical_guidance");
      requireSameOptionalBytes(priorGuidance, item.canonicalGuidance);
      return "existing";
    }
    yield* database.unsafe<Readonly<Record<string, unknown>>>(
      "INSERT INTO runtime_inbox (delivery_token, canonical_item, canonical_guidance) VALUES (?, ?, ?)",
      [item.deliveryToken, item.canonicalItem, item.canonicalGuidance ?? null],
    );
    return "inserted";
  }).pipe(storeOperation, Effect.withSpan("putInboxItem"));
}
/** Acknowledgment preserves the immutable host binding and retires its raw delivery. */
export function retireItem(
  deliveryToken: DeliveryToken,
): Effect.Effect<void, EndpointStoreError, SqlClient.SqlClient> {
  return Effect.gen(function* () {
    const database = yield* SqlClient.SqlClient;
    const retained = (yield* database.unsafe<Readonly<Record<string, unknown>>>(
      "SELECT delivery_token FROM runtime_inbox WHERE delivery_token = ?",
      [deliveryToken],
    ))[0];
    if (retained === undefined) {
      return yield* new EndpointStoreError({ reason: "not-found" });
    }
    yield* database.unsafe<Readonly<Record<string, unknown>>>(
      "UPDATE runtime_inbox SET acknowledged = 1 WHERE delivery_token = ?",
      [deliveryToken],
    );
    yield* retirePendingDelivery(deliveryToken);
  }).pipe(storeOperation, Effect.withSpan("retireItem"));
}
/** Receipt retirement and callback progress commit together across crashes. */
export function completeWebhookDelivery(
  deliveryToken: DeliveryToken,
  canonicalState: Uint8Array,
): Effect.Effect<void, EndpointStoreError, SqlClient.SqlClient> {
  return Effect.gen(function* () {
    yield* transaction(
      Effect.gen(function* () {
        yield* retireItem(deliveryToken);
        yield* writeEventState(canonicalState);
      }),
    );
  }).pipe(storeOperation, Effect.withSpan("completeWebhookDelivery"));
}
/**
 * Read an inbox page without allowing concurrent arrivals to extend its snapshot.
 * @param input Sequence bounds and maximum item count.
 * @returns Pending items and an optional next position within the same snapshot.
 */
export function readInbox(
  input: InboxBounds = {},
): Effect.Effect<InboxPage, EndpointStoreError, SqlClient.SqlClient> {
  return Effect.gen(function* () {
    const database = yield* SqlClient.SqlClient;
    const after = requireSequence(input.after ?? 0);
    const through = requireSequence(input.through ?? (yield* newestSequence()));
    const limit = pageLimit(input, after, through);
    const rows = yield* database.unsafe<Readonly<Record<string, unknown>>>(
      "SELECT sequence, delivery_token, canonical_item, canonical_guidance FROM runtime_inbox WHERE acknowledged = 0 AND sequence > ? AND sequence <= ? ORDER BY sequence LIMIT ?",
      [after, through, limit + 1],
    );
    const items = collectPage(rows, limit);
    const last = items.at(-1);
    return {
      items,
      through,
      ...(last !== undefined && rows.length > items.length
        ? { nextAfter: last.sequence }
        : {}),
    };
  }).pipe(storeOperation, Effect.withSpan("readInbox"));
}
/**
 * Read counters for notification coalescing without disclosing inbox contents.
 * @returns Current unread count and monotonic insertion position.
 */
export function readInboxSummary(): Effect.Effect<
  InboxSummary,
  EndpointStoreError,
  SqlClient.SqlClient
> {
  return Effect.gen(function* () {
    const database = yield* SqlClient.SqlClient;
    const row = (yield* database.unsafe<Readonly<Record<string, unknown>>>(
      "SELECT COUNT(*) AS pending FROM runtime_inbox WHERE acknowledged = 0",
      [],
    ))[0];
    if (row === undefined) {
      return yield* new EndpointStoreError({ reason: "corrupt" });
    }
    return {
      pendingCount: readInteger(row, "pending"),
      newestSequence: yield* newestSequence(),
    };
  }).pipe(storeOperation, Effect.withSpan("readInboxSummary"));
}
/**
 * Retire the host projection and any underlying pending protocol row atomically.
 * @param deliveryToken Stable delivered identity, including an existing tombstone.
 */
export function acknowledgeInboxItem(
  deliveryToken: DeliveryToken,
): Effect.Effect<void, EndpointStoreError, SqlClient.SqlClient> {
  return Effect.gen(function* () {
    yield* transaction(
      Effect.gen(function* () {
        yield* retireItem(deliveryToken);
      }),
    );
  }).pipe(storeOperation, Effect.withSpan("acknowledgeInboxItem"));
}
/**
 * Read the runtime-owned event state without interpreting its private format.
 * @returns Persisted registration and callback delivery state, when present.
 */
export function readEventState(): Effect.Effect<
  Uint8Array | undefined,
  EndpointStoreError,
  SqlClient.SqlClient
> {
  return Effect.gen(function* () {
    const database = yield* SqlClient.SqlClient;
    const row = (yield* database.unsafe<Readonly<Record<string, unknown>>>(
      "SELECT canonical_state FROM runtime_events WHERE singleton = 1",
      [],
    ))[0];
    return row === undefined ? undefined : readBytes(row, "canonical_state");
  }).pipe(storeOperation, Effect.withSpan("readEventState"));
}
/**
 * Atomically replace the one runtime consumer's durable event state.
 * @param canonicalState Runtime-validated registration and delivery state.
 */
export function writeEventState(
  canonicalState: Uint8Array,
): Effect.Effect<void, EndpointStoreError, SqlClient.SqlClient> {
  return Effect.gen(function* () {
    const database = yield* SqlClient.SqlClient;
    requireBytes(canonicalState);
    yield* database.unsafe<Readonly<Record<string, unknown>>>(
      "INSERT INTO runtime_events (singleton, canonical_state) VALUES (1, ?) ON CONFLICT(singleton) DO UPDATE SET canonical_state = excluded.canonical_state",
      [canonicalState],
    );
  }).pipe(storeOperation, Effect.withSpan("writeEventState"));
}
/** Returns only retained permitted views, including acknowledged messages and admitted answers. */
export function readHistoryViews(
  records: ReadonlyArray<{
    readonly conversationId: string;
    readonly recordHash: string;
  }>,
): Effect.Effect<
  readonly HistoryView[],
  EndpointStoreError,
  SqlClient.SqlClient
> {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const views: HistoryView[] = [];
    for (const record of records) {
      const rows = yield* sql.unsafe<Readonly<Record<string, unknown>>>(
        `SELECT i.canonical_item,i.canonical_guidance FROM runtime_inbox i JOIN pending_deliveries d USING(delivery_token) WHERE d.conversation_id=? AND d.record_hash=?
 UNION ALL SELECT i.canonical_item,i.canonical_guidance FROM runtime_inbox i JOIN firewall_answers a USING(delivery_token) WHERE a.conversation_id=? AND a.record_hash=? AND a.admitted=1 LIMIT 1`,
        [
          record.conversationId,
          record.recordHash,
          record.conversationId,
          record.recordHash,
        ],
      );
      const row = rows[0];
      if (row !== undefined) {
        views.push({
          recordHash: record.recordHash,
          canonicalItem: readBytes(row, "canonical_item"),
          ...guidanceBytes(row),
        });
      }
    }
    return views;
  }).pipe(storeOperation, Effect.withSpan("readHistoryViews"));
}
function requireSequence(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new StoreSignal("invalid-continuation");
  }
  return value;
}
function newestSequence(): Effect.Effect<
  number,
  EndpointStoreError,
  SqlClient.SqlClient
> {
  return Effect.gen(function* () {
    const database = yield* SqlClient.SqlClient;
    const row = (yield* database.unsafe<Readonly<Record<string, unknown>>>(
      "SELECT COALESCE(MAX(sequence), 0) AS newest FROM runtime_inbox",
      [],
    ))[0];
    if (row === undefined) {
      return yield* new EndpointStoreError({ reason: "corrupt" });
    }
    return readInteger(row, "newest");
  }).pipe(storeOperation);
}
function pageLimit(input: InboxBounds, after: number, through: number): number {
  const limit = input.limit ?? MAXIMUM_PAGE_ITEMS;
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > MAXIMUM_PAGE_ITEMS ||
    after > through
  ) {
    throw new StoreSignal("invalid-continuation");
  }
  return limit;
}
function collectPage(
  rows: ReadonlyArray<Readonly<Record<string, unknown>>>,
  limit: number,
): readonly InboxEntry[] {
  const items: InboxEntry[] = [];
  let bytes = 0;
  for (const row of rows) {
    const canonicalItem = readBytes(row, "canonical_item");
    const guidance = guidanceBytes(row);
    const itemBytes =
      canonicalItem.byteLength + (guidance.canonicalGuidance?.byteLength ?? 0);
    if (
      items.length === limit ||
      (items.length > 0 && bytes + itemBytes > MAXIMUM_RUNTIME_ITEM_BYTES)
    ) {
      break;
    }
    items.push({
      sequence: readInteger(row, "sequence"),
      deliveryToken: Schema.decodeUnknownSync(DeliveryToken)(
        readText(row, "delivery_token"),
      ),
      canonicalItem,
      ...guidance,
    });
    bytes += itemBytes;
  }
  return items;
}
function guidanceBytes(
  row: Readonly<Record<string, unknown>>,
): Pick<InboxEntry, "canonicalGuidance"> {
  const value = readOptionalBytes(row, "canonical_guidance");
  return value === undefined ? {} : { canonicalGuidance: value };
}
/** A saved host view corresponding to a record in an internally verified history page. */
export interface HistoryView {
  readonly recordHash: string;
  readonly canonicalItem: Uint8Array;
  readonly canonicalGuidance?: Uint8Array;
}
