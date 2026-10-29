/** @file Request context and admission queues survive current-store restarts. */

import { live as it, scoped as itOnClock } from "@effect/vitest";
import {
  Clock,
  Duration,
  Effect,
  Encoding,
  Option,
  Schema,
  Scope,
  TestClock,
} from "effect";
import { expect } from "vitest";
import type { InboundItem } from "../../communication/collectives/inbound.js";
import { digest } from "../../__tests__/agent-card-fixtures.js";
import {
  bytes,
  stateDirectory,
  storedConversation,
} from "../../__tests__/store-schema-fixtures.js";
import { makeCollectiveOperations } from "../../communication/collectives/index.js";
import {
  collectiveIdOf,
  encodeCollectiveContent,
} from "../../communication/collectives/wire/index.js";
import { SendError } from "../../communication/conversations/errors.js";
import { InboundMessage } from "../../communication/conversations/message.js";
import { RecordHash } from "../../communication/records/index.js";
import { AgentAddress } from "../../communication/records/values.js";
import {
  type DeliveryToken,
  encodeRuntimeValue,
  type EndpointStore,
  openEndpointStore,
} from "../../communication/store/index.js";
import { encodeCanonical } from "../../encoding/canonical-json.js";
import { LIVE_WIRE_VERSIONS } from "../../identity/wire-version.js";
import { readRuntimeInbox } from "./inbox.js";

const self = Schema.decodeUnknownSync(AgentAddress)("agent:alice");
const sender = Schema.decodeUnknownSync(AgentAddress)("agent:bob");
const nonce = Encoding.encodeBase64Url(new Uint8Array(32).fill(8));
const id = collectiveIdOf(sender, nonce);
const { foundation, record } = storedConversation("pending-request");
const recordHash = Schema.decodeUnknownSync(RecordHash)(record.recordHash);
const message = () =>
  Schema.decodeUnknownSync(InboundMessage)({
    kind: "direct",
    postId: record.postId,
    address: sender,
    sender,
    content: [
      { type: "text", text: "Please answer" },
      {
        type: "data",
        value: {
          "org.social-harness/collective": {
            kind: "operation",
            op: "gather",
            id,
            nonce,
            deadlineAt: Date.now() + 60_000,
            requestedSchema: {
              type: "object",
              properties: { answer: { type: "string" } },
              required: ["answer"],
            },
          },
        },
      },
    ],
  });
const response = {
  to: sender,
  collectiveResponse: { action: "accept", content: { answer: "yes" } },
} as const;
const unavailable = () =>
  Effect.fail(new SendError({ reason: "network-unavailable" }));

function makeCollectives(
  store: EndpointStore,
  scope: Scope.Scope,
  firewall = false,
) {
  return makeCollectiveOperations({
    store,
    self,
    scope,
    lookupMember: () => Effect.void,
    sendPost: unavailable,
    bindPost: (...[, hold]) =>
      hold.pipe(Effect.as({ certified: unavailable() })),
    sendAdmitted: unavailable,
    observePost: unavailable,
    reportStorageFault: () => Effect.dieMessage("unexpected storage fault"),
    emit: () => Effect.dieMessage("a request emits no local result"),
    ...(firewall
      ? {
          admission: {
            bindPost: <E>(
              ...[, hold]: [unknown, Effect.Effect<Effect.Effect<void>, E>]
            ) => hold.pipe(Effect.as({ certified: unavailable() })),
            admitGather: () =>
              Effect.dieMessage("the receiver starts no gather"),
          },
        }
      : {}),
  });
}

function seedRequest(store: EndpointStore, request: InboundMessage) {
  return Effect.gen(function* () {
    yield* store.bindIdentity({
      agentId: "agent:alice",
      canonicalAgentCard: bytes("identity"),
    });
    yield* store.putConversationFoundation(foundation);
    yield* store.applyCertifiedRecord(record, {
      recipientAgentId: "agent:alice",
      canonicalMessage: yield* encodeCanonical(InboundMessage, request),
    });
  });
}

it("restores an acknowledged request's answer context with its original delivery identity", () => {
  const path = stateDirectory();
  return Effect.gen(function* () {
    const token = yield* Effect.scoped(
      Effect.gen(function* () {
        const store = yield* openEndpointStore(path, {
          liveWireVersions: LIVE_WIRE_VERSIONS,
        });
        const request = message();
        yield* seedRequest(store, request);
        const layer = yield* makeCollectives(store, yield* Scope.Scope);
        const item = yield* layer.classify({ message: request, recordHash });
        if (Option.isNone(item)) {
          return yield* Effect.dieMessage("missing classified request");
        }
        const [pending] = yield* store.readPendingDeliveries();
        if (pending === undefined) {
          return yield* Effect.dieMessage("missing delivery");
        }
        yield* store.putInboxItem({
          deliveryToken: pending.deliveryToken,
          canonicalItem: yield* encodeRuntimeValue(item.value),
        });
        yield* store.acknowledgeInboxItem(pending.deliveryToken);
        yield* store.acknowledgeDelivery(pending.deliveryToken);
        return pending.deliveryToken;
      }),
    );
    yield* Effect.scoped(
      Effect.gen(function* () {
        const store = yield* openEndpointStore(path, {
          liveWireVersions: LIVE_WIRE_VERSIONS,
        });
        const layer = yield* makeCollectives(store, yield* Scope.Scope);
        expect(yield* Effect.flip(layer.send(response))).toEqual(
          new SendError({ reason: "network-unavailable" }),
        );
        expect((yield* store.readInboxItem(token))?.acknowledged).toBe(true);
        expect((yield* readRuntimeInbox(store, {})).items).toEqual([]);
        expect((yield* store.readCollectiveOperations())[0]).toMatchObject({
          operationId: id,
          origin: { kind: "remote", recordHash },
        });
      }),
    );
  });
});

it("preserves a request awaiting admission and keeps it unanswerable after restart", () => {
  const path = stateDirectory();
  return Effect.gen(function* () {
    const queued = yield* Effect.scoped(
      Effect.gen(function* () {
        const store = yield* openEndpointStore(path, {
          liveWireVersions: LIVE_WIRE_VERSIONS,
        });
        const request = message();
        yield* seedRequest(store, request);
        const layer = yield* makeCollectives(store, yield* Scope.Scope, true);
        const classified = yield* layer.classify({
          message: request,
          recordHash,
        });
        const [pending] = yield* store.readPendingDeliveries();
        if (Option.isNone(classified) || pending === undefined) {
          return yield* Effect.dieMessage("missing request");
        }
        const item = {
          deliveryToken: pending.deliveryToken,
          conversation: sender,
          canonicalItem: yield* encodeRuntimeValue(classified.value),
        };
        yield* store.queueFirewallItem(item);
        return item;
      }),
    );
    yield* Effect.scoped(
      Effect.gen(function* () {
        const store = yield* openEndpointStore(path, {
          liveWireVersions: LIVE_WIRE_VERSIONS,
        });
        const layer = yield* makeCollectives(store, yield* Scope.Scope, true);
        expect(yield* Effect.flip(layer.send(response))).toMatchObject({
          failure: { kind: "request-none" },
        });
        expect(yield* store.readFirewallFrontiers()).toEqual([
          { ...queued, sequence: 1 },
        ]);
        expect((yield* store.readPendingDeliveries())[0]?.deliveryToken).toBe(
          queued.deliveryToken,
        );
      }),
    );
  });
});

itOnClock(
  "reconstructs acknowledged group context and publishes a delayed close once after restart",
  () =>
    Effect.gen(function* () {
      const path = stateDirectory();
      const history = yield* delayedCloseHistory();
      const emitted: InboundItem[] = [];
      yield* acknowledgeGroupRequest(path, history, emitted);
      yield* TestClock.adjust(Duration.hours(2));
      const token = yield* receiveDelayedClose(path, history, emitted);
      yield* assertRetainedResult(path, emitted, token);
      yield* assertAcknowledgedResult(path, emitted);
      expect(emitted).toHaveLength(1);
    }),
);

const group = "group:alice,bob,carol";
const answerHash = digest("rch_", 41);

type DelayedHistory = Effect.Effect.Success<
  ReturnType<typeof delayedCloseHistory>
>;

function groupRequest() {
  return Effect.gen(function* () {
    const content = yield* encodeCollectiveContent(
      {
        kind: "operation",
        op: "all_gather",
        id,
        nonce,
        deadlineAt: (yield* Clock.currentTimeMillis) + 60_000,
        requestedSchema: {
          type: "object",
          properties: { answer: { type: "string" } },
          required: ["answer"],
        },
      },
      "Which day?",
    );
    return Schema.decodeUnknownSync(InboundMessage)({
      kind: "group",
      postId: record.postId,
      sender,
      address: group,
      members: ["agent:alice", "agent:bob", "agent:carol"],
      content,
    });
  });
}

function delayedCloseHistory() {
  return Effect.gen(function* () {
    const request = yield* groupRequest();
    const answer = Schema.decodeUnknownSync(InboundMessage)({
      ...request,
      postId: digest("pst_", 42),
      sender: "agent:carol",
      content: yield* encodeCollectiveContent({
        kind: "response",
        id,
        action: "accept",
        content: { answer: "Monday" },
      }),
    });
    const close = Schema.decodeUnknownSync(InboundMessage)({
      ...request,
      postId: digest("pst_", 43),
      content: yield* encodeCollectiveContent({
        kind: "close",
        closedAt: 60_000,
        closedBy: "deadline",
        id,
        included: [Schema.decodeUnknownSync(RecordHash)(answerHash)],
      }),
    });
    return { request, answer, close };
  });
}

function restoringLayer(
  store: EndpointStore,
  scope: Scope.Scope,
  emitted: InboundItem[],
) {
  return makeCollectiveOperations({
    store,
    self,
    scope,
    lookupMember: () => Effect.void,
    sendPost: unavailable,
    bindPost: (...[, hold]) =>
      hold.pipe(Effect.as({ certified: unavailable() })),
    sendAdmitted: unavailable,
    observePost: unavailable,
    reportStorageFault: () => Effect.dieMessage("unexpected storage fault"),
    emit: (item, provenance, terminal) =>
      Effect.gen(function* () {
        if (terminal === undefined) {
          return yield* Effect.dieMessage("missing terminal binding");
        }
        yield* store.publishCollectiveItem({
          ...terminal,
          conversation: group,
          canonicalItem: yield* encodeRuntimeValue(item),
          ...(provenance === undefined
            ? {}
            : { canonicalProvenance: yield* encodeRuntimeValue(provenance) }),
          firewall: false,
        });
        emitted.push(item);
      }).pipe(Effect.orDie),
  });
}

function appendMessage(
  store: EndpointStore,
  message: InboundMessage,
  hash: string,
  previousRecordHash: string,
) {
  const actionHash = `action:${hash}`;
  return encodeCanonical(InboundMessage, message).pipe(
    Effect.flatMap((canonicalMessage) =>
      store.applyCertifiedRecord(
        {
          ...record,
          recordHash: hash,
          previousRecordHash,
          postId: message.postId,
          authorAgentId: message.sender,
          actionHash,
          canonicalRecordCore: bytes(hash),
          actionEvidence: record.actionEvidence.map((evidence) => ({
            ...evidence,
            subjectId: actionHash,
          })),
          durabilityEvidence: record.durabilityEvidence.map((evidence) => ({
            ...evidence,
            subjectId: hash,
          })),
        },
        { recipientAgentId: "agent:alice", canonicalMessage },
      ),
    ),
  );
}

function acknowledgeGroupRequest(
  path: string,
  history: DelayedHistory,
  emitted: InboundItem[],
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const store = yield* openEndpointStore(path, {
        liveWireVersions: LIVE_WIRE_VERSIONS,
      });
      yield* seedRequest(store, history.request);
      yield* appendMessage(
        store,
        history.answer,
        answerHash,
        record.recordHash,
      );
      const collective = yield* restoringLayer(
        store,
        yield* Scope.Scope,
        emitted,
      );
      const item = yield* collective.classify({
        message: history.request,
        recordHash,
      });
      const [pending] = yield* store.readPendingDeliveries();
      if (Option.isNone(item) || pending === undefined) {
        return yield* Effect.dieMessage("missing group request");
      }
      yield* store.putInboxItem({
        deliveryToken: pending.deliveryToken,
        canonicalItem: yield* encodeRuntimeValue(item.value),
      });
      yield* store.acknowledgeInboxItem(pending.deliveryToken);
      yield* store.acknowledgeDelivery(pending.deliveryToken);
    }),
  );
}

function receiveDelayedClose(
  path: string,
  history: DelayedHistory,
  emitted: InboundItem[],
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const store = yield* openEndpointStore(path, {
        liveWireVersions: LIVE_WIRE_VERSIONS,
      });
      yield* appendMessage(
        store,
        history.close,
        digest("rch_", 44),
        answerHash,
      );
      yield* restoringLayer(store, yield* Scope.Scope, emitted);
      expect(emitted).toMatchObject([
        {
          kind: "collectiveResult",
          closedAt: 60_000,
          closedBy: "deadline",
          id,
          outcomes: [
            { member: self, outcome: { kind: "no-answer" } },
            {
              member: "agent:carol",
              outcome: { kind: "answered", content: { answer: "Monday" } },
            },
          ],
        },
      ]);
      const [item] = (yield* store.readInbox()).items;
      if (item === undefined) {
        return yield* Effect.dieMessage("missing delayed result");
      }
      return item.deliveryToken;
    }),
  );
}

function assertRetainedResult(
  path: string,
  emitted: InboundItem[],
  token: DeliveryToken,
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const store = yield* openEndpointStore(path, {
        liveWireVersions: LIVE_WIRE_VERSIONS,
      });
      yield* restoringLayer(store, yield* Scope.Scope, emitted);
      expect(emitted).toHaveLength(1);
      expect(
        (yield* store.readInbox()).items.map(
          ({ deliveryToken }) => deliveryToken,
        ),
      ).toEqual([token]);
      yield* store.acknowledgeInboxItem(token);
    }),
  );
}

function assertAcknowledgedResult(path: string, emitted: InboundItem[]) {
  return Effect.scoped(
    Effect.gen(function* () {
      const store = yield* openEndpointStore(path, {
        liveWireVersions: LIVE_WIRE_VERSIONS,
      });
      yield* restoringLayer(store, yield* Scope.Scope, emitted);
      expect((yield* store.readInbox()).items).toEqual([]);
    }),
  );
}

itOnClock(
  "keeps a consumed close before its request unknown after a physical store reopen",
  () =>
    Effect.gen(function* () {
      const path = stateDirectory();
      const emitted: InboundItem[] = [];
      const request = Schema.decodeUnknownSync(InboundMessage)({
        ...(yield* groupRequest()),
        postId: digest("pst_", 81),
      });
      const requestHash = Schema.decodeUnknownSync(RecordHash)(
        digest("rch_", 82),
      );
      const earlyClose = Schema.decodeUnknownSync(InboundMessage)({
        ...request,
        postId: record.postId,
        content: yield* encodeCollectiveContent({
          kind: "close",
          closedAt: 60_000,
          closedBy: "deadline",
          id,
          included: [],
        }),
      });
      const context = { path, emitted, request, requestHash, earlyClose };
      yield* Effect.scoped(retainCloseBeforeRequest(context));
      yield* Effect.scoped(assertUnknownCloseAfterReopen(context));
      expect(emitted).toMatchObject([{ kind: "collectiveResult", id }]);
    }),
);

interface OrderedRequest {
  readonly path: string;
  readonly emitted: InboundItem[];
  readonly request: InboundMessage;
  readonly requestHash: RecordHash;
  readonly earlyClose: InboundMessage;
}

function retainCloseBeforeRequest(context: OrderedRequest) {
  return Effect.gen(function* () {
    const { path, emitted, request, requestHash, earlyClose } = context;
    const store = yield* openEndpointStore(path, {
      liveWireVersions: LIVE_WIRE_VERSIONS,
    });
    yield* seedRequest(store, earlyClose);
    const layer = yield* restoringLayer(store, yield* Scope.Scope, emitted);
    yield* layer.classify({ message: earlyClose, recordHash });
    const early = yield* Effect.fromNullable(
      (yield* store.readPendingDeliveries())[0],
    );
    yield* store.acknowledgeDelivery(early.deliveryToken);
    yield* appendMessage(store, request, requestHash, record.recordHash);
    expect(
      Option.isSome(
        yield* layer.classify({ message: request, recordHash: requestHash }),
      ),
    ).toBe(true);
    const pending = yield* Effect.fromNullable(
      (yield* store.readPendingDeliveries())[0],
    );
    yield* store.acknowledgeDelivery(pending.deliveryToken);
  });
}

function assertUnknownCloseAfterReopen(context: OrderedRequest) {
  return Effect.gen(function* () {
    const { path, emitted, request, requestHash, earlyClose } = context;
    const store = yield* openEndpointStore(path, {
      liveWireVersions: LIVE_WIRE_VERSIONS,
    });
    const layer = yield* restoringLayer(store, yield* Scope.Scope, emitted);
    expect(emitted).toEqual([]);
    yield* assertAcknowledgedOrder(store, requestHash);
    expect(
      yield* Effect.flip(
        layer.send({
          ...response,
          to: request.address,
          collectiveResponse: { ...response.collectiveResponse, id },
        }),
      ),
    ).toMatchObject({ reason: "network-unavailable" });
    const close = Schema.decodeUnknownSync(InboundMessage)({
      ...earlyClose,
      postId: digest("pst_", 83),
    });
    const closeHash = Schema.decodeUnknownSync(RecordHash)(digest("rch_", 84));
    yield* appendMessage(store, close, closeHash, requestHash);
    yield* layer.classify({ message: close, recordHash: closeHash });
  });
}

itOnClock(
  "keeps a consumed future-deadline request rejected when restart makes its deadline admissible",
  () =>
    Effect.gen(function* () {
      const path = stateDirectory();
      const request = Schema.decodeUnknownSync(InboundMessage)({
        ...(yield* groupRequest()),
        content: yield* encodeCollectiveContent(
          {
            kind: "operation",
            op: "all_gather",
            id,
            nonce,
            deadlineAt:
              (yield* Clock.currentTimeMillis) +
              Duration.toMillis(Duration.days(32)),
            requestedSchema: { type: "object", properties: {} },
          },
          "Too far in the future",
        ),
      });
      yield* Effect.scoped(consumeRejectedRequest(path, request));
      yield* TestClock.adjust(Duration.days(7));
      const operations = yield* Effect.scoped(
        reopenRejectedRequest(path, request),
      );
      expect(operations).toEqual([]);
    }),
);

function consumeRejectedRequest(path: string, request: InboundMessage) {
  return Effect.gen(function* () {
    const store = yield* openEndpointStore(path, {
      liveWireVersions: LIVE_WIRE_VERSIONS,
    });
    yield* seedRequest(store, request);
    const layer = yield* restoringLayer(store, yield* Scope.Scope, []);
    expect(
      Option.isNone(yield* layer.classify({ message: request, recordHash })),
    ).toBe(true);
    const pending = yield* Effect.fromNullable(
      (yield* store.readPendingDeliveries())[0],
    );
    yield* store.acknowledgeDelivery(pending.deliveryToken);
  });
}

function reopenRejectedRequest(path: string, request: InboundMessage) {
  return Effect.gen(function* () {
    const store = yield* openEndpointStore(path, {
      liveWireVersions: LIVE_WIRE_VERSIONS,
    });
    const layer = yield* restoringLayer(store, yield* Scope.Scope, []);
    expect(yield* store.readCollectiveOperations()).toEqual([]);
    expect(
      yield* Effect.flip(
        layer.send({
          to: request.address,
          collectiveResponse: { id, action: "decline" },
        }),
      ),
    ).toMatchObject({ failure: { kind: "request-none" } });
    return yield* store.readCollectiveOperations();
  });
}

function assertAcknowledgedOrder(
  store: EndpointStore,
  requestHash: RecordHash,
) {
  return Effect.gen(function* () {
    const retained = yield* store.readRetainedDeliveries();
    expect(
      retained.map((delivery) => ({
        hash: delivery.recordHash,
        acknowledged: delivery.acknowledged,
      })),
    ).toEqual([
      { hash: recordHash, acknowledged: true },
      { hash: requestHash, acknowledged: true },
    ]);
  });
}
