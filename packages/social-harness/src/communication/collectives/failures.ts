/** @file How a collective send reports failure: a refused send, routed to its result or inbound, and an emitted item the service cannot keep. */

import { Effect } from "effect";
import type { SendError } from "../conversations/errors.js";
import type { MessageAddressInput } from "../records/values.js";
import type {
  CollectiveEmitError,
  CollectiveError,
  CollectiveId,
  CollectiveSendOutcome,
  FailureDelivery,
} from "./forms.js";
import type { InboundItem } from "./inbound.js";
import type { CollectiveSendError } from "./ports.js";
import {
  type CheckedGuidance,
  FirewallSendError,
} from "../../firewall/outcome/index.js";

/**
 * A refused collective send, with the address its failure item routes to.
 * The address is the operation's own, or the requester's for a response.
 * A send refused after the firewall admitted it keeps that check's advice.
 */
export interface RefusedSend<E> {
  readonly id: CollectiveId;
  readonly to: MessageAddressInput;
  readonly error: E;
  readonly guidance?: CheckedGuidance;
}

/**
 * Deliver a refused collective send's error where the host wants it. With
 * `inbound` the send completes, naming the operation and carrying the advice
 * of a check that admitted it before the refusal, if any, and the error
 * arrives as an `operationFailed` item carrying the same text. When that item cannot
 * be kept, the send fails with the refusal itself, the outcome it had. A
 * firewall refusal is always the send's own failure: the agent revises from
 * the tool error, and no inbound item stands in for it.
 */
export function reportFailure(
  emit: (item: InboundItem) => Effect.Effect<void, CollectiveEmitError>,
  failureDelivery: FailureDelivery,
  send: Effect.Effect<CollectiveSendOutcome, OperationRefusal>,
): Effect.Effect<CollectiveSendOutcome, CollectiveSendError> {
  return send.pipe(
    Effect.catchAll(
      (refused): Effect.Effect<CollectiveSendOutcome, CollectiveSendError> => {
        if (refused instanceof FirewallSendError) {
          return Effect.fail(refused);
        }
        switch (failureDelivery) {
          case "result":
            return Effect.fail(refused.error);
          case "inbound":
            return emit({
              kind: "operationFailed",
              id: refused.id,
              to: refused.to,
              error: refused.error.message,
            }).pipe(
              Effect.as({
                operationId: refused.id,
                postIds: [],
                guidance: refused.guidance,
              }),
              Effect.catchTag("CollectiveEmitError", () =>
                Effect.fail(refused.error),
              ),
            );
          default: {
            const exhaustive: never = failureDelivery;
            return exhaustive;
          }
        }
      },
    ),
  );
}

/** How a collective operation's send is refused: by the layer, or by the firewall. */
export type OperationRefusal =
  | RefusedSend<SendError | CollectiveError>
  | FirewallSendError;

/**
 * Tag every refusal but a firewall's with the operation it refuses; a
 * firewall refusal stays the send's own failure.
 * @param id The operation the refusal names.
 * @param to The address its failure item routes to.
 * @returns The tagging function.
 */
export function refuseOperation(id: CollectiveId, to: MessageAddressInput) {
  return (error: CollectiveSendError): OperationRefusal =>
    error instanceof FirewallSendError ? error : { id, to, error };
}

/**
 * Tag a send's error with the operation id, the address its failure item
 * routes to, and, for a send refused after the firewall admitted it, the
 * advice of the admitting check.
 */
export function refusedAs<E>(
  id: CollectiveId,
  to: MessageAddressInput,
  guidance?: CheckedGuidance,
) {
  return (error: E): RefusedSend<E> => ({ id, to, error, guidance });
}
