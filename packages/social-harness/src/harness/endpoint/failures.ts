/** @file Closed error projection at the private native MCP boundary. */

import { ProtocolError } from "@modelcontextprotocol/client";
import {
  type DeliveryAcknowledgeError,
  deliveryAcknowledgeFailureReasons,
  ListenError,
} from "../../communication/conversations/errors.js";

const operationReason = (cause: unknown): unknown => {
  const data: unknown = ProtocolError.isInstance(cause) ? cause.data : cause;
  return typeof data === "object" && data !== null && "reason" in data
    ? data.reason
    : undefined;
};

/** Upstream values cannot extend Client's closed failure vocabulary. */
export function isReason<Reason>(
  value: unknown,
  allowed: readonly Reason[],
): value is Reason {
  return allowed.some((candidate) => candidate === value);
}

/** Receipt failures preserve consumer lifetime refusals without SDK diagnostics. */
export const acknowledgeReason = (
  cause: unknown,
): DeliveryAcknowledgeError["reason"] => {
  const reason = operationReason(cause);
  return isReason(reason, deliveryAcknowledgeFailureReasons)
    ? reason
    : "transport-failed";
};

/** Polling and unread recovery interpret lifecycle failures identically. */
export const listenFailure = (cause: unknown): ListenError => {
  const reason = operationReason(cause);
  switch (reason) {
    case "already-listening":
    case "consumer-revoked":
    case "incompatible-daemon":
    case "decode-failed":
    case "transport-failed":
      return new ListenError({ reason });
    default:
      return new ListenError({ reason: "transport-failed" });
  }
};
