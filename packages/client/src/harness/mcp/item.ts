/** @file Classified inbox events shared by native delivery transports. */

import { Effect } from "effect";
import {
  type InboundItem,
  retainedInboundItem,
} from "../../communication/collectives/inbound.js";
import {
  decodeRuntimeValue,
  type InboxEntry,
} from "../../communication/store/index.js";
import { localGuidanceSchema } from "../../firewall/outcome/index.js";
import { maximumEventBytes } from "../protocol/index.js";
import { INBOX_ITEM_EVENT } from "../protocol/names.js";
import { eventIdOf } from "../protocol/operations.js";

// safer-arch-ignore file-implicit-boundary-module: Polling and webhook delivery share this one item formatter and envelope bound; nothing outside harness/mcp reads them.

/**
 * Replaces an envelope exceeding the transport bound with a reference to the
 * retained event; neither content nor guidance is truncated.
 * @param event The complete item event.
 * @param bytes The retained item and guidance size the reference reports.
 * @returns The event when it fits, otherwise its reference form.
 */
export const boundItemEvent = <
  E extends { readonly data: { readonly item: Pick<InboundItem, "kind"> } },
>(
  event: E,
  bytes: number,
) =>
  Buffer.byteLength(JSON.stringify(event), "utf8") <= maximumEventBytes
    ? event
    : {
        ...event,
        data: {
          kind: "reference" as const,
          itemKind: event.data.item.kind,
          bytes,
        },
      };

/**
 * Keeps the original item and separate local guidance together. A retained
 * historical item decodes to its current form.
 * @param entry The admitted, immutable inbox row.
 * @param timestamp The occurrence's Unix time in milliseconds.
 * @returns A bounded event whose identity remains stable across retries.
 */
export const makeItemEvent = Effect.fn("makeItemEvent")(function* (
  entry: InboxEntry,
  timestamp: number,
) {
  const item = yield* decodeRuntimeValue(
    retainedInboundItem,
    entry.canonicalItem,
  );
  const guidance =
    entry.canonicalGuidance === undefined
      ? undefined
      : yield* decodeRuntimeValue(localGuidanceSchema, entry.canonicalGuidance);
  const envelope = {
    eventId: eventIdOf(entry.deliveryToken),
    name: INBOX_ITEM_EVENT,
    timestamp: new Date(timestamp).toISOString(),
    cursor: null,
  } as const;
  return boundItemEvent(
    {
      ...envelope,
      data: {
        kind: "item" as const,
        item,
        ...(guidance === undefined ? {} : { guidance }),
      },
    },
    entry.canonicalItem.byteLength + (entry.canonicalGuidance?.byteLength ?? 0),
  );
});
