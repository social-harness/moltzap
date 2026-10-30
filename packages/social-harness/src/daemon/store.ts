/** @file Composes protocol, policy and host persistence over one scoped database. */

import { Effect, type Scope } from "effect";

import type { OutboxTooOldError } from "../communication/store/database/values.js";
import type {
  DeliveryToken,
  EndpointStore,
} from "../communication/store/types.js";

import { completeCollectiveDelivery } from "../communication/store/collectives.js";
import {
  closeStoreState,
  createCommunicationTables,
  type EndpointStoreError,
  openStoreState,
  requireSameBytes,
  runStoreOperation,
  StoreSignal,
  type StoreState,
  transaction,
} from "../communication/store/database/index.js";
import { retirePendingDelivery } from "../communication/store/queues/peer-deliveries.js";
import { makeEndpointStore } from "../communication/store/store.js";
import {
  completeFirewallAttempt,
  queueFirewallItem,
  requireQueueFrontier,
  retireQueuedItem,
  settleLocalItem,
  settleQueuedItem,
} from "../firewall/store/firewall.js";
import {
  type FirewallStore,
  type ItemProjection,
  makeFirewallStore,
} from "../firewall/store/index.js";
import {
  createFirewallTables,
  interruptFirewallAttempts,
} from "../firewall/store/schema.js";
import {
  readFirewallEvidence,
  readFirewallEvidenceSlices,
  readFirewallRequestAdmission,
} from "./inbox/evidence.js";
import {
  createInboxTables,
  type InboxStore,
  makeInboxStore,
  putInboxItem,
  readInboxItem,
  retireItem,
} from "./inbox/store.js";

/** The terminal payload and protocol custody settle with its local publication. */
export interface CollectiveDelivery {
  readonly operationId: string;
  readonly deliveryToken: DeliveryToken;
  readonly canonicalItem: Uint8Array;
  readonly conversation: string;
  readonly canonicalProvenance?: Uint8Array;
  readonly firewall: boolean;
}

/** Only daemon composition combines these owners and their cross-owner transactions. */
export interface DaemonStore extends EndpointStore, FirewallStore, InboxStore {
  readonly publishCollectiveItem: (
    delivery: CollectiveDelivery,
  ) => Effect.Effect<void, EndpointStoreError>;
  readonly replaceInboxItem: (
    token: DeliveryToken,
    replacement: ItemProjection,
    pendingConversation?: string,
  ) => Effect.Effect<void, EndpointStoreError>;
}

/** Acquisition registers the existing SQLite finalizer before initializing any owner. */
export const openDaemonStore = (
  stateDirectory: string,
  options: { readonly liveWireVersions: readonly string[] },
): Effect.Effect<
  DaemonStore,
  EndpointStoreError | OutboxTooOldError,
  Scope.Scope
> =>
  // eslint-disable-next-line agent-code-guard/acquire-release-requires-scope -- The daemon store retains the shared connection for its caller's scope.
  Effect.acquireRelease(
    openStoreState(stateDirectory, options),
    closeStoreState,
  ).pipe(
    Effect.flatMap((state) =>
      runStoreOperation(state, () => {
        if (state.opening === "create") {
          transaction(
            state.database,
            () => {
              createCommunicationTables(state.database);
              createInboxTables(state.database);
              createFirewallTables(state.database);
            },
            "EXCLUSIVE",
          );
        }
        interruptFirewallAttempts(state.database);
        return makeDaemonStore(state);
      }),
    ),
    Effect.withSpan("openDaemonStore"),
  );

/** The capability literal checks that every declared owner operation has one implementation. */
function makeDaemonStore(state: StoreState): DaemonStore {
  const run = <A>(operation: () => A) => runStoreOperation(state, operation);
  const firewall = makeFirewallStore(state, {
    queueFirewallItem: (item) =>
      run(() => {
        queueItem(state, item);
      }),
    readFirewallEvidence: (input) =>
      run(() => readFirewallEvidence(state.database, input)),
    readFirewallEvidenceSlices: (input) =>
      run(() => readFirewallEvidenceSlices(state.database, input)),
    readFirewallRequestAdmission: (record) =>
      run(() => readFirewallRequestAdmission(state.database, record)),
    admitFirewallItem: (item, completion) =>
      run(() => admitItem(state, item, completion)),
    admitFirewallLocalItem: (admission) =>
      run(() =>
        transaction(state.database, () => {
          settleLocalItem(state.database, admission);
          putInboxItem(state.database, admission.item);
          return "admitted" as const;
        }),
      ),
    retireFirewallItem: (token) =>
      run(() => {
        retireFirewallItem(state, token);
      }),
  });
  return Object.freeze({
    ...makeEndpointStore(state),
    ...makeInboxStore(state),
    ...firewall,
    publishCollectiveItem: (delivery) =>
      run(() => {
        publishCollectiveItem(state, delivery);
      }),
    replaceInboxItem: (token, replacement, conversation) =>
      run(() => {
        replaceInboxItem(state, token, replacement, conversation);
      }),
  } satisfies DaemonStore);
}

/** Terminal ownership and host publication share a transaction without changing C2's authority. */
function publishCollectiveItem(
  state: StoreState,
  delivery: CollectiveDelivery,
): void {
  transaction(state.database, () => {
    completeCollectiveDelivery(
      state.database,
      delivery.operationId,
      delivery.deliveryToken,
    );
    if (delivery.firewall) {
      queueItem(state, delivery);
    } else {
      putInboxItem(state.database, delivery);
    }
  });
}

/** One incoming decision and its immutable host projection become visible together. */
function admitItem(
  state: StoreState,
  item: ItemProjection,
  completion: Parameters<FirewallStore["admitFirewallItem"]>[1],
) {
  return transaction(state.database, () => {
    requireQueueFrontier(
      state.database,
      item.deliveryToken,
      item.canonicalItem,
    );
    const disposition = completeFirewallAttempt(
      state.database,
      completion,
      "incoming",
      item.canonicalItem,
    );
    if (disposition === "admitted") {
      putInboxItem(state.database, item);
    } else {
      retirePendingDelivery(state.database, item.deliveryToken);
    }
    settleQueuedItem(
      state.database,
      item.deliveryToken,
      disposition,
      completion.checkId,
    );
    return disposition;
  });
}

/** An expired request cannot re-enter host delivery, while its protocol context remains. */
function retireFirewallItem(state: StoreState, token: DeliveryToken): void {
  transaction(state.database, () => {
    retireQueuedItem(state.database, token);
    retirePendingDelivery(state.database, token);
  });
}

/** Replacement retains the original immutable binding and stages only the new identity. */
function replaceInboxItem(
  state: StoreState,
  token: DeliveryToken,
  replacement: ItemProjection,
  pendingConversation?: string,
): void {
  if (token === replacement.deliveryToken) {
    throw new StoreSignal("conflict");
  }
  transaction(state.database, () => {
    retireItem(state.database, token);
    if (pendingConversation === undefined) {
      putInboxItem(state.database, replacement);
    } else {
      queueItem(state, { ...replacement, conversation: pendingConversation });
    }
  });
}

/** A retained host view wins over any later attempt to queue the same item. */
function queueItem(
  state: StoreState,
  item: Parameters<FirewallStore["queueFirewallItem"]>[0],
): void {
  const presented = readInboxItem(state.database, item.deliveryToken);
  if (presented !== undefined) {
    requireSameBytes(presented.canonicalItem, item.canonicalItem);
    return;
  }
  queueFirewallItem(state.database, item);
}
