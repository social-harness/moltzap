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
  bindAdmittedPostIntent,
  bindCheckedPostIntent,
  bindIdentity,
  bindPostIntent,
  completeReanchor,
  lockGenesisProposal,
  lockProposal,
  putConversationFoundation,
  restartEmptyConversation,
  stageReanchor,
} from "./anchors.js";
import {
  finalizeCollectiveOperation,
  publishCollectiveItem,
  putCollectiveOperation,
  readCollectiveAnswers,
  readCollectiveOperations,
  readCollectivePosts,
  readCollectiveRefusals,
  recordCollectiveAnswer,
  recordCollectiveRefusal,
  retireCollectiveOperation,
} from "./collectives.js";
import {
  closeStoreState,
  EndpointStoreError,
  inspectStoreState,
  type MigrationSteps,
  openStoreState,
  runStoreOperation,
  type StoreOpening,
  type StoreState,
} from "./database/index.js";
import {
  admitFirewallItem,
  admitFirewallLocalItem,
  admitFirewallOperation,
  beginFirewallAttempt,
  queueFirewallItem,
  readFirewallActivations,
  readFirewallAuditPage,
  readFirewallDecisions,
  readFirewallEvidence,
  readFirewallEvidenceSlices,
  readFirewallFrontiers,
  readFirewallPolicy,
  readFirewallRequestAdmission,
  readPendingFirewallItems,
  retireFirewallItem,
  writeFirewallPolicy,
} from "./firewall.js";
import {
  acknowledgeInboxItem,
  completeWebhookDelivery,
  putInboxItem,
  readEventState,
  readInbox,
  readInboxItem,
  readInboxSummary,
  replaceInboxItem,
  writeEventState,
} from "./inbox.js";
import {
  acknowledgeDelivery,
  beginOutbound,
  completeOutbound,
  discardOutbound,
  enqueueDisseminationOutbound,
  enqueueOutbound,
  enqueueOutboundInTransaction,
  readPendingDeliveries,
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
 * Reports whether opening the state directory creates, reopens, or migrates
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
 * Opens the one SQLite store owned by a daemon state directory.
 *
 * @param stateDirectory Exclusive persistent state directory.
 * @param options Explicit live window and optional injected forward migration steps.
 * @param options.liveWireVersions Versions accepted for pending outbound envelopes.
 * @param options.migrations Destination-indexed forward steps, defaulting to the binary's table.
 * @returns A scoped private endpoint-store capability.
 * @failure EndpointStoreError when the directory or database cannot be owned.
 */
export const openEndpointStore = (
  stateDirectory: string,
  options: {
    readonly liveWireVersions: readonly string[];
    readonly migrations?: MigrationSteps;
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
  ).pipe(Effect.map(makeEndpointStore), Effect.withSpan("openEndpointStore"));

// eslint-disable-next-line max-lines-per-function, sonarjs/max-lines-per-function -- One typed capability literal detects duplicate operation keys and checks completeness.
function makeEndpointStore(state: StoreState): EndpointStore {
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
    readCollectiveOperations: () =>
      run(() => readCollectiveOperations(state.database)),
    readCollectivePosts: () => run(() => readCollectivePosts(state.database)),
    finalizeCollectiveOperation: (operationId, selection) =>
      run(() =>
        finalizeCollectiveOperation(state.database, operationId, selection),
      ),
    publishCollectiveItem: (delivery) =>
      run(() => {
        publishCollectiveItem(state.database, delivery);
      }),
    readIdentity: () => run(() => bindIdentity.read(state.database)),
    bindIdentity: (binding) =>
      run(() => bindIdentity.write(state.database, binding)),
    bindPostIntent: (binding) =>
      run(() => bindPostIntent(state.database, binding)),
    putConversationFoundation: (foundation) =>
      run(() => putConversationFoundation(state.database, foundation)),
    lockProposal: (proposal) =>
      run(() => lockProposal(state.database, proposal)),
    lockGenesisProposal: (foundation, proposal) =>
      run(() => lockGenesisProposal(state.database, foundation, proposal)),
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
    beginOutbound: (messageId) =>
      run(() => beginOutbound(state.database, messageId)),
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
    readInboxItem: (token) => run(() => readInboxItem(state.database, token)),
    completeWebhookDelivery: (token, value) =>
      run(() => {
        completeWebhookDelivery(state.database, token, value);
      }),
    putInboxItem: (item) => run(() => putInboxItem(state.database, item)),
    readInbox: (input) => run(() => readInbox(state.database, input)),
    readInboxSummary: () => run(() => readInboxSummary(state.database)),
    acknowledgeInboxItem: (token) =>
      run(() => {
        acknowledgeInboxItem(state.database, token);
      }),
    replaceInboxItem: (token, replacement, pendingConversation) =>
      run(() => {
        replaceInboxItem(
          state.database,
          token,
          replacement,
          pendingConversation === undefined
            ? undefined
            : () => {
                queueFirewallItem(state.database, {
                  ...replacement,
                  conversation: pendingConversation,
                });
              },
        );
      }),
    readEventState: () => run(() => readEventState(state.database)),
    writeEventState: (value) =>
      run(() => {
        writeEventState(state.database, value);
      }),
    queueFirewallItem: (item) =>
      run(() => {
        queueFirewallItem(state.database, item);
      }),
    readFirewallFrontiers: () =>
      run(() => readFirewallFrontiers(state.database)),
    readPendingFirewallItems: (after) =>
      run(() => readPendingFirewallItems(state.database, after)),
    readFirewallPolicy: () => run(() => readFirewallPolicy(state.database)),
    writeFirewallPolicy: (rules, activation) =>
      run(() => {
        writeFirewallPolicy(state.database, rules, activation);
      }),
    readFirewallActivations: (request) =>
      run(() => readFirewallActivations(state.database, request)),
    readFirewallDecisions: (since) =>
      run(() => readFirewallDecisions(state.database, since)),
    readFirewallAuditPage: (after) =>
      run(() => readFirewallAuditPage(state.database, after)),
    readFirewallEvidence: (input) =>
      run(() => readFirewallEvidence(state.database, input)),
    readFirewallEvidenceSlices: (input) =>
      run(() => readFirewallEvidenceSlices(state.database, input)),
    readFirewallRequestAdmission: (recordHash) =>
      run(() => readFirewallRequestAdmission(state.database, recordHash)),
    beginFirewallAttempt: (attempt) =>
      run(() => {
        beginFirewallAttempt(state.database, attempt);
      }),
    admitFirewallItem: (item, completion) =>
      run(() => admitFirewallItem(state.database, item, completion)),
    admitFirewallLocalItem: (admission) =>
      run(() => admitFirewallLocalItem(state.database, admission)),
    retireFirewallItem: (token) =>
      run(() => {
        retireFirewallItem(state.database, token);
      }),
    admitFirewallOperation: (completion, candidate, collective) =>
      run(() =>
        admitFirewallOperation(
          state.database,
          completion,
          candidate,
          collective,
        ),
      ),
    bindCheckedPostIntent: (binding, completion) =>
      run(() => bindCheckedPostIntent(state.database, binding, completion)),
    bindAdmittedPostIntent: (binding, operation) =>
      run(() => bindAdmittedPostIntent(state.database, binding, operation)),
  };
  return Object.freeze(store);
}
