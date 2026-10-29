/** @file Classified inbox events shared by native delivery transports. */

import { Effect } from "effect";
import { InboundItem } from "../../communication/collectives/inbound.js";
import {
  decodeRuntimeValue,
  type InboxEntry,
} from "../../communication/store/index.js";
import { localGuidanceSchema } from "../../firewall/outcome/index.js";
import { maximumEventBytes } from "../../host-protocol/index.js";
import { INBOX_ITEM_EVENT } from "../../host-protocol/names.js";
import { eventIdOf } from "../../host-protocol/operations.js";

// safer-arch-ignore file-implicit-boundary-module: Polling and webhook delivery share this one item formatter and envelope bound; nothing outside daemon/mcp reads them.

/**
 * Keeps the original item and separate local guidance together. An envelope
 * exceeding the transport bound becomes a reference to the retained event;
 * neither content nor guidance is truncated.
 * @param entry The admitted, immutable inbox row.
 * @param timestamp The occurrence's Unix time in milliseconds.
 * @returns A bounded event whose identity remains stable across retries.
 */
export const makeItemEvent = Effect.fn("makeItemEvent")(function* (
  entry: InboxEntry,
  timestamp: number,
) {
  const item = yield* decodeRuntimeValue(InboundItem, entry.canonicalItem);
  const guidance =
    entry.canonicalGuidance === undefined
      ? undefined
      : yield* decodeRuntimeValue(localGuidanceSchema, entry.canonicalGuidance);
  const event = {
    eventId: eventIdOf(entry.deliveryToken),
    name: INBOX_ITEM_EVENT,
    timestamp: new Date(timestamp).toISOString(),
    cursor: null,
    data: {
      kind: "item",
      item,
      ...(guidance === undefined ? {} : { guidance }),
    },
  } as const;
  return Buffer.byteLength(JSON.stringify(event), "utf8") <= maximumEventBytes
    ? event
    : {
        ...event,
        data: {
          kind: "reference" as const,
          itemKind: item.kind,
          bytes:
            entry.canonicalItem.byteLength +
            (entry.canonicalGuidance?.byteLength ?? 0),
        },
      };
});
