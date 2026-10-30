/** @file Classified inbox paging and stable runtime delivery identities. */

import { Effect, Encoding, Schema } from "effect";
import { randomBytes } from "node:crypto";
import type { InboxEntry, InboxStore } from "./store.js";
import {
  decodeRuntimeValue,
  DeliveryToken,
  encodeRuntimeValue,
  EndpointStoreError,
} from "../../communication/store/index.js";
import { exactStruct } from "../../encoding/exact.js";
import { localGuidanceSchema } from "../../firewall/outcome/index.js";
import { InboundItem } from "../../host-protocol/items.js";
import {
  type HarnessMessageReadyEvent,
  type HarnessReadInboxRequest,
  type HarnessReadInboxResult,
} from "../../host-protocol/operations.js";

/**
 * Lookup retains the original content and guidance after acknowledgment.
 * @param store Retained immutable classified inbox.
 * @param eventId Canonical event identity carried by a webhook.
 * @returns The original item or a closed lookup failure.
 */
export const readRuntimeEvent = (
  store: Pick<InboxStore, "readInboxItem">,
  eventId: string,
) =>
  Effect.gen(function* () {
    const token = yield* Schema.decodeUnknown(DeliveryToken)(eventId);
    const retained = yield* store.readInboxItem(token);
    if (retained === undefined) {
      return yield* Effect.fail({ reason: "unknown-event" });
    }
    return yield* decodeInboxEntry(retained);
  }).pipe(
    Effect.catchTag("ParseError", () =>
      Effect.fail({ reason: "invalid-event" }),
    ),
    Effect.withSpan("readRuntimeEvent"),
  );

/**
 * The retained item and the local guidance it was admitted with, if any.
 * @param retained One inbox entry's canonical item and guidance bytes.
 * @returns The decoded item and guidance, or a corrupt-store failure.
 */
export function decodeInboxEntry(
  retained: Pick<InboxEntry, "canonicalItem" | "canonicalGuidance">,
) {
  return Effect.gen(function* () {
    return {
      item: yield* decodeRuntimeValue(InboundItem, retained.canonicalItem),
      ...(retained.canonicalGuidance === undefined
        ? {}
        : {
            guidance: yield* decodeRuntimeValue(
              localGuidanceSchema,
              retained.canonicalGuidance,
            ),
          }),
    };
  }).pipe(Effect.withSpan("decodeInboxEntry"));
}

const cursorSchema = exactStruct({
  after: Schema.NonNegativeInt,
  through: Schema.NonNegativeInt,
});

/**
 * Persist a classified item before any host can observe its delivery identity.
 * Reclassification retains guidance admitted under an earlier daemon composition.
 * @param store Daemon-owned endpoint persistence.
 * @param event Stable delivery identity and classified payload.
 * @returns Completion once the immutable token binding is durable.
 */
export const persistInboxItem = (
  store: InboxStore,
  event: HarnessMessageReadyEvent,
): Effect.Effect<void, EndpointStoreError> =>
  Effect.gen(function* () {
    const canonicalItem = yield* encodeRuntimeValue(event.item);
    const retained = yield* store.readInboxItem(event.deliveryToken);
    yield* store.putInboxItem({
      deliveryToken: event.deliveryToken,
      canonicalItem,
      ...(retained?.canonicalGuidance === undefined
        ? {}
        : { canonicalGuidance: retained.canonicalGuidance }),
    });
  }).pipe(Effect.withSpan("persistInboxItem"));

const decodeCursor = (
  cursor?: string,
): Effect.Effect<
  { readonly after?: number; readonly through?: number },
  EndpointStoreError
> =>
  cursor === undefined
    ? Effect.succeed({})
    : Effect.suspend(() => Encoding.decodeBase64Url(cursor)).pipe(
        Effect.flatMap((bytes) => decodeRuntimeValue(cursorSchema, bytes)),
        Effect.catchTags({
          DecodeException: () =>
            Effect.fail(
              new EndpointStoreError({ reason: "invalid-continuation" }),
            ),
          EndpointStoreError: () =>
            Effect.fail(
              new EndpointStoreError({ reason: "invalid-continuation" }),
            ),
        }),
      );

/**
 * Read the classified projection, never the underlying collective protocol messages.
 * @param store Daemon-owned endpoint persistence.
 * @param input Optional position within an earlier bounded snapshot.
 * @returns An inbox page and the continuation within that same snapshot.
 */
export const readRuntimeInbox = (
  store: InboxStore,
  input: HarnessReadInboxRequest,
): Effect.Effect<HarnessReadInboxResult, EndpointStoreError> =>
  Effect.gen(function* () {
    const page = yield* decodeCursor(input.cursor).pipe(
      Effect.flatMap((bounds) => store.readInbox(bounds)),
    );
    const items = yield* Effect.forEach(
      page.items,
      (entry) =>
        Effect.gen(function* () {
          return {
            deliveryToken: entry.deliveryToken,
            item: yield* decodeRuntimeValue(InboundItem, entry.canonicalItem),
            ...(entry.canonicalGuidance === undefined
              ? {}
              : {
                  guidance: yield* decodeRuntimeValue(
                    localGuidanceSchema,
                    entry.canonicalGuidance,
                  ),
                }),
          };
        }),
      { concurrency: 1 },
    );
    if (page.nextAfter === undefined) {
      return { items };
    }
    const cursor = yield* encodeRuntimeValue({
      after: page.nextAfter,
      through: page.through,
    });
    return { items, nextCursor: Encoding.encodeBase64Url(cursor) };
  }).pipe(Effect.withSpan("readRuntimeInbox"));

/** A delivery token for a durable item emitted locally, without a Router message. */
export const mintLocalDeliveryToken = Effect.sync(() =>
  Schema.decodeUnknownSync(DeliveryToken)(
    `dlv_${randomBytes(32).toString("base64url")}`,
  ),
);
