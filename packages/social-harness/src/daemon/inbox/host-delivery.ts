/** @file Connects host sends, inbox reads and acknowledgments to the daemon. */

import * as SqlClient from "@effect/sql/SqlClient";
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
import type { Firewall } from "../../firewall/index.js";
import type { SendResult } from "../../host-protocol/send-result.js";
import type {
  HistoryExportPort,
  HistoryExportRecord,
} from "./host-traffic-log.js";
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
  EndpointStoreError,
  readCollectiveOperation,
} from "../../communication/store/index.js";
import { saveCheckDecision } from "../../firewall/store/index.js";
import {
  FirewallSendError,
  refusalReason,
} from "../../host-protocol/advice.js";
import { InboundItem } from "../../host-protocol/items.js";
import {
  decodeHarnessSendRequest,
  type DeliveryOperations,
  type HarnessMessageReadyEvent,
  type HarnessReadInboxRequest,
  type HarnessSendRequest,
} from "../../host-protocol/operations.js";
import { publishCollectiveItem, queueFirewallItem } from "../store.js";
import {
  type DeliveryState,
  exportOnce,
  forgetDelivery,
  makeDeliveryState,
  offerPendingMessages,
  type PendingOffer,
} from "./deliver-pending.js";
import { readFirewallRequestAdmission } from "./evidence.js";
import {
  type FirewallEnvironment,
  type OutgoingCandidate,
  prepareOutgoingCheck,
} from "./firewall-context.js";
import {
  decodeInboxEntry,
  mintLocalDeliveryToken,
  persistInboxItem,
  readRuntimeEvent,
  readRuntimeInbox,
} from "./inbox.js";
import { type AdmissionContext, runAdmission } from "./incoming-worker.js";
import {
  acknowledgeInboxItem,
  type EventStore,
  readEventState,
  readInbox,
  readInboxItem,
  readInboxSummary,
  completeWebhookDelivery as saveWebhookDelivery,
  writeEventState,
} from "./store.js";

/** Ordinary collective preparation fixes identity before local assessment and protocol acceptance. */
type ApplicationSender = Pick<CollectiveOperations, "prepare" | "accept">;

/** What one service's delivery reads and writes. */
export interface HostDeliveryInput {
  readonly experiments?: {
    readonly hideGroups: boolean;
    readonly hideCollectives: boolean;
  };
  readonly historyExport: HistoryExportPort;
  /** The active collective layer, absent while the service is unregistered. */
  readonly collectives: () => ApplicationSender | undefined;
  readonly firewall?: Firewall;
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
  readonly sql: SqlClient.SqlClient;
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
      yield* checkExperimentSend(input.experiments, request.input);
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

/** Outgoing assessment is retained before acceptance; a refusal creates no protocol intent. */
function checkOutgoing(
  environment: FirewallEnvironment,
  candidate: OutgoingCandidate,
) {
  return Effect.gen(function* () {
    const prepared = yield* prepareOutgoingCheck(environment, candidate);
    const [checked] = yield* environment.firewall.check([prepared]);
    if (checked === undefined) {
      return yield* new EndpointStoreError({ reason: "corrupt" });
    }
    yield* saveCheckDecision(checked.completion).pipe(
      Effect.provideService(SqlClient.SqlClient, environment.sql),
    );
    if (!checked.completion.admit) {
      return yield* new FirewallSendError({
        checkId: checked.completion.checkId,
        refusal: refusalReason(checked.result.reason),
        feedback: checked.result.feedback,
      });
    }
    return checked.guidance;
  });
}

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

/** What the agent reads for each capability an evaluation hides. */
const hiddenFeatures = {
  groups:
    "group addresses are not available; message each agent at its agent: address",
  collectives:
    "gather, all_gather and answers are not available; send plain text instead",
};

/**
 * The refusal of a send that uses a hidden capability, linked to the page that
 * lists the experiment switches.
 * @param feature The hidden capability the send uses.
 * @returns The send error every send route returns.
 */
export const hiddenFeatureRefusal = (
  feature: keyof typeof hiddenFeatures,
): SendError =>
  new SendError({
    reason: "content-invalid",
    detail: `${hiddenFeatures[feature]}. Docs: https://docs.moltzap.xyz/reference/daemon-experiments#experiment-switches`,
  });

/**
 * Refuse hidden capabilities before any send dispatch, with groups taking precedence.
 * @param configuration The switches captured at daemon startup.
 * @param input The semantic send supplied by any daemon caller.
 * @returns Nothing for an available send, or its refusal.
 */
function checkExperimentSend(
  configuration: HostDeliveryInput["experiments"],
  input: SendInput,
): Effect.Effect<void, SendError> {
  let feature: keyof typeof hiddenFeatures | undefined;
  if (configuration?.hideGroups && input.to.startsWith("group:")) {
    feature = "groups";
  } else if (configuration?.hideCollectives && isCollectiveSend(input)) {
    feature = "collectives";
  }
  return feature === undefined
    ? Effect.void
    : Effect.fail(hiddenFeatureRefusal(feature));
}

function isCollectiveSend(input: SendInput): boolean {
  return (
    "collectiveResponse" in input ||
    input.collective?.op === "gather" ||
    input.collective?.op === "all_gather"
  );
}

/** Retained visibility is monotonic; hidden identities never reach protocol selection or diagnostics. */
function requirePresentedResponse(input: DeliveryContext, send: SendInput) {
  if (!("collectiveResponse" in send)) {
    return Effect.void;
  }
  return Effect.gen(function* () {
    const operation = yield* readCollectiveOperation(
      send.collectiveResponse.operationId,
    ).pipe(Effect.provideService(SqlClient.SqlClient, input.sql));
    const admission =
      operation?.origin.kind === "remote"
        ? yield* readFirewallRequestAdmission(operation.origin.recordHash).pipe(
            Effect.provideService(SqlClient.SqlClient, input.sql),
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
          : acknowledgeInboxItem(deliveryToken)
              .pipe(Effect.provideService(SqlClient.SqlClient, input.sql))
              .pipe(
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
  readExported(
    input,
    readRuntimeInbox(request).pipe(
      Effect.provideService(SqlClient.SqlClient, input.sql),
    ),
    (entry) => Effect.succeed(entry.item),
  );

/** The webhook's raw page, decoding each stored item only to export it. */
const readWebhookInbox = (
  input: DeliveryContext,
  bounds: Parameters<typeof readInbox>[0],
) =>
  readExported(
    input,
    readInbox(bounds).pipe(
      Effect.provideService(SqlClient.SqlClient, input.sql),
    ),
    (entry) => decodeRuntimeValue(InboundItem, entry.canonicalItem),
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
        saveWebhookDelivery(token, bytes)
          .pipe(Effect.provideService(SqlClient.SqlClient, input.sql))
          .pipe(
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
    ? persistInboxItem(event).pipe(
        Effect.provideService(SqlClient.SqlClient, input.sql),
      )
    : Effect.gen(function* () {
        yield* queueFirewallItem({
          deliveryToken: event.deliveryToken,
          canonicalItem: yield* encodeRuntimeValue(event.item),
          ...(provenance === undefined
            ? {}
            : { canonicalProvenance: yield* encodeRuntimeValue(provenance) }),
          conversation:
            event.item.kind === "multicast"
              ? event.item.message.address
              : event.item.to,
        }).pipe(Effect.provideService(SqlClient.SqlClient, input.sql));
      });

const readAdmitted = (
  input: DeliveryContext,
  event: HarnessMessageReadyEvent,
) =>
  readInboxItem(event.deliveryToken)
    .pipe(Effect.provideService(SqlClient.SqlClient, input.sql))
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
        yield* publishCollectiveItem({
          operationId: terminal.operationId,
          deliveryToken,
          canonicalItem: yield* encodeRuntimeValue(item),
          conversation:
            item.kind === "multicast" ? item.message.address : item.to,
          ...(provenance === undefined
            ? {}
            : { canonicalProvenance: yield* encodeRuntimeValue(provenance) }),
          firewall: input.firewall !== undefined,
        }).pipe(Effect.provideService(SqlClient.SqlClient, input.sql));
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
 *   Q --> F[Check the captured incoming message]
 *   F --> A[Commit the captured assessment disposition]
 *   A -->|admit| V[Inbox with original item and local guidance]
 *   A -->|hold| H[Retain privately for inspection]
 *   V --> R[Native subscription, read-event, inbox and webhook]
 * ```
 * @param service The store, history export, active collective layer and service scope.
 * @returns The delivery state, the host operations and the webhook's inbox view.
 */
export const makeHostDelivery = (
  service: HostDeliveryInput,
): Effect.Effect<HostDelivery, EndpointStoreError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const input: DeliveryContext = {
      ...service,
      sql: yield* SqlClient.SqlClient,
      state: yield* makeDeliveryState,
      admissionWake: yield* Queue.sliding<undefined>(1),
      admissionFailure: yield* Deferred.make<never, EndpointStoreError>(),
      activeConversations: new Set(),
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
      operations: deliveryOperations(input),
      eventStore: eventOperations(input),
    };
  }).pipe(Effect.withSpan("makeHostDelivery"));

function eventOperations(input: DeliveryContext): EventStore {
  return {
    readEventState: () =>
      readEventState().pipe(
        Effect.provideService(SqlClient.SqlClient, input.sql),
      ),
    writeEventState: (bytes) =>
      writeEventState(bytes).pipe(
        Effect.provideService(SqlClient.SqlClient, input.sql),
      ),
    readInboxItem: (token) =>
      readInboxItem(token).pipe(
        Effect.provideService(SqlClient.SqlClient, input.sql),
      ),
    readInboxSummary: () =>
      readInboxSummary().pipe(
        Effect.provideService(SqlClient.SqlClient, input.sql),
      ),
    readInbox: (bounds) => readWebhookInbox(input, bounds),
    completeWebhookDelivery: (token, bytes) =>
      completeWebhookDelivery(input, token, bytes),
  };
}

function deliveryOperations(input: DeliveryContext): DeliveryOperations {
  return Object.freeze({
    send: sendOperation(input),
    readInboxSummary: () =>
      readInboxSummary().pipe(
        Effect.provideService(SqlClient.SqlClient, input.sql),
      ),
    readEvent: ({ eventId }: { readonly eventId: string }) =>
      input.collectives() === undefined
        ? notRegistered
        : readRuntimeEvent(eventId).pipe(
            Effect.provideService(SqlClient.SqlClient, input.sql),
          ),
    readInbox: (request: HarnessReadInboxRequest) =>
      input.collectives() === undefined
        ? notRegistered
        : readAndExportInbox(input, request),
    acknowledgeDelivery: acknowledgeDelivery(input),
  });
}
