/**
 * @file Atomic persistence for one daemon. The store owns byte bindings,
 * transaction boundaries, and durable ordering; callers verify signatures
 * and interpret protocol and runtime values before storing them.
 */

import { Effect, type Scope } from "effect";

import type { OutboxTooOldError } from "./database/values.js";
import type { EndpointStore } from "./types.js";

import {
  applyCatchUpReanchor,
  bindIdentity,
  bindMessageIntent,
  completeReanchor,
  lockFirstMessageProposal,
  lockProposal,
  putConversationFoundation,
  restartEmptyConversation,
  stageReanchor,
} from "./anchors.js";
import {
  finalizeCollectiveOperation,
  putCollectiveOperation,
  readCollectiveAnswers,
  readCollectiveMessages,
  readCollectiveOperation,
  readCollectiveOperations,
  readCollectiveRefusals,
  recordCollectiveAnswer,
  recordCollectiveRefusal,
  retireCollectiveOperation,
} from "./collectives.js";
import {
  closeStoreState,
  createCommunicationTables,
  EndpointStoreError,
  inspectStoreState,
  openStoreState,
  runStoreOperation,
  type StoreOpening,
  type StoreState,
  transaction,
} from "./database/index.js";
import {
  acknowledgeDelivery,
  beginOutbound,
  completeOutbound,
  discardOutbound,
  enqueueDisseminationOutbound,
  enqueueOutbound,
  enqueueOutboundInTransaction,
  readPendingDeliveries,
  readRetainedDeliveries,
} from "./queues/index.js";
import {
  readStoredConversation,
  recoverStoredState,
  releaseStoredContinuation,
  searchStoredConversations,
} from "./reads.js";
import {
  applyCertifiedRecord,
  mergeEvidence,
  promoteRecord,
  stageRecordForDissemination,
  supersedeProposalLock,
} from "./records.js";

/** Closed endpoint-store failures without SQLite implementation details. */
export { EndpointStoreError };

/**
 * Reports whether opening the state directory creates or reopens
 * its store without changing it. Creating a store leaves the daemon
 * unregistered.
 *
 * @param stateDirectory Exclusive persistent state directory.
 * @returns How `openEndpointStore` will open the store.
 * @failure EndpointStoreError when the database is incompatible or corrupt.
 */
export const inspectEndpointStore = (
  stateDirectory: string,
): Effect.Effect<StoreOpening, EndpointStoreError> =>
  inspectStoreState(stateDirectory).pipe(
    Effect.withSpan("inspectEndpointStore"),
  );

/**
 * Opens protocol-only persistence for a standalone communication engine.
 * Daemon hosts acquire all store owners through `openDaemonStore`.
 *
 * @param stateDirectory Exclusive persistent state directory.
 * @param options Explicit live window for retained outbound messages.
 * @param options.liveWireVersions Versions accepted for pending outbound envelopes.
 * @returns A scoped private endpoint-store capability.
 * @failure EndpointStoreError when the directory or database cannot be owned.
 */
export const openEndpointStore = (
  stateDirectory: string,
  options: {
    readonly liveWireVersions: readonly string[];
  },
): Effect.Effect<
  EndpointStore,
  EndpointStoreError | OutboxTooOldError,
  Scope.Scope
> =>
  // eslint-disable-next-line agent-code-guard/acquire-release-requires-scope -- The returned Scope requirement binds SQLite ownership to daemon acquisition.
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
            },
            "EXCLUSIVE",
          );
        }
        return makeEndpointStore(state);
      }),
    ),
    Effect.withSpan("openEndpointStore"),
  );

/** Protocol operations share the connection acquired by their process composition. */
// eslint-disable-next-line max-lines-per-function, sonarjs/max-lines-per-function -- One typed capability literal checks the complete protocol operation map.
export function makeEndpointStore(state: StoreState): EndpointStore {
  const run = <Value>(operation: () => Value) =>
    runStoreOperation(state, operation);
  const store: EndpointStore = {
    recordCollectiveAnswer: (answer) =>
      run(() => recordCollectiveAnswer(state.database, answer)),
    readCollectiveAnswers: () =>
      run(() => readCollectiveAnswers(state.database)),
    recordCollectiveRefusal: (refusal) =>
      run(() => {
        recordCollectiveRefusal(state.database, refusal);
      }),
    readCollectiveRefusals: () =>
      run(() => readCollectiveRefusals(state.database)),
    retireCollectiveOperation: (operationId, selection) =>
      run(() => {
        retireCollectiveOperation(state.database, operationId, selection);
      }),
    putCollectiveOperation: (input) =>
      run(() => putCollectiveOperation(state.database, input)),
    readCollectiveOperation: (id) =>
      run(() => readCollectiveOperation(state.database, id)),
    readCollectiveOperations: () =>
      run(() => readCollectiveOperations(state.database)),
    readCollectiveMessages: (query) =>
      run(() => readCollectiveMessages(state.database, query)),
    finalizeCollectiveOperation: (operationId, selection) =>
      run(() =>
        finalizeCollectiveOperation(state.database, operationId, selection),
      ),
    readIdentity: () => run(() => bindIdentity.read(state.database)),
    bindIdentity: (binding) =>
      run(() => bindIdentity.write(state.database, binding)),
    bindMessageIntent: (binding) =>
      run(() => bindMessageIntent(state.database, binding)),
    putConversationFoundation: (foundation) =>
      run(() => putConversationFoundation(state.database, foundation)),
    lockProposal: (proposal) =>
      run(() => lockProposal(state.database, proposal)),
    lockFirstMessageProposal: (foundation, proposal) =>
      run(() => lockFirstMessageProposal(state.database, foundation, proposal)),
    supersedeProposalLock: (lock, certificate) =>
      run(() => supersedeProposalLock(state.database, lock, certificate)),
    stageRecordForDissemination: (record) =>
      run(() => stageRecordForDissemination(state.database, record)),
    mergeEvidence: (evidence) =>
      run(() => mergeEvidence(state.database, evidence)),
    promoteRecord: (record, delivery) =>
      run(() => promoteRecord(state.database, record, delivery)),
    applyCertifiedRecord: (record, delivery) =>
      run(() => applyCertifiedRecord(state.database, record, delivery)),
    stageReanchor: (reanchor) =>
      run(() => stageReanchor(state.database, reanchor)),
    completeReanchor: (reanchor) =>
      run(() => completeReanchor(state.database, reanchor)),
    applyCatchUpReanchor: (reanchor) =>
      run(() => applyCatchUpReanchor(state.database, reanchor)),
    readRetainedDeliveries: () =>
      run(() => readRetainedDeliveries(state.database)),
    readPendingDeliveries: () =>
      run(() => readPendingDeliveries(state.database)),
    acknowledgeDelivery: (deliveryToken) =>
      run(() => acknowledgeDelivery(state.database, deliveryToken)),
    enqueueOutbound: (message) =>
      run(() => enqueueOutbound(state.database, message)),
    enqueueDisseminationOutbound: (obligation, message) =>
      run(() =>
        enqueueDisseminationOutbound(
          state.database,
          obligation,
          message,
          enqueueOutboundInTransaction,
        ),
      ),
    beginOutbound: (envelopeId) =>
      run(() => beginOutbound(state.database, envelopeId)),
    completeOutbound: (outbound) =>
      run(() => completeOutbound(state.database, outbound)),
    discardOutbound: (outbounds) =>
      run(() => discardOutbound(state.database, outbounds)),
    restartEmptyConversation: (restart) =>
      run(() => restartEmptyConversation(state.database, restart)),
    searchConversations: (input = {}) =>
      run(() => searchStoredConversations(state.database, input)),
    readConversation: (request) =>
      run(() => readStoredConversation(state, request)),
    releaseContinuation: (continuation) =>
      run(() => {
        releaseStoredContinuation(state, continuation);
      }),
    recover: (conversationId) =>
      run(() => recoverStoredState(state.database, conversationId)),
  };
  return Object.freeze(store);
}
