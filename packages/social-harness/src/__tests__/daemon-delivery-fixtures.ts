/** @file Daemon delivery tests use real conversation state and configurable message checks. */
import { SqlClient } from "@effect/sql";
import { Effect, Queue, Schema, Scope, Stream } from "effect";

import type { MessageMiddleware, MiddlewareResult } from "../firewall/check.js";
import type { InboundItem } from "../host-protocol/items.js";
import type { HarnessMessageReadyEvent } from "../host-protocol/operations.js";

import { InboundMessage } from "../communication/conversations/message.js";
import { AgentAddress, RecordHash } from "../communication/records/index.js";
import { decodeRuntimeValue } from "../communication/store/index.js";
import { makeHostDelivery } from "../daemon/inbox/host-delivery.js";
import { noHistoryExport } from "../daemon/inbox/host-traffic-log.js";
import {
  type Firewall,
  type FirewallOptions,
  makeFirewall,
} from "../firewall/index.js";
import { decodeFirewallAuditEntry } from "../firewall/store/index.js";
import { agentViewOf } from "../identity/cards.js";
import { makeCollectiveOperations } from "./collective-send.js";
import { type Fixture, seedIncoming } from "./conversation-fixtures.js";

/** A communication norm shares its guidance and repair text across traces. */
export const rule = {
  id: "communication",
  guidance: "Answer the open scheduling question.",
  feedback: {
    nextAction: "revise",
    text: "Include all required participants.",
  },
} as const;

/** A complete policy permits admission without advice. */
export const pass: MiddlewareResult = {
  findings: [{ ruleId: rule.id, outcome: "pass" }],
  expectations: [],
};

/** A semantic rejection with no response obligation. */
export const block: MiddlewareResult = {
  findings: [{ ruleId: rule.id, outcome: "violation" }],
  expectations: [],
};

/** Budgets leave room for real storage and scheduling on loaded test hosts. */
export const settings = {
  timeoutMilliseconds: 10_000,
  middlewareTimeoutMilliseconds: 8_000,
  maximumInputBytes: 1_000_000,
  maximumResultBytes: 100_000,
};

/** Bob is the peer of the default direct conversation. */
export const destination = Schema.decodeUnknownSync(AgentAddress)("agent:bob");

/** Read completed checks in insertion order through the production store read. */
export const auditChecks = (subject: Fixture) =>
  Effect.gen(function* () {
    const entries = yield* subject.store.readFirewallDecisions();
    return yield* Effect.forEach(
      [...entries].sort((left, right) => left.sequence - right.sequence),
      (entry) => decodeFirewallAuditEntry(entry),
      { concurrency: 1 },
    );
  }).pipe(
    Effect.provideService(SqlClient.SqlClient, subject.sql),
    Effect.withSpan("auditChecks"),
  );

/** Fixed registration and settings are captured before delivery operations run. */
const makeTestFirewall = (
  sql: SqlClient.SqlClient,
  middleware: MessageMiddleware,
  overrides: Partial<FirewallOptions> = {},
) =>
  makeFirewall({
    incoming: [middleware],
    outgoing: [middleware],
    settings,
    facts: [],
    codeDigest: "a".repeat(64),
    mode: "enforcement",
    ...overrides,
  }).pipe(Effect.provideService(SqlClient.SqlClient, sql));

/**
 * One collective layer with the firewall's admission ports and the delivery
 * built over it, as the daemon composes them. Requests the layer classifies
 * wait for admission; items it emits are queued privately and recorded.
 */
const makeDelivery = (subject: Fixture, firewall: Firewall) =>
  Effect.gen(function* () {
    const { local, engine } = subject;
    const environment = {
      firewall,
      sql: subject.sql,
      localAgentCard: local.card,
    };
    const scope = yield* Scope.Scope;
    const emitted: InboundItem[] = [];
    const slot: {
      delivery?: Effect.Effect.Success<ReturnType<typeof makeHostDelivery>>;
    } = {};
    const emit: Parameters<typeof makeCollectiveOperations>[0]["emit"] = (
      item,
      provenance,
      terminal,
    ) =>
      Effect.suspend(() => {
        emitted.push(item);
        return slot.delivery === undefined
          ? Effect.void
          : slot.delivery
              .queueLocalItem(item, provenance, terminal)
              .pipe(Effect.orDie);
      });
    const collectives = yield* makeCollectiveOperations({
      observeMessage: (msgId) => engine.observeMessage(msgId),
      prepareMessage: (input) => engine.prepare(input),
      acceptMessage: (prepared, hold) => engine.accept(prepared, hold),
      reportStorageFault: () => Effect.void,
      self: agentViewOf(local.card),
      scope,
      sendMessage: (input) => engine.send(input),
      emit,
    });
    const delivery = yield* makeHostDelivery({
      historyExport: noHistoryExport,
      collectives: () => collectives,
      scope,
      firewall,
      firewallEnvironment: () => environment,
    });
    slot.delivery = delivery;
    return { environment, delivery, collectives, emitted };
  }).pipe(
    Effect.provideService(SqlClient.SqlClient, subject.sql),
    Effect.withSpan("makeDelivery"),
  );

/** Runs the incoming worker over real conversation state and captures host notifications. */
export const incomingFixture = (
  subject: Fixture,
  middleware: MessageMiddleware,
  overrides: Partial<FirewallOptions> = {},
  seed = true,
) =>
  Effect.gen(function* () {
    const firewall = yield* makeTestFirewall(
      subject.sql,
      middleware,
      overrides,
    );
    yield* Effect.when(seedIncoming(subject), () => seed);
    const { environment, delivery, collectives, emitted } = yield* makeDelivery(
      subject,
      firewall,
    );
    const published: HarnessMessageReadyEvent[] = [];
    const readPending = pendingMessages(subject);
    const runPass = delivery.runPass(() => ({
      readPending,
      classify: collectives.classify,
      engine: { acknowledgeMessage: subject.engine.acknowledgeMessage },
      handler: {
        publish: (event) => {
          published.push(event);
          return true;
        },
      },
    }));
    const completed = yield* startAdmission(delivery, runPass);
    const pending = yield* readPending;
    const candidate = pending[0];
    if (candidate === undefined) {
      return yield* Effect.dieMessage("missing certified fixture");
    }
    return {
      ...environment,
      delivery,
      collectives,
      emitted,
      published,
      runPass,
      completed,
      candidate,
    };
  }).pipe(Effect.withSpan("incomingFixture"));

/** Host sends use the checked-send path with network delivery paused at the Router. */
export function outgoingFixture(
  subject: Fixture,
  middleware: MessageMiddleware,
  overrides: Partial<FirewallOptions> = {},
) {
  return makeTestFirewall(subject.sql, middleware, overrides).pipe(
    Effect.flatMap((firewall) => makeDelivery(subject, firewall)),
    Effect.map((runtime) => runtime.delivery),
    Effect.withSpan("outgoingFixture"),
  );
}

/** A complete registered norm delegates only its assessment to the test. */
export function policy(check: MessageMiddleware["check"]): MessageMiddleware {
  return { id: "communication", revision: "test-v1", rules: [rule], check };
}

function pendingMessages(subject: Fixture) {
  return subject.run(subject.store.readPendingDeliveries()).pipe(
    Effect.flatMap((entries) =>
      Effect.forEach(
        entries,
        (entry) =>
          Effect.gen(function* () {
            return {
              deliveryToken: entry.deliveryToken,
              recordHash: yield* Schema.decodeUnknown(RecordHash)(
                entry.recordHash,
              ),
              message: yield* decodeRuntimeValue(
                InboundMessage,
                entry.canonicalMessage,
              ),
            };
          }),
        { concurrency: 1 },
      ),
    ),
  );
}

/**
 * Reconcile inbox updates while the admission worker checks queued messages.
 * @returns A queue that receives one value per completed admission.
 */
function startAdmission(
  delivery: Effect.Effect.Success<ReturnType<typeof makeHostDelivery>>,
  runPass: Effect.Effect<void, unknown>,
) {
  return Effect.gen(function* () {
    const completed = yield* Queue.unbounded<undefined>();
    yield* delivery.inboxChanged.pipe(
      Stream.runForEach(() =>
        runPass.pipe(
          Effect.orDie,
          Effect.zipRight(Queue.offer(completed, undefined)),
          Effect.asVoid,
        ),
      ),
      Effect.forkScoped,
    );
    yield* delivery.runAdmission.pipe(Effect.forkScoped);
    return completed;
  });
}
