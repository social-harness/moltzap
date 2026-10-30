/** @file Connects host sends, inbox reads and acknowledgments to the daemon. */

import {
  DateTime,
  Deferred,
  Effect,
  Option,
  Queue,
  type Scope,
  Struct,
} from "effect";
import type {
  CollectiveOperations,
  PreparedCollective,
  ResultProvenance,
} from "../../communication/collectives/index.js";
import type { EnginePendingMessage } from "../../communication/conversations/index.js";
import type { SendResult } from "../../host-protocol/send-result.js";
import type { DaemonStore } from "../store.js";
import type {
  HistoryExportPort,
  HistoryExportRecord,
} from "./host-traffic-log.js";
import type { InboxStore } from "./store.js";
import {
  type CollectiveEmitError,
  CollectiveError,
  type CollectiveSendOutcome,
  type SendInput,
} from "../../communication/collectives/contracts.js";
import {
  DeliveryAcknowledgeError,
  SendError,
} from "../../communication/conversations/errors.js";
import {
  decodeRuntimeValue,
  type DeliveryToken,
  encodeRuntimeValue,
  type EndpointStoreError,
} from "../../communication/store/index.js";
import {
  checkOutgoing,
  type OutgoingCandidate,
} from "../../firewall/admission/firewall.js";
import {
  type AdmissionContext,
  type FirewallEnvironment,
  type InstalledFirewall,
  runAdmission,
} from "../../firewall/index.js";
import { InboundItem } from "../../host-protocol/items.js";
import {
  decodeHarnessSendRequest,
  type DeliveryOperations,
  type EventStore,
  type HarnessMessageReadyEvent,
  type HarnessReadInboxRequest,
  type HarnessSendRequest,
} from "../../host-protocol/operations.js";
import {
  type DeliveryState,
  exportOnce,
  forgetDelivery,
  makeDeliveryState,
  offerPendingMessages,
  type PendingOffer,
} from "./deliver-pending.js";
import {
  decodeInboxEntry,
  mintLocalDeliveryToken,
  persistInboxItem,
  readRuntimeEvent,
  readRuntimeInbox,
} from "./inbox.js";

/**
 * The collective layer as delivery uses it: the application send, which
 * includes local refusal, and the settling of a request's admission.
 */
type ApplicationSender = Pick<CollectiveOperations, "prepare" | "accept">;

/** What one service's delivery reads and writes. */
export interface HostDeliveryInput {
  readonly store: DaemonStore;
  readonly historyExport: HistoryExportPort;
  /** The active collective layer, absent while the service is unregistered. */
  readonly collectives: () => ApplicationSender | undefined;
  readonly firewall?: InstalledFirewall;
  readonly firewallEnvironment?: () => FirewallEnvironment | undefined;
  /** Service lifetime, independent of any host request. */
  readonly scope: Scope.Scope;
}

/**
 * What the service supplies to one pass: the active protocol's pending read,
 * acknowledgment and classifier, and the attached subscriber if any.
 */
interface PassInput<E>
  extends Pick<PendingOffer, "engine" | "classify" | "handler"> {
  readonly readPending: Effect.Effect<readonly EnginePendingMessage[], E>;
}

/** One service's delivery, created once and shared by the delivery pass and every host operation. */
export interface HostDelivery {
  readonly operations: DeliveryOperations;
  readonly eventStore: EventStore;
  /** Forget what the departed subscriber took, so the next one is offered it again. */
  readonly detach: Effect.Effect<void>;
  /**
   * Run one pass under the delivery gate. `prepare` runs once the gate is
   * held, so the active protocol and subscriber it reads are current; it
   * returns undefined when there is nothing to run. A store failure ends the
   * pass and releases the gate.
   */
  readonly runPass: <E>(
    prepare: () => PassInput<E> | undefined,
  ) => Effect.Effect<void, E | EndpointStoreError | CollectiveEmitError>;
  /**
   * Make an item the collective layer emitted durable, with a result's
   * provenance, and queue it for the next pass.
   */
  readonly queueLocalItem: (
    item: InboundItem,
    provenance?: ResultProvenance,
    terminal?: {
      readonly operationId: string;
      readonly deliveryToken: DeliveryToken;
    },
  ) => Effect.Effect<void, EndpointStoreError>;
  /** Daemon-owned checks run outside the delivery pass and publish only committed admissions. */
  readonly runAdmission: (
    publish: Effect.Effect<void>,
  ) => Effect.Effect<never, EndpointStoreError>;
}

type DeliveryContext = HostDeliveryInput & {
  readonly state: DeliveryState;
  readonly admissionWake: Queue.Queue<undefined>;
  readonly admissionFailure: Deferred.Deferred<never, EndpointStoreError>;
  readonly activeConversations: Set<string>;
};

const notRegistered = Effect.fail({ reason: "not-registered" });

/**
 * Record one completed `send` in the history export with its input and how it
 * ended: the messages certified by its return, or the error it returned.
 */
const exportSend = (
  historyExport: HistoryExportPort,
  input: SendInput,
  outcome: Extract<
    HistoryExportRecord,
    { readonly kind: "outbound" }
  >["outcome"],
): Effect.Effect<void> =>
  DateTime.now.pipe(
    Effect.flatMap((at) =>
      historyExport.record({ kind: "outbound", input, outcome, at }),
    ),
  );

const sendDecoded = (input: DeliveryContext, request: HarnessSendRequest) =>
  Effect.suspend(() => {
    const collectives = input.collectives();
    if (collectives === undefined) {
      return Effect.fail(new SendError({ reason: "not-registered" }));
    }
    return Effect.gen(function* () {
      yield* requirePresentedResponse(input, request.input);
      const prepared = yield* collectives.prepare(request.input);
      const environment = input.firewallEnvironment?.();
      const guidance =
        environment === undefined
          ? undefined
          : yield* checkOutgoing(environment, outgoingCandidate(prepared)).pipe(
              Effect.catchTag("EndpointStoreError", () =>
                Effect.fail(new SendError({ reason: "persistence-failed" })),
              ),
            );
      const outcome = yield* collectives.accept(prepared);
      return { ...outcome, ...(guidance === undefined ? {} : { guidance }) };
    }).pipe(
      Effect.tapBoth({
        onFailure: (error) =>
          exportSend(input.historyExport, request.input, {
            kind: "failed",
            error: error.message,
          }),
        onSuccess: ({ operationId, msgIds }) =>
          exportSend(input.historyExport, request.input, {
            kind: "sent",
            msgIds,
            ...(operationId === undefined ? {} : { operationId }),
          }),
      }),
      Effect.map(publicSendResult),
    );
  });

function outgoingCandidate(prepared: PreparedCollective): OutgoingCandidate {
  switch (prepared.kind) {
    case "multicast":
      return {
        to: prepared.to,
        gather: false,
        messages: [
          {
            canonicalIntent: prepared.message.canonicalIntent,
            canonicalMembership: prepared.message.canonicalMembership,
          },
        ],
      };
    case "response":
      return {
        to: prepared.response.request.to,
        gather: false,
        messages: [
          {
            canonicalIntent: prepared.response.message.canonicalIntent,
            canonicalMembership: prepared.response.message.canonicalMembership,
          },
        ],
      };
    case "collective":
      return {
        to: prepared.gather.open.to,
        gather: prepared.gather.open.op === "gather",
        messages: prepared.gather.requests.map(({ message }) => ({
          canonicalIntent: message.canonicalIntent,
          canonicalMembership: message.canonicalMembership,
        })),
      };
    default:
      return prepared satisfies never;
  }
}

/** Retained visibility is monotonic; hidden identities never reach protocol selection or diagnostics. */
function requirePresentedResponse(input: DeliveryContext, send: SendInput) {
  if (!("collectiveResponse" in send)) {
    return Effect.void;
  }
  return Effect.gen(function* () {
    const operation = yield* input.store.readCollectiveOperation(
      send.collectiveResponse.operationId,
    );
    const admission =
      operation?.origin.kind === "remote"
        ? yield* input.store.readFirewallRequestAdmission(
            operation.origin.recordHash,
          )
        : undefined;
    if (admission?.presented !== true) {
      return yield* new CollectiveError({ failure: { kind: "request-none" } });
    }
  }).pipe(
    Effect.catchTag("EndpointStoreError", () =>
      Effect.fail(new SendError({ reason: "persistence-failed" })),
    ),
  );
}

function publicSendResult(
  result: CollectiveSendOutcome & {
    readonly guidance?: SendResult["guidance"];
  },
): SendResult {
  switch (result.kind) {
    case "collective":
      return Struct.omit(result, "msgIds");
    case "multicast":
      return Struct.omit(result, "msgIds");
    case "response":
      return Struct.omit(result, "msgIds");
    default:
      return result satisfies never;
  }
}

/**
 * Run one validated send: input that fails its schema is `content-invalid`
 * before anything is sent.
 */
const sendOperation =
  (input: DeliveryContext): DeliveryOperations["send"] =>
  (request) =>
    decodeHarnessSendRequest(request).pipe(
      Effect.catchTag("ParseError", () =>
        Effect.fail(new SendError({ reason: "content-invalid" })),
      ),
      Effect.flatMap((decoded) => sendDecoded(input, decoded)),
    );

/** Retire the durable inbox binding before dropping its process-local caches. */
const acknowledgeDelivery =
  (input: DeliveryContext): DeliveryOperations["acknowledgeDelivery"] =>
  (deliveryToken) =>
    input.state.gate.withPermits(1)(
      Effect.suspend(() =>
        input.collectives() === undefined
          ? Effect.fail(
              new DeliveryAcknowledgeError({ reason: "unknown-delivery" }),
            )
          : input.store.acknowledgeInboxItem(deliveryToken).pipe(
              Effect.catchTag("EndpointStoreError", (error) =>
                Effect.fail(
                  new DeliveryAcknowledgeError({
                    reason:
                      error.reason === "not-found"
                        ? "unknown-delivery"
                        : "persistence-failed",
                  }),
                ),
              ),
              Effect.tap(() => forgetDelivery(input.state, deliveryToken)),
            ),
      ),
    );

/**
 * Read one inbox page under the delivery gate and export each entry's item
 * once, so native and webhook reads share the pass's export ordering.
 */
const readExported = <
  Page extends {
    readonly items: ReadonlyArray<{ readonly deliveryToken: DeliveryToken }>;
  },
  E,
>(
  input: DeliveryContext,
  read: Effect.Effect<Page, E>,
  itemOf: (entry: Page["items"][number]) => Effect.Effect<InboundItem, E>,
) =>
  input.state.gate.withPermits(1)(
    read.pipe(
      Effect.tap((page) =>
        Effect.forEach(
          page.items,
          (entry) =>
            exportOnce(
              input.state,
              input.historyExport,
              entry.deliveryToken,
              itemOf(entry),
            ),
          { concurrency: 1, discard: true },
        ),
      ),
    ),
  );

/** Export replayed local items before a host can read them after restart. */
const readAndExportInbox = (
  input: DeliveryContext,
  request: HarnessReadInboxRequest,
) =>
  readExported(input, readRuntimeInbox(input.store, request), (entry) =>
    Effect.succeed(entry.item),
  );

/** The webhook's raw page, decoding each stored item only to export it. */
const readWebhookInbox = (
  input: DeliveryContext,
  bounds: Parameters<InboxStore["readInbox"]>[0],
) =>
  readExported(input, input.store.readInbox(bounds), (entry) =>
    decodeRuntimeValue(InboundItem, entry.canonicalItem),
  );

/** Waiters can stop during shutdown; an acquired receipt commits with its caller state intact. */
const completeWebhookDelivery = (
  input: DeliveryContext,
  token: DeliveryToken,
  bytes: Uint8Array,
) =>
  Effect.uninterruptibleMask(() =>
    input.state.gate.take(1).pipe(
      Effect.interruptible,
      Effect.flatMap((permits) =>
        input.store.completeWebhookDelivery(token, bytes).pipe(
          Effect.tap(() => forgetDelivery(input.state, token)),
          Effect.ensuring(input.state.gate.release(permits)),
        ),
      ),
    ),
  );

/**
 * Make an item durable: into the inbox without a firewall, otherwise into
 * its conversation's private admission queue, with any provenance the
 * firewall checks it with.
 */
const persistItem = (
  input: DeliveryContext,
  event: HarnessMessageReadyEvent,
  provenance?: ResultProvenance,
) =>
  input.firewall === undefined
    ? persistInboxItem(input.store, event)
    : Effect.gen(function* () {
        yield* input.store.queueFirewallItem({
          deliveryToken: event.deliveryToken,
          canonicalItem: yield* encodeRuntimeValue(event.item),
          ...(provenance === undefined
            ? {}
            : { canonicalProvenance: yield* encodeRuntimeValue(provenance) }),
          conversation:
            event.item.kind === "multicast"
              ? event.item.message.address
              : event.item.to,
        });
      });

const readAdmitted = (
  input: DeliveryContext,
  event: HarnessMessageReadyEvent,
) =>
  input.store
    .readInboxItem(event.deliveryToken)
    .pipe(
      Effect.flatMap((retained) =>
        retained === undefined || retained.acknowledged
          ? Effect.succeed(Option.none<HarnessMessageReadyEvent>())
          : decodeInboxEntry(retained).pipe(
              Effect.map((decoded) =>
                Option.some({ deliveryToken: event.deliveryToken, ...decoded }),
              ),
            ),
      ),
    );

const queueLocalItem =
  (input: DeliveryContext): HostDelivery["queueLocalItem"] =>
  (item, provenance, terminal) =>
    Effect.gen(function* () {
      const deliveryToken =
        terminal?.deliveryToken ?? (yield* mintLocalDeliveryToken);
      if (terminal === undefined) {
        yield* persistItem(input, { deliveryToken, item }, provenance);
      } else {
        yield* input.store.publishCollectiveItem({
          operationId: terminal.operationId,
          deliveryToken,
          canonicalItem: yield* encodeRuntimeValue(item),
          conversation:
            item.kind === "multicast" ? item.message.address : item.to,
          ...(provenance === undefined
            ? {}
            : { canonicalProvenance: yield* encodeRuntimeValue(provenance) }),
          firewall: input.firewall !== undefined,
        });
      }
      input.state.localItems.set(deliveryToken, item);
    });

/**
 * The admission worker's view of delivery. It shows a committed disposition
 * under the delivery gate: an admitted item joins the local items and a
 * withheld one is forgotten.
 */
function admissionContext(input: DeliveryContext): AdmissionContext {
  return {
    ...input,
    showDisposition: (deliveryToken, item, disposition) =>
      input.state.gate.withPermits(1)(
        disposition === "withheld"
          ? forgetDelivery(input.state, deliveryToken)
          : Effect.sync(() => {
              input.state.localItems.set(deliveryToken, item);
            }),
      ),
  };
}

/** The pass's view of the service's delivery and the protocol it serves. */
const pendingOffer = <E>(
  input: DeliveryContext,
  pass: PassInput<E>,
): PendingOffer => ({
  engine: pass.engine,
  classify: pass.classify,
  ...(pass.handler === undefined ? {} : { handler: pass.handler }),
  persist: (event) => persistItem(input, event),
  readAdmitted: (event) => readAdmitted(input, event),
  historyExport: input.historyExport,
  state: input.state,
});

const runPass = <E>(
  input: DeliveryContext,
  prepare: () => PassInput<E> | undefined,
): Effect.Effect<void, E | EndpointStoreError | CollectiveEmitError> =>
  input.state.gate
    .withPermits(1)(
      Effect.suspend(() => {
        const pass = prepare();
        if (pass === undefined) {
          return Effect.void;
        }
        return pass.readPending.pipe(
          Effect.flatMap((messages) =>
            offerPendingMessages(pendingOffer(input, pass), messages),
          ),
        );
      }),
    )
    .pipe(Effect.tap(() => Queue.offer(input.admissionWake, undefined)));

/**
 * Recover the inbox left by the previous process, then build the service's
 * delivery over it. With a firewall, every runtime path reads the admitted view.
 *
 * ```mermaid
 * flowchart LR
 *   C[Certified message] --> Q[Private conversation queue]
 *   Q --> F[Run full incoming middleware chain]
 *   F --> A[Compare evidence and commit disposition]
 *   A -->|admit| V[Inbox with original item and local guidance]
 *   A -->|hold| H[Retain privately for inspection]
 *   V --> R[Native subscription, read-event, inbox and webhook]
 * ```
 * @param service The store, history export, active collective layer and service scope.
 * @returns The delivery state, the host operations and the webhook's inbox view.
 */
export const makeHostDelivery = (
  service: HostDeliveryInput,
): Effect.Effect<HostDelivery, EndpointStoreError> =>
  Effect.gen(function* () {
    const input: DeliveryContext = {
      ...service,
      state: yield* makeDeliveryState,
      admissionWake: yield* Queue.sliding<undefined>(1),
      admissionFailure: yield* Deferred.make<never, EndpointStoreError>(),
      activeConversations: new Set(),
    };
    const eventStore: EventStore = {
      ...input.store,
      readInbox: (bounds) => readWebhookInbox(input, bounds),
      completeWebhookDelivery: (token, bytes) =>
        completeWebhookDelivery(input, token, bytes),
    };
    return {
      detach: Effect.sync(() => {
        input.state.publishedDeliveries.clear();
      }),
      runPass: <E>(prepare: () => PassInput<E> | undefined) =>
        runPass(input, prepare),
      queueLocalItem: queueLocalItem(input),
      runAdmission: (publish: Effect.Effect<void>) =>
        runAdmission(admissionContext(input), publish),
      operations: Object.freeze({
        send: sendOperation(input),
        readInboxSummary: input.store.readInboxSummary,
        readEvent: ({ eventId }: { readonly eventId: string }) =>
          input.collectives() === undefined
            ? notRegistered
            : readRuntimeEvent(input.store, eventId),
        readInbox: (request: HarnessReadInboxRequest) =>
          input.collectives() === undefined
            ? notRegistered
            : readAndExportInbox(input, request),
        acknowledgeDelivery: acknowledgeDelivery(input),
      }),
      eventStore,
    };
  }).pipe(Effect.withSpan("makeHostDelivery"));
