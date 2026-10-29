/** @file An endpoint store whose every operation dies, for tests that override the few they use. */

import { Effect } from "effect";
import type { EndpointStore } from "../communication/store/index.js";

/**
 * A store whose every operation dies naming `label`, so a test spreads it and
 * overrides only the operations its subject should reach; any other call
 * fails the test with the label.
 * @param label The test that owns the store, named in the defect.
 * @returns A complete store with no usable operation.
 */
export function unusedEndpointStore(label: string): EndpointStore {
  const unused = () => Effect.dieMessage(`store operation outside ${label}`);
  return {
    ...unusedFirewallOperations(unused),
    readInboxItem: unused,
    completeWebhookDelivery: unused,
    putInboxItem: unused,
    readInbox: unused,
    readInboxSummary: unused,
    acknowledgeInboxItem: unused,
    replaceInboxItem: unused,
    readEventState: unused,
    writeEventState: unused,
    readIdentity: unused,
    bindIdentity: unused,
    ...unusedCollectiveOperations(unused),
    bindPostIntent: unused,
    putConversationFoundation: unused,
    lockProposal: unused,
    lockFirstMessageProposal: unused,
    supersedeProposalLock: unused,
    stageRecordForDissemination: unused,
    mergeEvidence: unused,
    promoteRecord: unused,
    applyCertifiedRecord: unused,
    stageReanchor: unused,
    completeReanchor: unused,
    applyCatchUpReanchor: unused,
    readPendingDeliveries: unused,
    readRetainedDeliveries: unused,
    acknowledgeDelivery: unused,
    enqueueOutbound: unused,
    enqueueDisseminationOutbound: unused,
    beginOutbound: unused,
    completeOutbound: unused,
    discardOutbound: unused,
    restartEmptyConversation: unused,
    searchConversations: unused,
    readConversation: unused,
    releaseContinuation: unused,
    recover: unused,
  };
}

function unusedFirewallOperations(unused: () => Effect.Effect<never>) {
  return {
    queueFirewallItem: unused,
    readFirewallFrontiers: unused,
    readPendingFirewallItems: unused,
    readFirewallAuditPage: unused,
    readFirewallPolicy: unused,
    writeFirewallPolicy: unused,
    readFirewallDecisions: unused,
    readFirewallActivations: unused,
    readFirewallEvidence: unused,
    readFirewallEvidenceSlices: unused,
    readFirewallRequestAdmission: unused,
    beginFirewallAttempt: unused,
    admitFirewallItem: unused,
    admitFirewallLocalItem: unused,
    retireFirewallItem: unused,
    admitFirewallOperation: unused,
    bindCheckedPostIntent: unused,
    bindAdmittedPostIntent: unused,
  };
}

function unusedCollectiveOperations(unused: () => Effect.Effect<never>) {
  return {
    recordCollectiveAnswer: unused,
    readCollectiveAnswers: unused,
    recordCollectiveRefusal: unused,
    readCollectiveRefusals: unused,
    retireCollectiveOperation: unused,
    putCollectiveOperation: unused,
    readCollectiveOperations: unused,
    readCollectiveOperation: unused,
    readCollectivePosts: unused,
    finalizeCollectiveOperation: unused,
    publishCollectiveItem: unused,
  };
}
