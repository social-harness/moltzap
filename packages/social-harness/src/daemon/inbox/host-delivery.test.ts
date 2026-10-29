/**
 * @file Host operations over one service's delivery: registration gating, the
 * send export, local-item reads and acknowledgment, the webhook view's receipt
 * and inbox reads, and the pending-delivery passes that publish to a
 * subscriber.
 */

import { scopedLive as it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, Ref, Schema, Scope } from "effect";
import { describe, expect } from "vitest";
import type { CollectiveOperations } from "../../communication/collectives/index.js";
import type { HarnessMessageReadyEvent } from "../../host-protocol/operations.js";
import type { HistoryExportRecord } from "./host-traffic-log.js";
import { digest } from "../../__tests__/agent-card-fixtures.js";
import {
  pendingMessage,
  publishEveryPost,
  recordAcknowledgments,
  takeEvery,
} from "../../__tests__/pending-delivery-fixtures.js";
import { stateDirectory } from "../../__tests__/store-schema-fixtures.js";
import {
  CollectiveEmitError,
  CollectiveError,
  CollectiveId,
  SendInput,
} from "../../communication/collectives/contracts.js";
import { InboundItem } from "../../communication/collectives/inbound.js";
import { SendError } from "../../communication/conversations/errors.js";
import { AgentAddress, PostId } from "../../communication/records/index.js";
import {
  DeliveryToken,
  type EndpointStore,
  EndpointStoreError,
  openEndpointStore,
} from "../../communication/store/index.js";
import { LIVE_WIRE_VERSIONS } from "../../identity/wire-version.js";
import { makeHostDelivery } from "./host-delivery.js";

/* eslint-disable agent-code-guard/no-hardcoded-assertion-literals -- Closed error reasons and export record kinds are the contract under test. */

type Collectives = Pick<CollectiveOperations, "send">;

const input = Schema.decodeUnknownSync(SendInput)({
  to: "agent:bob",
  text: "one operation",
});
const operationId = Schema.decodeUnknownSync(CollectiveId)(digest("col_", 3));
const postId = Schema.decodeUnknownSync(PostId)(digest("pst_", 4));
const bob = Schema.decodeUnknownSync(AgentAddress)("agent:bob");
const failure = Schema.decodeUnknownSync(InboundItem)({
  kind: "operationFailed",
  id: digest("col_", 1),
  to: "agent:bob",
  error: "request unavailable",
});
const unboundToken = Schema.decodeUnknownSync(DeliveryToken)(digest("dlv_", 9));

/**
 * Build one delivery over a fresh store, optionally adjusted, whose active
 * collective layer the test sets and replaces through the returned slot.
 */
const makeFixture = (adjust: (store: EndpointStore) => EndpointStore) =>
  Effect.gen(function* () {
    const store = adjust(
      yield* openEndpointStore(stateDirectory(), {
        liveWireVersions: LIVE_WIRE_VERSIONS,
      }),
    );
    const records: HistoryExportRecord[] = [];
    const slot: { collectives?: Collectives } = {};
    const delivery = yield* makeHostDelivery({
      store,
      historyExport: {
        record: (record) =>
          Effect.sync(() => {
            records.push(record);
          }),
      },
      collectives: () =>
        slot.collectives === undefined
          ? undefined
          : { ...slot.collectives, settleRequest: () => Effect.void },
      scope: yield* Scope.Scope,
    });
    return { delivery, records, slot };
  });

const deliveryFixture = makeFixture((store) => store);

/**
 * An unregistered service refuses every host operation with its closed
 * reason and records nothing; the active layer is read on each call, so a
 * layer installed after construction serves the next send.
 */
const refusesUntilRegistered = () =>
  Effect.gen(function* () {
    const { delivery, records, slot } = yield* deliveryFixture;
    const { operations } = delivery;
    expect(yield* Effect.flip(operations.send({ input }))).toEqual(
      new SendError({ reason: "not-registered" }),
    );
    expect(yield* Effect.flip(operations.readInbox({}))).toEqual({
      reason: "not-registered",
    });
    expect(
      yield* Effect.flip(operations.readEvent({ eventId: "evt_absent" })),
    ).toEqual({ reason: "not-registered" });
    expect(
      (yield* Effect.flip(operations.acknowledgeDelivery(unboundToken))).reason,
    ).toBe("unknown-delivery");
    expect(records).toEqual([]);
    slot.collectives = {
      send: () =>
        Effect.succeed({ kind: "collective", operationId, postIds: [postId] }),
    };
    expect(yield* operations.send({ input })).toEqual({
      kind: "collective",
      operationId,
    });
  });

/**
 * Each completed send lands in the history export with how it ended: the
 * certified posts and operation id, or the returned error's message. A
 * multicast returns the post it created and its conversation's address.
 */
const exportsEachSend = () =>
  Effect.gen(function* () {
    const { delivery, records, slot } = yield* deliveryFixture;
    const { operations } = delivery;
    const outcomes = sendOutcomes();
    slot.collectives = {
      send: () => outcomes.shift() ?? Effect.dieMessage("unexpected send"),
    };
    expect(yield* operations.send({ input })).toEqual({
      kind: "collective",
      operationId,
    });
    expect(yield* operations.send({ input })).toEqual({
      kind: "multicast",
      postId,
      address: bob,
    });
    const refused = yield* Effect.exit(operations.send({ input }));
    expect(refused).toEqual(
      Exit.fail(new SendError({ reason: "content-invalid" })),
    );
    expect(yield* Effect.flip(operations.send({ input }))).toEqual(
      new CollectiveError({
        id: operationId,
        failure: { kind: "request-none" },
      }),
    );
    assertSendExports(records);
  });

function sendOutcomes() {
  const outcomes: Array<
    Effect.Effect<
      Effect.Effect.Success<ReturnType<Collectives["send"]>>,
      SendError | CollectiveError
    >
  > = [
    Effect.succeed({ kind: "collective", operationId, postIds: [postId] }),
    Effect.succeed({
      kind: "multicast",
      postIds: [postId],
      postId,
      address: bob,
    }),
    Effect.fail(new SendError({ reason: "content-invalid" })),
    Effect.fail(
      new CollectiveError({
        id: operationId,
        failure: { kind: "request-none" },
      }),
    ),
  ];
  return outcomes;
}

function assertSendExports(records: readonly HistoryExportRecord[]) {
  expect(
    records.map((record) =>
      record.kind === "outbound"
        ? { input: record.input, outcome: record.outcome }
        : record,
    ),
  ).toEqual([
    { input, outcome: { kind: "sent", operationId, postIds: [postId] } },
    { input, outcome: { kind: "sent", postIds: [postId] } },
    {
      input,
      outcome: {
        kind: "failed",
        error: new SendError({ reason: "content-invalid" }).message,
      },
    },
    {
      input,
      outcome: {
        kind: "failed",
        error: new CollectiveError({
          id: operationId,
          failure: { kind: "request-none" },
        }).message,
      },
    },
  ]);
}

/**
 * A queued local item is durable and readable, exported on its first read
 * only, and gone from the inbox once acknowledged.
 */
const exportsLocalItemOnceAndForgetsIt = () =>
  Effect.gen(function* () {
    const { delivery, records, slot } = yield* deliveryFixture;
    const { operations } = delivery;
    slot.collectives = { send: () => Effect.dieMessage("unexpected send") };
    yield* delivery.queueLocalItem(failure);
    const [queued] = (yield* operations.readInbox({})).items;
    if (queued === undefined) {
      throw new Error("queued item is not in the inbox");
    }
    const { deliveryToken } = queued;
    const expected = { items: [{ deliveryToken, item: failure }] };
    expect(yield* operations.readInbox({})).toEqual(expected);
    expect(yield* operations.readInbox({})).toEqual(expected);
    expect(
      records.map((record) =>
        record.kind === "inbound"
          ? { kind: record.kind, item: record.item }
          : record,
      ),
    ).toEqual([{ kind: "inbound", item: failure }]);
    yield* operations.acknowledgeDelivery(deliveryToken);
    expect(yield* operations.readInbox({})).toEqual({ items: [] });
    expect(
      (yield* Effect.flip(operations.acknowledgeDelivery(unboundToken))).reason,
    ).toBe("unknown-delivery");
  });

/**
 * A store failure while retiring a delivery reports persistence-failed, not
 * unknown-delivery, so the host keeps the item and retries rather than
 * treating it as already gone; the caches keep it too.
 */
const reportsAcknowledgmentPersistenceFailure = () =>
  Effect.gen(function* () {
    const { delivery, slot } = yield* makeFixture((store) => ({
      ...store,
      acknowledgeInboxItem: () =>
        Effect.fail(new EndpointStoreError({ reason: "corrupt" })),
    }));
    slot.collectives = { send: () => Effect.dieMessage("unexpected send") };
    yield* delivery.queueLocalItem(failure);
    const [queued] = (yield* delivery.operations.readInbox({})).items;
    if (queued === undefined) {
      throw new Error("queued item is not in the inbox");
    }
    const { deliveryToken } = queued;
    expect(
      (yield* Effect.flip(
        delivery.operations.acknowledgeDelivery(deliveryToken),
      )).reason,
    ).toBe("persistence-failed");
    expect((yield* delivery.operations.readInbox({})).items).toEqual([
      { deliveryToken, item: failure },
    ]);
  });

/**
 * A pass whose classification fails because an emitted item could not be
 * kept ends with that failure and releases the delivery gate, so a host read
 * that waits on the gate still completes.
 */
const releasesTheGateWhenAPassFails = () =>
  Effect.gen(function* () {
    const { delivery, slot } = yield* deliveryFixture;
    slot.collectives = { send: () => Effect.dieMessage("unexpected send") };
    const pending = pendingMessage(5);
    const failure = yield* Effect.flip(
      delivery.runPass(() => ({
        readPending: Effect.succeed([pending]),
        engine: { acknowledgeMessage: () => Effect.void },
        classify: () => Effect.fail(new CollectiveEmitError()),
      })),
    );
    const page = yield* delivery.operations
      .readInbox({})
      .pipe(Effect.timeout("1 second"));

    expect(failure).toEqual(new CollectiveEmitError());
    expect(page.items).toEqual([]);
  });

/**
 * A send whose input fails its schema is refused as `content-invalid` before
 * it reaches the collective layer or the history export.
 */
const refusesInvalidSendInput = () =>
  Effect.gen(function* () {
    const { delivery, records, slot } = yield* deliveryFixture;
    let sent = 0;
    slot.collectives = {
      send: () =>
        Effect.sync(() => {
          sent += 1;
          return { kind: "collective", operationId, postIds: [postId] };
        }),
    };
    const malformed = Schema.decodeUnknownSync(Schema.Unknown)({
      input: { to: "agent:bob", text: "hi", collective: { op: "broadcast" } },
    });
    const refused = yield* Effect.exit(
      delivery.operations.send(
        // eslint-disable-next-line agent-code-guard/require-assertion-rationale -- The operation's argument type admits only valid input; this probe passes what an untyped caller could.
        malformed as Parameters<typeof delivery.operations.send>[0],
      ),
    );
    expect(refused).toEqual(
      Exit.fail(new SendError({ reason: "content-invalid" })),
    );
    expect(sent).toBe(0);
    expect(records).toEqual([]);
  });

describe("host delivery", () => {
  it(
    "refuses host operations until a collective layer is active",
    refusesUntilRegistered,
  );
  it("records each completed send in the history export", exportsEachSend);
  it(
    "refuses a send whose input fails its schema as content-invalid",
    refusesInvalidSendInput,
  );
  it(
    "exports a queued local item once and forgets it on acknowledgment",
    exportsLocalItemOnceAndForgetsIt,
  );
  it(
    "reports a store failure while acknowledging as persistence-failed",
    reportsAcknowledgmentPersistenceFailure,
  );
  it(
    "releases the delivery gate when a pass fails",
    releasesTheGateWhenAPassFails,
  );
});

/* eslint-enable agent-code-guard/no-hardcoded-assertion-literals -- Restore repository defaults after the host delivery tests. */

/**
 * A webhook receipt interrupted after the store commits it still finishes its
 * caller's uninterruptible state update, so shutdown cannot drop the update
 * that follows a durable receipt. The interruption is delivered before the
 * commit is released.
 */
const finishesCallerStateAfterReceiptCommit = () =>
  Effect.gen(function* () {
    const committed = yield* Deferred.make<undefined>();
    const release = yield* Deferred.make<undefined>();
    const { delivery } = yield* makeFixture((store) => ({
      ...store,
      completeWebhookDelivery: () =>
        Deferred.succeed(committed, undefined).pipe(
          Effect.zipRight(Deferred.await(release)),
        ),
    }));
    const updated = yield* Ref.make(false);
    const receipt = yield* delivery.eventStore
      .completeWebhookDelivery(unboundToken, new Uint8Array([1]))
      .pipe(
        Effect.zipRight(Ref.set(updated, true)),
        Effect.uninterruptible,
        Effect.fork,
      );
    yield* Deferred.await(committed);

    const interruption = yield* Effect.fork(Fiber.interrupt(receipt));
    yield* Effect.yieldNow();
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(interruption);

    expect(
      yield* Ref.get(updated),
      "caller state update after the committed receipt",
    ).toBe(true);
  }).pipe(Effect.timeout("1 second"));

/**
 * An item read through the webhook's inbox view lands in the history export,
 * decoded from its stored bytes, as a native inbox read would export it.
 */
const exportsItemsReadThroughTheWebhookView = () =>
  Effect.gen(function* () {
    const { delivery, records } = yield* deliveryFixture;
    yield* delivery.queueLocalItem(failure);

    yield* delivery.eventStore.readInbox({ limit: 1 });

    expect(records).toEqual([
      expect.objectContaining({ kind: "inbound", item: failure }),
    ]);
  });

describe("host delivery webhook view", () => {
  it(
    "finishes the caller's state update after a committed receipt",
    finishesCallerStateAfterReceiptCommit,
  );
  it(
    "exports an item read through the webhook inbox view",
    exportsItemsReadThroughTheWebhookView,
  );
});

const firstFromBob = pendingMessage(21);
const emittedFailure = Schema.decodeUnknownSync(InboundItem)({
  kind: "operationFailed",
  id: digest("col_", 24),
  to: "agent:bob",
  error: "collective failed",
});

/**
 * An item the collective layer emitted is made durable when queued and is
 * published after the durable deliveries of the next pass.
 */
const publishesTheCollectiveLayerSOwnItemsAfterDurableDeliveries = () =>
  Effect.gen(function* () {
    const { delivery } = yield* deliveryFixture;
    const taken: HarnessMessageReadyEvent[] = [];
    yield* delivery.queueLocalItem(emittedFailure);

    yield* delivery.runPass(() => ({
      readPending: Effect.succeed([firstFromBob]),
      engine: recordAcknowledgments([]),
      classify: publishEveryPost,
      handler: takeEvery(taken),
    }));

    expect(taken.map((event) => event.item)).toEqual([
      { kind: "multicast", message: firstFromBob.message },
      emittedFailure,
    ]);
    expect(taken[0]?.deliveryToken).toBe(firstFromBob.deliveryToken);
  });

/**
 * After the subscriber detaches, the next pass offers a delivery it took
 * again, and the history export still holds the item once.
 */
const recordsEachPublishedItemInTheHistoryExportOnce = () =>
  Effect.gen(function* () {
    const { delivery, records } = yield* deliveryFixture;
    const taken: HarnessMessageReadyEvent[] = [];
    const pass = () => ({
      readPending: Effect.succeed([firstFromBob]),
      engine: recordAcknowledgments([]),
      classify: publishEveryPost,
      handler: takeEvery(taken),
    });
    yield* delivery.runPass(pass);
    yield* delivery.detach;

    yield* delivery.runPass(pass);

    expect(taken.map((event) => event.deliveryToken)).toEqual([
      firstFromBob.deliveryToken,
      firstFromBob.deliveryToken,
    ]);
    expect(records).toMatchObject([
      {
        kind: "inbound",
        item: { kind: "multicast", message: firstFromBob.message },
      },
    ]);
  });

describe("host delivery passes", () => {
  it(
    "publishes the collective layer's own items after durable deliveries",
    publishesTheCollectiveLayerSOwnItemsAfterDurableDeliveries,
  );
  it(
    "records each published item in the history export once",
    recordsEachPublishedItemInTheHistoryExportOnce,
  );
});
