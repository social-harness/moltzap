/** @file Classified delivery, stable token bindings, and acknowledgment durability. */

import { scopedLive as it } from "@effect/vitest";
import { Effect, Array as EffectArray, Schema, Scope } from "effect";
import { describe, expect } from "vitest";
import type { HarnessMessageReadyEvent } from "../../host-protocol/operations.js";
import { digest, testAgentView } from "../../__tests__/agent-card-fixtures.js";
import { collectiveOperationId } from "../../__tests__/collective-id-fixtures.js";
import { openTestDatabase } from "../../__tests__/communication-test-database.js";
import { localGuidance } from "../../__tests__/message-policy-fixtures.js";
import {
  pendingMessage,
  publishEveryMessage,
  recordAcknowledgments,
  takeEvery,
} from "../../__tests__/pending-delivery-fixtures.js";
import {
  stateDirectory,
  withDaemonStore,
} from "../../__tests__/store-schema-fixtures.js";
import {
  DeliveryToken,
  encodeRuntimeValue,
} from "../../communication/store/index.js";
import { InboundItem } from "../../host-protocol/items.js";
import { makeHostDelivery } from "./host-delivery.js";
import { noHistoryExport } from "./host-traffic-log.js";
import { persistInboxItem, readRuntimeInbox } from "./inbox.js";

/* eslint-disable agent-code-guard/no-hardcoded-assertion-literals -- Durable tombstone and snapshot fixtures pin exact store outcomes. */

const token = (byte: number) =>
  Schema.decodeUnknownSync(DeliveryToken)(digest("dlv_", byte));
const failure = Schema.decodeUnknownSync(InboundItem)({
  kind: "operationFailed",
  operationId: collectiveOperationId(testAgentView("agent:alice").agentId, 1),
  to: "agent:bob",
  error: "request unavailable",
});
const requestConversation = "group:alice,bob,carol";
const request = Schema.decodeUnknownSync(InboundItem)({
  kind: "collectiveRequest",
  op: "all_gather",
  operationId: collectiveOperationId(testAgentView("agent:alice").agentId, 2),
  msgId: digest("msg_", 2),
  from: testAgentView("agent:bob"),
  to: requestConversation,
  question: "Answer independently",
  requestedSchema: {
    type: "object",
    properties: { answer: { type: "string" } },
    required: ["answer"],
  },
  deadlineAt: 4_000_000_000_000,
});

/** A collective layer this file's deliveries never send through. */
const unusedCollectives = {
  prepare: () => Effect.dieMessage("unexpected send"),
  accept: () => Effect.dieMessage("unexpected send"),
};

const preservesTokenBindings = () => {
  const path = stateDirectory();
  return Effect.gen(function* () {
    yield* Effect.scoped(
      withDaemonStore(path, (store) =>
        Effect.gen(function* () {
          yield* store.putInboxItem({
            deliveryToken: token(1),
            canonicalItem: yield* encodeRuntimeValue(failure),
            canonicalGuidance: yield* encodeRuntimeValue(localGuidance(1)),
          });
          yield* store.acknowledgeInboxItem(token(1));
        }),
      ),
    );
    yield* Effect.scoped(
      withDaemonStore(path, (store) =>
        Effect.gen(function* () {
          yield* store.acknowledgeInboxItem(token(1));
          yield* persistInboxItem({
            deliveryToken: token(1),
            item: failure,
          });
          expect((yield* readRuntimeInbox({})).items).toEqual([]);
          const changed = yield* persistInboxItem({
            deliveryToken: token(1),
            item: request,
          }).pipe(Effect.flip);
          expect(changed.reason).toBe("conflict");
        }),
      ),
    );
  });
};

const freezesPagesAcrossArrivalsAndAcknowledgments = () =>
  withDaemonStore(stateDirectory(), (store) =>
    Effect.gen(function* () {
      yield* Effect.forEach(
        EffectArray.range(1, 51),
        (index) =>
          persistInboxItem({
            deliveryToken: token(index),
            item: failure,
          }),
        { concurrency: 1, discard: true },
      );
      const first = yield* readRuntimeInbox({});
      expect(first.items).toHaveLength(50);
      expect(first.nextCursor).toBeDefined();
      yield* persistInboxItem({
        deliveryToken: token(52),
        item: failure,
      });
      yield* store.acknowledgeInboxItem(token(1));
      const second = yield* readRuntimeInbox({
        cursor: first.nextCursor,
      });
      expect(second.items.map((item) => item.deliveryToken)).toEqual([
        token(51),
      ]);
      expect(second.nextCursor).toBeUndefined();
      expect((yield* store.readInboxSummary()).pendingCount).toBe(51);
      const invalid = yield* readRuntimeInbox({
        cursor: "invalid",
      }).pipe(Effect.flip);
      expect(invalid.reason).toBe("invalid-continuation");
    }),
  );

const commitsReceiptAtomically = () => {
  const path = stateDirectory();
  const state = new TextEncoder().encode('{"registration":null}');
  return Effect.gen(function* () {
    yield* Effect.scoped(
      withDaemonStore(path, (store) =>
        Effect.gen(function* () {
          yield* persistInboxItem({
            deliveryToken: token(1),
            item: failure,
          });
          yield* store.writeEventState(state);
          const error = yield* store
            .completeWebhookDelivery(token(1), new Uint8Array())
            .pipe(Effect.flip);
          expect(error.reason).toBe("invalid-input");
          expect((yield* store.readInboxSummary()).pendingCount).toBe(1);
          expect(yield* store.readEventState()).toEqual(state);
          const next = new TextEncoder().encode(
            '{"registration":{"outbox":null}}',
          );
          yield* store.completeWebhookDelivery(token(1), next);
          expect((yield* store.readInboxSummary()).pendingCount).toBe(0);
          expect(yield* store.readEventState()).toEqual(next);
        }),
      ),
    );
    yield* Effect.scoped(
      withDaemonStore(path, (store) =>
        Effect.gen(function* () {
          expect((yield* store.readInboxItem(token(1)))?.acknowledged).toBe(
            true,
          );
          expect((yield* store.readInboxSummary()).pendingCount).toBe(0);
        }),
      ),
    );
  });
};

it("replays the admitted envelope across restart and retains it after acknowledgment", () => {
  const path = stateDirectory();
  const guidance = localGuidance(1);
  const pending = pendingMessage(1);
  const item: InboundItem = { kind: "multicast", message: pending.message };
  const event = { deliveryToken: pending.deliveryToken, item, guidance };
  return Effect.gen(function* () {
    const canonicalItem = yield* encodeRuntimeValue(item);
    const canonicalGuidance = yield* encodeRuntimeValue(guidance);
    yield* withDaemonStore(path, (store) =>
      store.putInboxItem({
        deliveryToken: event.deliveryToken,
        canonicalItem,
        canonicalGuidance,
      }),
    );
    const database = yield* openTestDatabase(path);
    const delivery = yield* makeHostDelivery({
      historyExport: noHistoryExport,
      collectives: () => unusedCollectives,
      scope: yield* Scope.Scope,
    }).pipe(database.run);
    const published: HarnessMessageReadyEvent[] = [];
    const pass = () => ({
      readPending: Effect.succeed([pending]),
      engine: recordAcknowledgments([]),
      classify: publishEveryMessage,
      handler: takeEvery(published),
    });
    yield* delivery.runPass(pass);
    expect(published).toEqual([event]);
    expect(yield* delivery.operations.readInbox({})).toEqual({
      items: [event],
    });
    yield* delivery.operations.acknowledgeDelivery(event.deliveryToken);
    yield* delivery.detach;
    yield* delivery.runPass(pass);
    expect(published).toEqual([event]);
    expect(yield* delivery.operations.readInbox({})).toEqual({ items: [] });
    expect(
      yield* delivery.operations.readEvent({
        eventId: event.deliveryToken,
      }),
    ).toEqual({ item, guidance });
  });
});

describe("durable runtime inbox", () => {
  it(
    "rolls back a failed receipt commit and retains a successful retirement across reopen",
    commitsReceiptAtomically,
  );
  it(
    "retains acknowledgment tombstones and rejects token payload collisions",
    preservesTokenBindings,
  );
  it(
    "bounds a snapshot while new arrivals and acknowledgments change unread state",
    freezesPagesAcrossArrivalsAndAcknowledgments,
  );
});

/* eslint-enable agent-code-guard/no-hardcoded-assertion-literals -- Restore repository defaults. */
