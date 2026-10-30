/** @file Checks queued incoming items and records whether the host may receive them. */

import { Cause, Clock, Deferred, Effect, Queue, type Scope } from "effect";
import type {
  FirewallInboxEntry,
  FirewallStore,
} from "../../firewall/store/index.js";
import type { FirewallEnvironment } from "./message.js";
import {
  decodeRuntimeValue,
  type DeliveryToken,
  encodeRuntimeValue,
  type EndpointStoreError,
} from "../../communication/store/index.js";
import { InboundItem } from "../../host-protocol/items.js";
import { prepareIncomingCheck } from "./message.js";
import { checkLocalItem } from "./local-results.js";

/** What the admission worker reads and changes in one service's delivery. */
export interface AdmissionContext {
  readonly store: FirewallStore;
  /**
   * Make a committed disposition current in delivery: an admitted item joins
   * the local items, a withheld one is forgotten.
   */
  readonly showDisposition: (
    deliveryToken: DeliveryToken,
    item: InboundItem,
    disposition: "admitted" | "withheld",
  ) => Effect.Effect<void>;
  /** Local attribution becomes available after the daemon activates. */

  readonly firewallEnvironment?: () => FirewallEnvironment | undefined;
  /** Service lifetime; each conversation's check runs as a fiber in it. */
  readonly scope: Scope.Scope;
  /** Offered after each pass and each finished check. */
  readonly admissionWake: Queue.Queue<undefined>;
  /** Completed by the first check that fails other than by interruption. */
  readonly admissionFailure: Deferred.Deferred<never, EndpointStoreError>;
  /** Conversations with a check in flight; at most one each. */
  readonly activeConversations: Set<string>;
}

/**
 * Run the worker until the service scope closes or a check fails: on each
 * wake, start a check for every queued frontier whose conversation is idle,
 * up to the firewall's concurrency bound, and publish after each commit.
 * @param input The service's store, collective layer and worker bookkeeping.
 * @param publish Runs after each committed disposition, so subscribers see it.
 * @returns Never succeeds; fails with the first store error a check returns.
 */
export function runAdmission(
  input: AdmissionContext,
  publish: Effect.Effect<void>,
): Effect.Effect<never, EndpointStoreError> {
  return Queue.take(input.admissionWake).pipe(
    Effect.zipRight(drainAdmission(input, publish)),
    Effect.forever,
    Effect.raceFirst(Deferred.await(input.admissionFailure)),
  );
}
function drainAdmission(input: AdmissionContext, publish: Effect.Effect<void>) {
  return Effect.gen(function* () {
    const environment = input.firewallEnvironment?.();
    if (environment === undefined) {
      return;
    }
    const entries = yield* input.store.readFirewallFrontiers();
    for (const entry of entries) {
      if (
        input.activeConversations.size >=
        environment.firewall.configuration.maximumConcurrentChecks
      ) {
        return;
      }
      if (input.activeConversations.has(entry.conversation)) {
        continue;
      }
      input.activeConversations.add(entry.conversation);
      yield* admitItem(input, environment, entry).pipe(
        Effect.zipRight(publish),
        Effect.catchAllCause((cause) =>
          Cause.isInterruptedOnly(cause)
            ? Effect.failCause(cause)
            : Deferred.failCause(input.admissionFailure, cause),
        ),
        Effect.ensuring(
          Effect.sync(() =>
            input.activeConversations.delete(entry.conversation),
          ).pipe(Effect.zipRight(Queue.offer(input.admissionWake, undefined))),
        ),
        Effect.forkIn(input.scope),
      );
    }
  });
}

/**
 * Check one queued item against one captured context and retain its disposition.
 * A request that expires before assessment retires without checking; expiry
 * during assessment withholds host presentation while preserving its result.
 */
function admitItem(
  input: AdmissionContext,
  environment: FirewallEnvironment,
  entry: FirewallInboxEntry,
) {
  return Effect.gen(function* () {
    const item = yield* decodeRuntimeValue(InboundItem, entry.canonicalItem);
    switch (item.kind) {
      case "multicast":
        return yield* admitRecordItem(input, environment, entry, item);
      case "collectiveRequest": {
        if ((yield* Clock.currentTimeMillis) >= item.deadlineAt) {
          yield* input.store.retireFirewallItem(entry.deliveryToken);
          return yield* input.showDisposition(
            entry.deliveryToken,
            item,
            "withheld",
          );
        }
        return yield* admitRecordItem(input, environment, entry, item);
      }
      case "collectiveResult":
      case "operationFailed":
        return yield* admitLocalItem(input, environment, entry, item);
      default: {
        const exhaustive: never = item;
        return exhaustive;
      }
    }
  });
}

function admitRecordItem(
  input: AdmissionContext,
  environment: FirewallEnvironment,
  entry: FirewallInboxEntry,
  item: Extract<
    InboundItem,
    { readonly kind: "multicast" | "collectiveRequest" }
  >,
) {
  return Effect.gen(function* () {
    const checked = yield* prepareIncomingCheck(environment, entry).pipe(
      Effect.flatMap((prepared) => environment.firewall.check(prepared)),
    );
    const expired =
      item.kind === "collectiveRequest" &&
      (yield* Clock.currentTimeMillis) >= item.deadlineAt;
    const disposition = yield* input.store.admitFirewallItem(
      {
        deliveryToken: entry.deliveryToken,
        canonicalItem: entry.canonicalItem,
        ...(checked.guidance === undefined || expired
          ? {}
          : { canonicalGuidance: yield* encodeRuntimeValue(checked.guidance) }),
      },
      expired ? { ...checked.completion, admit: false } : checked.completion,
    );
    yield* input.showDisposition(entry.deliveryToken, item, disposition);
  });
}

function admitLocalItem(
  input: AdmissionContext,
  environment: FirewallEnvironment,
  entry: FirewallInboxEntry,
  item: Extract<
    InboundItem,
    { readonly kind: "collectiveResult" | "operationFailed" }
  >,
) {
  return checkLocalItem(environment, { entry, item }).pipe(
    Effect.flatMap((admission) =>
      input.store
        .admitFirewallLocalItem(admission)
        .pipe(
          Effect.flatMap((disposition) =>
            decodeRuntimeValue(InboundItem, admission.item.canonicalItem).pipe(
              Effect.flatMap((projected) =>
                input.showDisposition(
                  entry.deliveryToken,
                  projected,
                  disposition,
                ),
              ),
            ),
          ),
        ),
    ),
  );
}
