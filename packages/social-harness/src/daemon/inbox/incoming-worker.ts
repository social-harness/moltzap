/** @file Checks queued incoming items and records whether the host may receive them. */

import * as SqlClient from "@effect/sql/SqlClient";
import { Cause, Clock, Deferred, Effect, Queue, type Scope } from "effect";
import type { FirewallInboxEntry } from "../../firewall/store/index.js";
import {
  decodeRuntimeValue,
  type DeliveryToken,
  encodeRuntimeValue,
  EndpointStoreError,
} from "../../communication/store/index.js";
import { InboundItem } from "../../host-protocol/items.js";
import { readNextPendingMessages } from "../../firewall/store/index.js";
import {
  retireFirewallItem,
  saveMessageDecision,
  saveResultDecision,
} from "../store.js";
import { checkLocalItem } from "./local-results.js";
import {
  type FirewallEnvironment,
  prepareIncomingCheck,
} from "./firewall-context.js";

/** What the admission worker reads and changes in one service's delivery. */
export interface AdmissionContext {
  readonly sql: SqlClient.SqlClient;
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
 * wake, start the next pending check in each idle conversation,
 * up to the firewall's concurrency bound, and publish after each commit.
 * @param input The service's SQL client, local attribution and worker bookkeeping.
 * @param publish Runs after each committed disposition, so subscribers see it.
 * @returns Never succeeds; fails with the first store error a check returns.
 */
export function runAdmission(
  input: AdmissionContext,
  publish: Effect.Effect<void>,
): Effect.Effect<never, EndpointStoreError> {
  return Queue.take(input.admissionWake).pipe(
    Effect.zipRight(checkPendingMessages(input, publish)),
    Effect.forever,
    Effect.raceFirst(Deferred.await(input.admissionFailure)),
    Effect.provideService(SqlClient.SqlClient, input.sql),
  );
}
function checkPendingMessages(
  input: AdmissionContext,
  publish: Effect.Effect<void>,
) {
  return Effect.gen(function* () {
    const environment = input.firewallEnvironment?.();
    if (environment === undefined) {
      return;
    }
    const entries = yield* readNextPendingMessages();
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
      yield* checkPendingMessage(input, environment, entry).pipe(
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
function checkPendingMessage(
  input: AdmissionContext,
  environment: FirewallEnvironment,
  entry: FirewallInboxEntry,
) {
  return Effect.gen(function* () {
    const item = yield* decodeRuntimeValue(InboundItem, entry.canonicalItem);
    switch (item.kind) {
      case "multicast":
        return yield* checkMessage(input, environment, entry, item);
      case "collectiveRequest": {
        if ((yield* Clock.currentTimeMillis) >= item.deadlineAt) {
          yield* retireFirewallItem(entry.deliveryToken);
          return yield* input.showDisposition(
            entry.deliveryToken,
            item,
            "withheld",
          );
        }
        return yield* checkMessage(input, environment, entry, item);
      }
      case "collectiveResult":
      case "operationFailed":
        return yield* checkResult(input, environment, entry, item);
      default: {
        const exhaustive: never = item;
        return exhaustive;
      }
    }
  });
}

function checkMessage(
  input: AdmissionContext,
  environment: FirewallEnvironment,
  entry: FirewallInboxEntry,
  item: Extract<
    InboundItem,
    { readonly kind: "multicast" | "collectiveRequest" }
  >,
) {
  return Effect.gen(function* () {
    const prepared = yield* prepareIncomingCheck(environment, entry);
    const [checked] = yield* environment.firewall.check([prepared]);
    if (checked === undefined) {
      return yield* new EndpointStoreError({ reason: "corrupt" });
    }
    const expired =
      item.kind === "collectiveRequest" &&
      (yield* Clock.currentTimeMillis) >= item.deadlineAt;
    const disposition = yield* saveMessageDecision(
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

function checkResult(
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
      saveResultDecision(admission).pipe(
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
