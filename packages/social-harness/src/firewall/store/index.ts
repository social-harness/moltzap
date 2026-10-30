/** @file Local policy persistence requirements and the policy-owned SQLite operations. */

import type { FirewallStore } from "./types.js";

import {
  runStoreOperation,
  type StoreState,
} from "../../communication/store/database/index.js";
import {
  beginFirewallAttempt,
  completeFirewallAttempt,
  readFirewallActivations,
  readFirewallDecisions,
  readFirewallFrontiers,
  readFirewallPolicy,
  readPendingFirewallItems,
  writeFirewallPolicy,
} from "./firewall.js";

/** Captured inputs and retained decisions remain independent of protocol acceptance. */
export type {
  FirewallActivation,
  FirewallAuditEntry,
  FirewallCommit,
  FirewallCompletion,
  FirewallEvidence,
  FirewallEvidenceSlices,
  FirewallHistoryEntry,
  FirewallInboxEntry,
  FirewallLocalAdmission,
  FirewallLocalEntry,
  FirewallRequestAdmission,
  FirewallStore,
  ItemProjection,
} from "./types.js";

/** Composition implements reads and settlements that span protocol or host state. */
export type FirewallComposition = Pick<
  FirewallStore,
  | "queueFirewallItem"
  | "readFirewallEvidence"
  | "readFirewallEvidenceSlices"
  | "readFirewallRequestAdmission"
  | "admitFirewallItem"
  | "admitFirewallLocalItem"
  | "retireFirewallItem"
>;

/** Policy operations use the process's existing connection and fault lifetime. */
export function makeFirewallStore(
  state: StoreState,
  composition: FirewallComposition,
): FirewallStore {
  const run = <A>(operation: () => A) => runStoreOperation(state, operation);
  return Object.freeze({
    ...composition,
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
    beginFirewallAttempt: (attempt) =>
      run(() => {
        beginFirewallAttempt(state.database, attempt);
      }),
    completeFirewallAttempt: (completion, direction, candidate) =>
      run(() =>
        completeFirewallAttempt(
          state.database,
          completion,
          direction,
          candidate,
        ),
      ),
  } satisfies FirewallStore);
}

/** Owner queries decode retained inputs without exposing message content or provider traces. */
export {
  decodeFirewallAuditEntry,
  readDecisions,
  withoutTraces,
} from "./firewall.js";
