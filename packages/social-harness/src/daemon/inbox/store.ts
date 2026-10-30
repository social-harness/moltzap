/** @file Stores host inbox items and tracks delivery and acknowledgment. */

import type { DatabaseSync } from "node:sqlite";

import { type Effect, Schema } from "effect";

import type { ItemProjection } from "../../firewall/store/types.js";

import {
  type EndpointStoreError,
  readBytes,
  readInteger,
  readOptionalBytes,
  readText,
  requireBytes,
  requireSameBytes,
  requireSameOptionalBytes,
  runStoreOperation,
  StoreSignal,
  type StoreState,
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

/** Wakeup bookkeeping contains no peer content or collective protocol state. */
export interface InboxSummary {
  readonly pendingCount: number;
  readonly newestSequence: number;
}

/** Durable host delivery and consumer state, independent of policy configuration. */
export interface InboxStore {
  readonly readInboxItem: (
    deliveryToken: DeliveryToken,
  ) => Effect.Effect<
    (InboxEntry & { readonly acknowledged: boolean }) | undefined,
    EndpointStoreError
  >;
  readonly completeWebhookDelivery: (
    deliveryToken: DeliveryToken,
    canonicalState: Uint8Array,
  ) => Effect.Effect<void, EndpointStoreError>;
  readonly putInboxItem: (
    item: Omit<InboxEntry, "sequence">,
  ) => Effect.Effect<StoreMutation, EndpointStoreError>;
  readonly readInbox: (input?: {
    readonly after?: number;
    readonly through?: number;
    readonly limit?: number;
  }) => Effect.Effect<InboxPage, EndpointStoreError>;
  readonly readInboxSummary: () => Effect.Effect<
    InboxSummary,
    EndpointStoreError
  >;
  readonly acknowledgeInboxItem: (
    deliveryToken: DeliveryToken,
  ) => Effect.Effect<void, EndpointStoreError>;
  readonly readEventState: () => Effect.Effect<
    Uint8Array | undefined,
    EndpointStoreError
  >;
  readonly writeEventState: (
    canonicalState: Uint8Array,
  ) => Effect.Effect<void, EndpointStoreError>;
}

/** Called only inside the daemon's initial schema transaction. */
export function createInboxTables(database: DatabaseSync): void {
  database.exec(`
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
`);
}

/** A host-only capability over the process-owned SQLite lifetime. */
export function makeInboxStore(state: StoreState): InboxStore {
  const run = <A>(operation: () => A) => runStoreOperation(state, operation);
  return Object.freeze({
    readInboxItem: (token: DeliveryToken) =>
      run(() => readInboxItem(state.database, token)),
    completeWebhookDelivery: (token: DeliveryToken, value: Uint8Array) =>
      run(() => {
        completeWebhookDelivery(state.database, token, value);
      }),
    putInboxItem: (item: Omit<InboxEntry, "sequence">) =>
      run(() => putInboxItem(state.database, item)),
    readInbox: (input?: Parameters<typeof readInbox>[1]) =>
      run(() => readInbox(state.database, input)),
    readInboxSummary: () => run(() => readInboxSummary(state.database)),
    acknowledgeInboxItem: (token: DeliveryToken) =>
      run(() => {
        acknowledgeInboxItem(state.database, token);
      }),
    readEventState: () => run(() => readEventState(state.database)),
    writeEventState: (value: Uint8Array) =>
      run(() => {
        writeEventState(state.database, value);
      }),
  } satisfies InboxStore);
}

/** Retained bytes remain readable after handoff or request-context retirement. */
export function readInboxItem(
  database: DatabaseSync,
  deliveryToken: DeliveryToken,
) {
  const row = database
    .prepare(
      "SELECT sequence, canonical_item, canonical_guidance, acknowledged FROM runtime_inbox WHERE delivery_token = ?",
    )
    .get(deliveryToken);
  return row === undefined
    ? undefined
    : {
        deliveryToken,
        sequence: readInteger(row, "sequence"),
        canonicalItem: readBytes(row, "canonical_item"),
        ...guidanceBytes(row),
        acknowledged: readInteger(row, "acknowledged") === 1,
      };
}

/** Receipt retirement and callback progress commit together across crashes. */
export function completeWebhookDelivery(
  database: DatabaseSync,
  deliveryToken: DeliveryToken,
  canonicalState: Uint8Array,
): void {
  transaction(database, () => {
    retireItem(database, deliveryToken);
    writeEventState(database, canonicalState);
  });
}

/**
 * Bind a delivery token to exactly one classified payload, including after ack.
 * @param database Exclusively owned endpoint database.
 * @param item Immutable classified delivery.
 * @returns Whether this call inserted the binding.
 */
export function putInboxItem(
  database: DatabaseSync,
  item: Omit<InboxEntry, "sequence">,
): StoreMutation {
  requireBytes(item.canonicalItem);
  if (
    item.canonicalItem.byteLength + (item.canonicalGuidance?.byteLength ?? 0) >
    MAXIMUM_RUNTIME_ITEM_BYTES
  ) {
    throw new StoreSignal("invalid-input");
  }
  const retained = database
    .prepare(
      "SELECT canonical_item, canonical_guidance FROM runtime_inbox WHERE delivery_token = ?",
    )
    .get(item.deliveryToken);
  if (retained !== undefined) {
    requireSameBytes(readBytes(retained, "canonical_item"), item.canonicalItem);
    const priorGuidance = readOptionalBytes(retained, "canonical_guidance");
    requireSameOptionalBytes(priorGuidance, item.canonicalGuidance);
    return "existing";
  }
  database
    .prepare(
      "INSERT INTO runtime_inbox (delivery_token, canonical_item, canonical_guidance) VALUES (?, ?, ?)",
    )
    .run(
      item.deliveryToken,
      item.canonicalItem,
      item.canonicalGuidance ?? null,
    );
  return "inserted";
}

/**
 * Read an inbox page without allowing concurrent arrivals to extend its snapshot.
 * @param database Exclusively owned endpoint database.
 * @param input Sequence bounds and maximum item count.
 * @returns Pending items and an optional next position within the same snapshot.
 */
export function readInbox(
  database: DatabaseSync,
  input: InboxBounds = {},
): InboxPage {
  const after = requireSequence(input.after ?? 0);
  const through = requireSequence(input.through ?? newestSequence(database));
  const limit = pageLimit(input, after, through);
  const rows = database
    .prepare(
      "SELECT sequence, delivery_token, canonical_item, canonical_guidance FROM runtime_inbox WHERE acknowledged = 0 AND sequence > ? AND sequence <= ? ORDER BY sequence LIMIT ?",
    )
    .all(after, through, limit + 1);
  const items = collectPage(rows, limit);
  const last = items.at(-1);
  return {
    items,
    through,
    ...(last !== undefined && rows.length > items.length
      ? { nextAfter: last.sequence }
      : {}),
  };
}

/**
 * Read counters for notification coalescing without disclosing inbox contents.
 * @param database Exclusively owned endpoint database.
 * @returns Current unread count and monotonic insertion position.
 */
export function readInboxSummary(database: DatabaseSync): InboxSummary {
  const row = database
    .prepare(
      "SELECT COUNT(*) AS pending FROM runtime_inbox WHERE acknowledged = 0",
    )
    .get();
  if (row === undefined) {
    throw new StoreSignal("corrupt");
  }
  return {
    pendingCount: readInteger(row, "pending"),
    newestSequence: newestSequence(database),
  };
}

/**
 * Retire the host projection and any underlying pending protocol row atomically.
 * @param database Exclusively owned endpoint database.
 * @param deliveryToken Stable delivered identity, including an existing tombstone.
 */
export function acknowledgeInboxItem(
  database: DatabaseSync,
  deliveryToken: DeliveryToken,
): void {
  transaction(database, () => {
    retireItem(database, deliveryToken);
  });
}

/**
 * Read the runtime-owned event state without interpreting its private format.
 * @param database Exclusively owned endpoint database.
 * @returns Persisted registration and callback delivery state, when present.
 */
export function readEventState(database: DatabaseSync): Uint8Array | undefined {
  const row = database
    .prepare("SELECT canonical_state FROM runtime_events WHERE singleton = 1")
    .get();
  return row === undefined ? undefined : readBytes(row, "canonical_state");
}

/**
 * Atomically replace the one runtime consumer's durable event state.
 * @param database Exclusively owned endpoint database.
 * @param canonicalState Runtime-validated registration and delivery state.
 */
export function writeEventState(
  database: DatabaseSync,
  canonicalState: Uint8Array,
): void {
  requireBytes(canonicalState);
  database
    .prepare(
      "INSERT INTO runtime_events (singleton, canonical_state) VALUES (1, ?) ON CONFLICT(singleton) DO UPDATE SET canonical_state = excluded.canonical_state",
    )
    .run(canonicalState);
}

/** Acknowledgment preserves the immutable host binding and retires its raw delivery. */
export function retireItem(
  database: DatabaseSync,
  deliveryToken: DeliveryToken,
): void {
  const retained = database
    .prepare(
      "SELECT delivery_token FROM runtime_inbox WHERE delivery_token = ?",
    )
    .get(deliveryToken);
  if (retained === undefined) {
    throw new StoreSignal("not-found");
  }
  database
    .prepare(
      "UPDATE runtime_inbox SET acknowledged = 1 WHERE delivery_token = ?",
    )
    .run(deliveryToken);
  retirePendingDelivery(database, deliveryToken);
}

function requireSequence(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new StoreSignal("invalid-continuation");
  }
  return value;
}

function newestSequence(database: DatabaseSync): number {
  const row = database
    .prepare("SELECT COALESCE(MAX(sequence), 0) AS newest FROM runtime_inbox")
    .get();
  if (row === undefined) {
    throw new StoreSignal("corrupt");
  }
  return readInteger(row, "newest");
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
