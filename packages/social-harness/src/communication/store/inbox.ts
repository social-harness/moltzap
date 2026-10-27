/** @file Durable host projection and event transport state. */

import type { DatabaseSync } from "node:sqlite";
import { Schema } from "effect";
import {
  readBytes,
  readInteger,
  readOptionalBytes,
  readText,
  requireBytes,
  requireSameBytes,
  requireSameOptionalBytes,
  StoreSignal,
  transaction,
} from "./database/index.js";
import {
  DeliveryToken,
  type InboxEntry,
  type InboxPage,
  type InboxSummary,
  MAXIMUM_RUNTIME_ITEM_BYTES,
  type StoreMutation,
} from "./types.js";

// safer-arch-ignore file-implicit-boundary-module: Store composition and firewall admission share inbox writes within the caller's transaction; external consumers use the store capability instead of these SQLite primitives.

const MAXIMUM_PAGE_ITEMS = 50;

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

const requireSequence = (value: number): number => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new StoreSignal("invalid-continuation");
  }
  return value;
};

const newestSequence = (database: DatabaseSync): number => {
  const row = database
    .prepare("SELECT COALESCE(MAX(sequence), 0) AS newest FROM runtime_inbox")
    .get();
  if (row === undefined) {
    throw new StoreSignal("corrupt");
  }
  return readInteger(row, "newest");
};

interface InboxBounds {
  readonly after?: number;
  readonly through?: number;
  readonly limit?: number;
}

const pageLimit = (
  input: InboxBounds,
  after: number,
  through: number,
): number => {
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
};

const collectPage = (
  rows: ReadonlyArray<Readonly<Record<string, unknown>>>,
  limit: number,
): readonly InboxEntry[] => {
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
};

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
 * Replace an unavailable request with a newly identified failure without a gap.
 * @param database Exclusively owned endpoint database.
 * @param deliveryToken Original request's delivery identity.
 * @param replacement Failure under a distinct delivery identity.
 * @param retain Optional private admission queue write within the same transaction.
 */
export function replaceInboxItem(
  database: DatabaseSync,
  deliveryToken: DeliveryToken,
  replacement: Omit<InboxEntry, "sequence">,
  retain?: () => void,
): void {
  if (deliveryToken === replacement.deliveryToken) {
    throw new StoreSignal("conflict");
  }
  transaction(database, () => {
    retireItem(database, deliveryToken);
    if (retain === undefined) {
      putInboxItem(database, replacement);
    } else {
      retain();
    }
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

/**
 * Retire a delivery's raw pending row, so the delivery pass never offers it
 * again.
 * @param database The endpoint store.
 * @param deliveryToken The delivery to retire.
 */
export function retirePendingDelivery(
  database: DatabaseSync,
  deliveryToken: DeliveryToken,
): void {
  database
    .prepare(
      "UPDATE pending_deliveries SET acknowledged = 1 WHERE delivery_token = ?",
    )
    .run(deliveryToken);
}

function retireItem(
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

function guidanceBytes(
  row: Readonly<Record<string, unknown>>,
): Pick<InboxEntry, "canonicalGuidance"> {
  const value = readOptionalBytes(row, "canonical_guidance");
  return value === undefined ? {} : { canonicalGuidance: value };
}
