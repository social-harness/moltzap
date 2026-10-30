/** @file Classifies pending messages and offers their items and collective results to the host in order. */

import { DateTime, Effect, Option } from "effect";
import type { CollectiveEmitError } from "../../communication/collectives/contracts.js";
import type { CollectiveOperations } from "../../communication/collectives/index.js";
import type {
  EndpointEngine,
  EnginePendingMessage,
} from "../../communication/conversations/index.js";
import type { EndpointStoreError } from "../../communication/store/index.js";
import type { DeliveryToken } from "../../communication/store/types.js";
import type { InboundItem } from "../../host-protocol/items.js";
import type { HarnessMessageReadyEvent } from "../../host-protocol/operations.js";
import type { HistoryExportPort } from "./host-traffic-log.js";

/**
 * One instance per service, shared by the delivery pass, host reads,
 * acknowledgments and webhook receipts. `gate` serializes those so an item is
 * exported once and retired once. Emitting a local item never waits on it:
 * the collective layer can emit from inside a pass that already holds it.
 */
export interface DeliveryState {
  readonly gate: Effect.Semaphore;
  /** Deliveries the attached subscriber already took. */
  readonly publishedDeliveries: Set<string>;
  /** Deliveries whose item the history export already recorded. */
  readonly exportedDeliveries: Set<string>;
  /** The item each unacknowledged durable delivery classified into. */
  readonly classifiedItems: Map<string, InboundItem>;
  /**
   * Items the collective layer emitted, in emission order, each under a
   * service-minted delivery token until the host acknowledges it. They are
   * durable before insertion; this map caches the current process values.
   */
  readonly localItems: Map<DeliveryToken, InboundItem>;
}

/** Empty delivery state with its own gate. */
export const makeDeliveryState: Effect.Effect<DeliveryState> = Effect.map(
  Effect.makeSemaphore(1),
  (gate) => ({
    gate,
    publishedDeliveries: new Set(),
    exportedDeliveries: new Set(),
    classifiedItems: new Map(),
    localItems: new Map(),
  }),
);

/**
 * Drop a retired delivery from every process-local cache.
 * @param state The shared delivery state.
 * @param deliveryToken The retired delivery.
 * @returns Completion once the caches no longer hold it.
 */
export const forgetDelivery = (
  state: DeliveryState,
  deliveryToken: DeliveryToken,
): Effect.Effect<void> =>
  Effect.sync(() => {
    state.publishedDeliveries.delete(deliveryToken);
    state.exportedDeliveries.delete(deliveryToken);
    state.classifiedItems.delete(deliveryToken);
    state.localItems.delete(deliveryToken);
  });

/**
 * Record a delivery's item in the history export the first time any path
 * offers or reads it. The item is read only on that first time, so a caller
 * holding stored bytes decodes them only when the line is written.
 * @param state The shared delivery state.
 * @param historyExport The export the line goes to.
 * @param deliveryToken The delivery the item belongs to.
 * @param item The item, read only when the delivery is not yet exported.
 * @returns Completion once the line is recorded or was already recorded.
 */
export const exportOnce = <E>(
  state: DeliveryState,
  historyExport: HistoryExportPort,
  deliveryToken: DeliveryToken,
  item: Effect.Effect<InboundItem, E>,
): Effect.Effect<void, E> =>
  state.exportedDeliveries.has(deliveryToken)
    ? Effect.void
    : Effect.gen(function* () {
        const inbound = yield* item;
        const at = yield* DateTime.now;
        yield* historyExport.record({ kind: "inbound", item: inbound, at });
        state.exportedDeliveries.add(deliveryToken);
      }).pipe(Effect.withSpan("exportOnce"));

/** The subscriber's publish edge; false means it refused the event. */
interface Subscriber {
  readonly publish: (event: HarnessMessageReadyEvent) => boolean;
}

/** What one pass over pending deliveries reads and changes. */
export interface PendingOffer {
  readonly engine: Pick<EndpointEngine, "acknowledgeMessage">;
  readonly classify: CollectiveOperations["classify"];
  /** Classified items are durable even while no host is attached. */
  readonly persist: (
    event: HarnessMessageReadyEvent,
  ) => Effect.Effect<void, EndpointStoreError>;
  /** Read the durable admitted projection before any export or notification. */
  readonly readAdmitted: (
    event: HarnessMessageReadyEvent,
  ) => Effect.Effect<
    Option.Option<HarnessMessageReadyEvent>,
    EndpointStoreError
  >;
  /** The attached subscriber, absent while none is attached. */
  readonly handler?: Subscriber;
  readonly historyExport: HistoryExportPort;
  /**
   * The service's delivery state. Its classified items let a delivery be
   * decoded and classified once rather than on every pass.
   */
  readonly state: DeliveryState;
}

/**
 * Acknowledge a delivery the collective layer consumed. A failed
 * acknowledgment is logged and the delivery stays pending: the next pass
 * classifies it again, which records nothing twice because the requester
 * and every all_gather member keep only a member's first answer and a member
 * applies a close once, and acknowledges it again. It does not end the
 * pass: store failures end it through the pending read that starts it or
 * the persistence of a classified item.
 */
const acknowledgeConsumed = (
  offer: PendingOffer,
  pending: EnginePendingMessage,
): Effect.Effect<void> =>
  offer.engine
    .acknowledgeMessage(pending.deliveryToken)
    .pipe(
      Effect.catchAll((error) =>
        Effect.logWarning(`consumed delivery stays pending: ${error.message}`),
      ),
    );

/**
 * Record an item in the history export the first time it is offered, then
 * offer it to the subscriber, yielding whether the subscriber took it. The
 * line lands before the item is visible, for the reason `makeHistoryExport`
 * gives.
 *
 * The append runs inside the pass, under the delivery gate. It cannot
 * deadlock: the export's own gate is taken only inside `record`, which takes
 * no other lock, and a send records its outbound line without the delivery
 * gate. Its cost is one append per item on first offer, only when an operator
 * configured the export, and an acknowledgment waits for the pass that holds
 * the gate.
 */
const publishItem = (
  offer: PendingOffer,
  handler: Subscriber,
  event: HarnessMessageReadyEvent,
): Effect.Effect<boolean, EndpointStoreError> =>
  Effect.gen(function* () {
    const admitted = yield* offer.readAdmitted(event);
    if (Option.isNone(admitted)) {
      return true;
    }
    yield* exportOnce(
      offer.state,
      offer.historyExport,
      event.deliveryToken,
      Effect.succeed(admitted.value.item),
    );
    if (!handler.publish(admitted.value)) {
      return false;
    }
    offer.state.publishedDeliveries.add(event.deliveryToken);
    return true;
  });

const classifyOnce = (
  offer: PendingOffer,
  pending: EnginePendingMessage,
): Effect.Effect<
  Option.Option<HarnessMessageReadyEvent>,
  EndpointStoreError | CollectiveEmitError
> =>
  offer.classify(pending).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () =>
          acknowledgeConsumed(offer, pending).pipe(Effect.as(Option.none())),
        onSome: (item) =>
          offer.persist({ deliveryToken: pending.deliveryToken, item }).pipe(
            Effect.zipRight(
              Effect.sync(() => {
                offer.state.classifiedItems.set(pending.deliveryToken, item);
                return Option.some({
                  deliveryToken: pending.deliveryToken,
                  item,
                });
              }),
            ),
          ),
      }),
    ),
  );

/**
 * Classify one durable delivery not yet published: acknowledge it when the
 * collective layer consumes it, otherwise return its event, reusing the item
 * an earlier pass classified.
 */
const classifyPending = (
  offer: PendingOffer,
  pending: EnginePendingMessage,
): Effect.Effect<
  Option.Option<HarnessMessageReadyEvent>,
  EndpointStoreError | CollectiveEmitError
> => {
  const { deliveryToken } = pending;
  if (offer.state.publishedDeliveries.has(deliveryToken)) {
    return Effect.succeed(Option.none());
  }
  const classified = offer.state.classifiedItems.get(deliveryToken);
  return classified === undefined
    ? classifyOnce(offer, pending)
    : Effect.succeed(Option.some({ deliveryToken, item: classified }));
};

/** Publish events in order, skipping published ones, until one is refused. */
const publishInOrder = (
  offer: PendingOffer,
  handler: Subscriber,
  events: readonly HarnessMessageReadyEvent[],
): Effect.Effect<void, EndpointStoreError> =>
  Effect.gen(function* () {
    for (const event of events) {
      if (offer.state.publishedDeliveries.has(event.deliveryToken)) {
        continue;
      }
      if (!(yield* publishItem(offer, handler, event))) {
        return;
      }
    }
  });

/**
 * Offer pending deliveries in order, then the collective layer's own items.
 * Every durable delivery is classified: the layer consumes protocol messages,
 * which are acknowledged here whether or not a subscriber is attached, so
 * answers are recorded and deadlines complete with nobody listening. Items
 * are published while a subscriber accepts them; after the first refusal,
 * or with no subscriber, they stay pending for a later pass.
 * @param offer The engine, classifier and subscriber, and the delivery state
 * whose local items follow the durable deliveries.
 * @param messages Pending durable deliveries in order.
 * @returns Completion after every delivery is consumed or offered, or the
 * store's failure to keep a classified or emitted item, which ends the pass.
 */
export const offerPendingMessages = (
  offer: PendingOffer,
  messages: readonly EnginePendingMessage[],
): Effect.Effect<void, EndpointStoreError | CollectiveEmitError> =>
  Effect.gen(function* () {
    const classified = yield* Effect.forEach(
      messages,
      (pending) => classifyPending(offer, pending),
      { concurrency: 1 },
    );
    const handler = offer.handler;
    if (handler === undefined) {
      return;
    }
    yield* publishInOrder(offer, handler, [
      ...classified.flatMap((event) => Option.toArray(event)),
      ...[...offer.state.localItems].map(([deliveryToken, item]) => ({
        deliveryToken,
        item,
      })),
    ]);
  }).pipe(Effect.withSpan("offerPendingMessages"));
