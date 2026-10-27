/** @file Exercises classified delivery durability and loss of request context. */

import { scopedLive as it } from "@effect/vitest";
import { Effect, Array as EffectArray, Schema, Scope } from "effect";
import { describe, expect } from "vitest";
import { digest } from "../../__tests__/agent-card-fixtures.js";
import { localGuidance } from "../../__tests__/message-policy-fixtures.js";
import {
  pendingMessage,
  publishEveryPost,
  recordAcknowledgments,
  takeEvery,
} from "../../__tests__/pending-delivery-fixtures.js";
import {
  stateDirectory,
  withStore,
} from "../../__tests__/store-schema-fixtures.js";
import { InboundItem } from "../../communication/collectives/inbound.js";
import {
  DeliveryToken,
  encodeRuntimeValue,
  openEndpointStore,
} from "../../communication/store/index.js";
import { LIVE_WIRE_VERSIONS } from "../../identity/wire-version.js";
import {
  eventIdOf,
  type HarnessMessageReadyEvent,
} from "../protocol/operations.js";
import { noHistoryExport } from "./history-export.js";
import { makeHostDelivery } from "./host-delivery.js";
import {
  persistInboxItem,
  readRuntimeEvent,
  readRuntimeInbox,
  recoverRuntimeInbox,
} from "./inbox.js";

/* eslint-disable agent-code-guard/no-hardcoded-assertion-literals -- Durable tombstone and snapshot fixtures pin exact store outcomes. */

const token = (byte: number) =>
  Schema.decodeUnknownSync(DeliveryToken)(digest("dlv_", byte));
const failure = Schema.decodeUnknownSync(InboundItem)({
  kind: "operationFailed",
  id: digest("col_", 1),
  to: "agent:bob",
  error: "request unavailable",
});
const requestConversation = "group:alice,bob,carol";
const request = Schema.decodeUnknownSync(InboundItem)({
  kind: "collectiveRequest",
  op: "all_gather",
  id: digest("col_", 2),
  postId: digest("pst_", 2),
  from: "agent:bob",
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
  send: () => Effect.dieMessage("unexpected send"),
  settleRequest: () => Effect.void,
};

const preservesTokenBindings = () => {
  const path = stateDirectory();
  return Effect.gen(function* () {
    yield* Effect.scoped(
      Effect.gen(function* () {
        const store = yield* openEndpointStore(path, {
          liveWireVersions: LIVE_WIRE_VERSIONS,
        });
        yield* store.putInboxItem({
          deliveryToken: token(1),
          canonicalItem: yield* encodeRuntimeValue(failure),
          canonicalGuidance: yield* encodeRuntimeValue(localGuidance(1)),
        });
        yield* store.acknowledgeInboxItem(token(1));
      }),
    );
    yield* Effect.scoped(
      Effect.gen(function* () {
        const store = yield* openEndpointStore(path, {
          liveWireVersions: LIVE_WIRE_VERSIONS,
        });
        yield* store.acknowledgeInboxItem(token(1));
        yield* persistInboxItem(store, {
          deliveryToken: token(1),
          item: failure,
        });
        expect((yield* readRuntimeInbox(store, {})).items).toEqual([]);
        const changed = yield* persistInboxItem(store, {
          deliveryToken: token(1),
          item: request,
        }).pipe(Effect.flip);
        expect(changed.reason).toBe("conflict");
      }),
    );
  });
};

const storeRequestAndFailure = (path: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const store = yield* openEndpointStore(path, {
        liveWireVersions: LIVE_WIRE_VERSIONS,
      });
      yield* persistInboxItem(store, {
        deliveryToken: token(1),
        item: failure,
      });
      yield* persistInboxItem(store, {
        deliveryToken: token(2),
        item: request,
      });
    }),
  );

const retiresLostRequests = () => {
  const path = stateDirectory();
  return Effect.gen(function* () {
    yield* storeRequestAndFailure(path);
    const recoveredToken = yield* Effect.scoped(
      Effect.gen(function* () {
        const store = yield* openEndpointStore(path, {
          liveWireVersions: LIVE_WIRE_VERSIONS,
        });
        yield* recoverRuntimeInbox(store);
        const page = yield* readRuntimeInbox(store, {});
        expect(page.items).toHaveLength(2);
        expect(page.items[0]).toEqual({
          deliveryToken: token(1),
          item: failure,
        });
        const lost = page.items[1];
        expect(lost?.deliveryToken).not.toBe(token(2));
        expect(lost?.item).toMatchObject({
          kind: "operationFailed",
          id: digest("col_", 2),
          to: "group:alice,bob,carol",
        });
        yield* store.acknowledgeInboxItem(token(2));
        return lost?.deliveryToken;
      }),
    );
    yield* Effect.scoped(
      Effect.gen(function* () {
        const store = yield* openEndpointStore(path, {
          liveWireVersions: LIVE_WIRE_VERSIONS,
        });
        yield* recoverRuntimeInbox(store);
        const page = yield* readRuntimeInbox(store, {});
        expect(page.items).toHaveLength(2);
        expect(page.items[1]?.deliveryToken).toBe(recoveredToken);
      }),
    );
  });
};

const holdsRestartReplacement = () => {
  const path = stateDirectory();
  return Effect.gen(function* () {
    yield* storeRequestAndFailure(path);
    const store = yield* openEndpointStore(path, {
      liveWireVersions: LIVE_WIRE_VERSIONS,
    });
    yield* recoverRuntimeInbox(store, true);
    expect((yield* readRuntimeInbox(store, {})).items).toEqual([
      { deliveryToken: token(1), item: failure },
    ]);
    expect((yield* readRuntimeEvent(store, eventIdOf(token(2)))).item).toEqual(
      request,
    );
    const pending = yield* store.readFirewallFrontiers();
    expect(pending).toHaveLength(1);
    const replacement = pending[0];
    if (replacement === undefined) {
      return yield* Effect.dieMessage("missing restart replacement");
    }
    expect(
      yield* Effect.flip(
        readRuntimeEvent(store, eventIdOf(replacement.deliveryToken)),
      ),
    ).toEqual({ reason: "unknown-event" });
    yield* recoverRuntimeInbox(store, true);
    expect(yield* store.readFirewallFrontiers()).toEqual(pending);
  });
};

const freezesPagesAcrossArrivalsAndAcknowledgments = () =>
  Effect.gen(function* () {
    const store = yield* openEndpointStore(stateDirectory(), {
      liveWireVersions: LIVE_WIRE_VERSIONS,
    });
    yield* Effect.forEach(
      EffectArray.range(1, 51),
      (index) =>
        persistInboxItem(store, {
          deliveryToken: token(index),
          item: failure,
        }),
      { concurrency: 1, discard: true },
    );
    const first = yield* readRuntimeInbox(store, {});
    expect(first.items).toHaveLength(50);
    expect(first.nextCursor).toBeDefined();
    yield* persistInboxItem(store, {
      deliveryToken: token(52),
      item: failure,
    });
    yield* store.acknowledgeInboxItem(token(1));
    const second = yield* readRuntimeInbox(store, {
      cursor: first.nextCursor,
    });
    expect(second.items.map((item) => item.deliveryToken)).toEqual([token(51)]);
    expect(second.nextCursor).toBeUndefined();
    expect((yield* store.readInboxSummary()).pendingCount).toBe(51);
    const invalid = yield* readRuntimeInbox(store, {
      cursor: "invalid",
    }).pipe(Effect.flip);
    expect(invalid.reason).toBe("invalid-continuation");
  });

const commitsReceiptAtomically = () => {
  const path = stateDirectory();
  const state = new TextEncoder().encode('{"registration":null}');
  return Effect.gen(function* () {
    yield* Effect.scoped(
      Effect.gen(function* () {
        const store = yield* openEndpointStore(path, {
          liveWireVersions: LIVE_WIRE_VERSIONS,
        });
        yield* persistInboxItem(store, {
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
    );
    yield* Effect.scoped(
      Effect.gen(function* () {
        const store = yield* openEndpointStore(path, {
          liveWireVersions: LIVE_WIRE_VERSIONS,
        });
        expect((yield* store.readInboxItem(token(1)))?.acknowledged).toBe(true);
        expect((yield* store.readInboxSummary()).pendingCount).toBe(0);
      }),
    );
  });
};

it(
  "holds a restart replacement privately while preserving the original token",
  holdsRestartReplacement,
);

it("retires unseen queued requests across pages and behind another conversation item", () => {
  const path = stateDirectory();
  return Effect.gen(function* () {
    yield* Effect.scoped(
      Effect.gen(function* () {
        const store = yield* openEndpointStore(path, {
          liveWireVersions: LIVE_WIRE_VERSIONS,
        });
        yield* store.queueFirewallItem({
          deliveryToken: token(1),
          conversation: requestConversation,
          canonicalItem: yield* encodeRuntimeValue(failure),
        });
        for (const index of EffectArray.range(2, 36)) {
          yield* store.queueFirewallItem({
            deliveryToken: token(index),
            conversation: requestConversation,
            canonicalItem: yield* encodeRuntimeValue(request),
          });
        }
      }),
    );
    const store = yield* openEndpointStore(path, {
      liveWireVersions: LIVE_WIRE_VERSIONS,
    });
    yield* recoverRuntimeInbox(store, true);
    const pending = yield* store.readPendingFirewallItems(0);
    yield* recoverRuntimeInbox(store, true);
    expect(pending.map((entry) => entry.deliveryToken)).toEqual([token(1)]);
    expect((yield* readRuntimeInbox(store, {})).items).toEqual([]);
    expect(yield* store.readPendingFirewallItems(0)).toEqual(pending);
  });
});

it("replays the admitted envelope across restart and retains it after acknowledgment", () => {
  const path = stateDirectory();
  const guidance = localGuidance(1);
  const pending = pendingMessage(1);
  const item: InboundItem = { kind: "multicast", message: pending.message };
  const event = { deliveryToken: pending.deliveryToken, item, guidance };
  return Effect.gen(function* () {
    const canonicalItem = yield* encodeRuntimeValue(item);
    const canonicalGuidance = yield* encodeRuntimeValue(guidance);
    yield* withStore(path, (store) =>
      store.putInboxItem({
        deliveryToken: event.deliveryToken,
        canonicalItem,
        canonicalGuidance,
      }),
    );
    const store = yield* openEndpointStore(path, {
      liveWireVersions: LIVE_WIRE_VERSIONS,
    });
    const delivery = yield* makeHostDelivery({
      store,
      historyExport: noHistoryExport,
      collectives: () => unusedCollectives,
      scope: yield* Scope.Scope,
    });
    const published: HarnessMessageReadyEvent[] = [];
    const pass = () => ({
      readPending: Effect.succeed([pending]),
      engine: recordAcknowledgments([]),
      classify: publishEveryPost,
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
        eventId: eventIdOf(event.deliveryToken),
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
    "replaces a lost request with one stable, separately identified failure",
    retiresLostRequests,
  );
  it(
    "bounds a snapshot while new arrivals and acknowledgments change unread state",
    freezesPagesAcrossArrivalsAndAcknowledgments,
  );
});

/* eslint-enable agent-code-guard/no-hardcoded-assertion-literals -- Restore repository defaults. */
