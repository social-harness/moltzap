/** @file Pending durable deliveries and the classify, engine and subscriber ports a delivery pass runs over. */

import { Effect, Schema } from "effect";
import type { InboundItem } from "../communication/collectives/inbound.js";
import type { EnginePendingMessage } from "../communication/conversations/index.js";
import type { PendingOffer } from "../daemon/inbox/deliver-pending.js";
import type { HarnessMessageReadyEvent } from "../host-protocol/operations.js";
import type { TestCollectiveOperations as CollectiveOperations } from "./collective-send.js";
import { InboundMessage } from "../communication/conversations/message.js";
import { RecordHash } from "../communication/records/index.js";
import { DeliveryToken } from "../communication/store/index.js";
import { digest, testAgentView } from "./agent-card-fixtures.js";

/**
 * A pending durable delivery of a direct message from Bob whose delivery token,
 * record hash and MsgId are all filled with `byte`, and whose text names it.
 * @param byte Value repeated across each 32-byte identifier.
 * @returns The delivery as the engine lists it.
 */
export function pendingMessage(byte: number): EnginePendingMessage {
  return {
    deliveryToken: Schema.decodeUnknownSync(DeliveryToken)(
      digest("dlv_", byte),
    ),
    recordHash: Schema.decodeUnknownSync(RecordHash)(digest("rch_", byte)),
    message: Schema.decodeUnknownSync(InboundMessage)({
      kind: "direct",
      msgId: digest("msg_", byte),
      address: "agent:bob",
      sender: testAgentView("agent:bob"),
      content: [{ type: "text", text: `delivery ${String(byte)}` }],
    }),
  };
}

/** Classifies every message as a multicast, so the pass publishes it. */
export const publishEveryMessage: CollectiveOperations["classify"] = ({
  message,
}) => Effect.succeedSome<InboundItem>({ kind: "multicast", message });

/**
 * An engine that acknowledges every delivery.
 * @param acknowledged Receives each acknowledged token, in order.
 * @returns The engine's acknowledgment port.
 */
export function recordAcknowledgments(
  acknowledged: string[],
): PendingOffer["engine"] {
  return {
    acknowledgeMessage: (deliveryToken) =>
      Effect.sync(() => {
        acknowledged.push(deliveryToken);
      }),
  };
}

/**
 * A subscriber that takes every event it is offered.
 * @param taken Receives each taken event, in order.
 * @returns The subscriber's publish edge.
 */
export function takeEvery(
  taken: HarnessMessageReadyEvent[],
): NonNullable<PendingOffer["handler"]> {
  return {
    publish: (event) => {
      taken.push(event);
      return true;
    },
  };
}
