/** @file The daemon-owned admission worker: checks each conversation's queued frontier outside the delivery pass and commits its disposition. */

import {
  Cause,
  Clock,
  Deferred,
  Effect,
  Option,
  Queue,
  type Scope,
} from "effect";
import type { CollectiveOperations } from "../../communication/collectives/index.js";
import type { FirewallEnvironment } from "./firewall-checks.js";
import {
  type InboundItem,
  retainedInboundItem,
} from "../../communication/collectives/inbound.js";
import { untilFresh } from "../../communication/conversations/index.js";
import {
  decodeRuntimeValue,
  type DeliveryToken,
  encodeRuntimeValue,
  type EndpointStore,
  type EndpointStoreError,
  type FirewallInboxEntry,
} from "../../communication/store/index.js";
import { checkLocalItem } from "./firewall-results.js";
import { checkIncoming } from "./firewall.js";

/** What the admission worker reads and changes in one service's delivery. */
export interface AdmissionContext {
  readonly store: EndpointStore;
  /**
   * Make a committed disposition current in delivery: an admitted item joins
   * the local items, a withheld one is forgotten.
   */
  readonly showDisposition: (
    deliveryToken: DeliveryToken,
    item: InboundItem,
    disposition: "admitted" | "withheld",
  ) => Effect.Effect<void>;
  /** The active collective layer, absent while the service is unregistered. */
  readonly collectives: () =>
    | Pick<CollectiveOperations, "settleRequest">
    | undefined;
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
        environment.installed.configuration.maximumConcurrentChecks
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
 * Check one queued item and commit its disposition, rechecking once on stale
 * evidence. A message or request is checked as its certified record; a
 * result or failure as the local item it is. A request whose deadline has
 * passed is never presented: one past it before its check retires without
 * one, and one past it once checked commits withheld. Either way the
 * collective layer learns whether the runtime was shown it.
 */
function admitItem(
  input: AdmissionContext,
  environment: FirewallEnvironment,
  entry: FirewallInboxEntry,
) {
  return Effect.gen(function* () {
    const item = yield* decodeRuntimeValue(
      retainedInboundItem,
      entry.canonicalItem,
    );
    switch (item.kind) {
      case "multicast":
        return yield* admitRecordItem(input, environment, entry, item);
      case "collectiveRequest": {
        if ((yield* Clock.currentTimeMillis) >= item.deadlineAt) {
          yield* input.store.retireFirewallItem(entry.deliveryToken);
          return yield* publishDisposition(input, entry, item, "withheld");
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
  return untilFresh((terminal) =>
    Effect.gen(function* () {
      const checked = yield* checkIncoming(environment, entry, terminal);
      const expired =
        item.kind === "collectiveRequest" &&
        (yield* Clock.currentTimeMillis) >= item.deadlineAt;
      return yield* input.store.admitFirewallItem(
        {
          deliveryToken: entry.deliveryToken,
          canonicalItem: entry.canonicalItem,
          ...(checked.guidance === undefined || expired
            ? {}
            : {
                canonicalGuidance: yield* encodeRuntimeValue(checked.guidance),
              }),
        },
        expired ? { ...checked.completion, admit: false } : checked.completion,
      );
    }),
  ).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.void,
        onSome: (disposition) =>
          publishDisposition(input, entry, item, disposition),
      }),
    ),
  );
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
  return untilFresh((terminal) =>
    checkLocalItem(environment, { entry, item, terminal }).pipe(
      Effect.flatMap((admission) =>
        input.store
          .admitFirewallLocalItem(admission)
          .pipe(
            Effect.map((disposition) =>
              disposition === "stale"
                ? disposition
                : { disposition, shown: admission.item.canonicalItem },
            ),
          ),
      ),
    ),
  ).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.void,
        onSome: ({ disposition, shown }) =>
          decodeRuntimeValue(retainedInboundItem, shown).pipe(
            Effect.flatMap((projected) =>
              publishDisposition(input, entry, projected, disposition),
            ),
          ),
      }),
    ),
  );
}

/** Settle a request's admission in the collective layer, then show the disposition. */
function publishDisposition(
  input: AdmissionContext,
  entry: FirewallInboxEntry,
  item: InboundItem,
  disposition: "admitted" | "withheld",
) {
  return Effect.gen(function* () {
    if (item.kind === "collectiveRequest") {
      yield* (
        input
          .collectives()
          ?.settleRequest(item.id, disposition === "admitted") ?? Effect.void
      );
    }
    yield* input.showDisposition(entry.deliveryToken, item, disposition);
  });
}
