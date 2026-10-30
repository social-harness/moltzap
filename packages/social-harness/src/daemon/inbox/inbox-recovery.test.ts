/** @file Request context and admission queues survive current-store restarts. */

import { live as it, scoped as itOnClock } from "@effect/vitest";
import {
  Clock,
  Duration,
  Effect,
  Option,
  Schema,
  Scope,
  TestClock,
} from "effect";
import { expect } from "vitest";
import type { InboundItem } from "../../host-protocol/items.js";
import { digest, testAgentView } from "../../__tests__/agent-card-fixtures.js";
import { collectiveOperationId } from "../../__tests__/collective-id-fixtures.js";
import { makeCollectiveOperations } from "../../__tests__/collective-send.js";
import { collectivePersistencePorts } from "../../__tests__/collective-storage-stub.js";
import {
  bytes,
  stateDirectory,
  storedConversation,
} from "../../__tests__/store-schema-fixtures.js";
import { encodeCollectiveContent } from "../../communication/collectives/wire/index.js";
import { SendError } from "../../communication/conversations/errors.js";
import { InboundMessage } from "../../communication/conversations/message.js";
import { RecordHash } from "../../communication/records/index.js";
import { AgentAddress } from "../../communication/records/values.js";
import {
  type DeliveryToken,
  encodeRuntimeValue,
} from "../../communication/store/index.js";
import { encodeCanonical } from "../../encoding/canonical-json.js";
import { LIVE_WIRE_VERSIONS } from "../../identity/wire-version.js";
import { type DaemonStore, openDaemonStore } from "../store.js";
import { makeHostDelivery } from "./host-delivery.js";
import { noHistoryExport } from "./host-traffic-log.js";
import { readRuntimeInbox } from "./inbox.js";

const self = Schema.decodeUnknownSync(AgentAddress)("agent:alice");
const sender = Schema.decodeUnknownSync(AgentAddress)("agent:bob");
const operationId = collectiveOperationId(testAgentView(sender).agentId, 8);
const { foundation, record } = storedConversation("pending-request");
const recordHash = Schema.decodeUnknownSync(RecordHash)(record.recordHash);
const message = () =>
  Schema.decodeUnknownSync(InboundMessage)({
    kind: "direct",
    msgId: record.msgId,
    address: sender,
    sender: testAgentView(sender),
    content: [
      { type: "text", text: "Please answer" },
      {
        type: "data",
        value: {
          "org.social-harness/collective": {
            kind: "operation",
            op: "gather",
            operationId,
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
  collectiveResponse: {
    operationId,
    action: "accept",
    content: { answer: "yes" },
  },
} as const;
const unavailable = () =>
  Effect.fail(new SendError({ reason: "network-unavailable" }));

function makeCollectives(store: DaemonStore, scope: Scope.Scope) {
  return Effect.gen(function* () {
    const persistence = yield* collectivePersistencePorts(unavailable, self);
    return yield* makeCollectiveOperations({
      ...persistence,
      store,
      self: testAgentView(self),
      scope,
      sendMessage: unavailable,
      observeMessage: unavailable,
      reportStorageFault: () => Effect.dieMessage("unexpected storage fault"),
      emit: () => Effect.dieMessage("a request emits no local result"),
    });
  });
}

function seedRequest(store: DaemonStore, request: InboundMessage) {
  return Effect.gen(function* () {
    yield* store.bindIdentity({
      agentId: testAgentView(self).agentId,
      canonicalAgentCard: bytes("identity"),
    });
    yield* store.putConversationFoundation(foundation);
    yield* store.applyCertifiedRecord(
      { ...record, authorAgentId: request.sender.agentId },
      {
        recipientAgentId: testAgentView(self).agentId,
        canonicalMessage: yield* encodeCanonical(InboundMessage, request),
      },
    );
  });
}

it("restores an acknowledged request's answer context with its original delivery identity", () => {
  const path = stateDirectory();
  return Effect.gen(function* () {
    const token = yield* Effect.scoped(
      Effect.gen(function* () {
        const store = yield* openDaemonStore(path, {
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
        const store = yield* openDaemonStore(path, {
          liveWireVersions: LIVE_WIRE_VERSIONS,
        });
        const layer = yield* makeCollectives(store, yield* Scope.Scope);
        expect(yield* Effect.flip(layer.send(response))).toEqual(
          new SendError({ reason: "network-unavailable" }),
        );
        expect((yield* store.readInboxItem(token))?.acknowledged).toBe(true);
        expect((yield* readRuntimeInbox(store, {})).items).toEqual([]);
        expect((yield* store.readCollectiveOperations())[0]).toMatchObject({
          operationId,
          origin: { kind: "remote", recordHash },
        });
      }),
    );
  });
});

it(
  "preserves a request awaiting admission and keeps it unanswerable after restart",
  preservesQueuedRequest,
);

function preservesQueuedRequest() {
  return Effect.gen(function* () {
    const path = stateDirectory();
    const queued = yield* retainQueuedRequest(path);
    yield* Effect.scoped(
      Effect.gen(function* () {
        const store = yield* openDaemonStore(path, {
          liveWireVersions: LIVE_WIRE_VERSIONS,
        });
        const layer = yield* makeCollectives(store, yield* Scope.Scope);
        const delivery = yield* makeHostDelivery({
          store,
          scope: yield* Scope.Scope,
          historyExport: noHistoryExport,
          collectives: () => layer,
        });
        expect(
          yield* Effect.flip(delivery.operations.send({ input: response })),
        ).toMatchObject({ failure: { kind: "request-none" } });
        expect(yield* store.readFirewallFrontiers()).toEqual([
          { ...queued, sequence: 1 },
        ]);
        expect((yield* store.readPendingDeliveries())[0]?.deliveryToken).toBe(
          queued.deliveryToken,
        );
      }),
    );
  });
}

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

function retainQueuedRequest(path: string) {
  return Effect.scoped(
    Effect.gen(function* () {
      const store = yield* openDaemonStore(path, {
        liveWireVersions: LIVE_WIRE_VERSIONS,
      });
      const request = message();
      yield* seedRequest(store, request);
      const layer = yield* makeCollectives(store, yield* Scope.Scope);
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
}

function groupRequest() {
  return Effect.gen(function* () {
    const content = yield* encodeCollectiveContent(
      {
        kind: "operation",
        op: "all_gather",
        operationId,
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
      msgId: record.msgId,
      sender: testAgentView(sender),
      address: group,
      members: ["agent:alice", "agent:bob", "agent:carol"].map(testAgentView),
      content,
    });
  });
}

function delayedCloseHistory() {
  return Effect.gen(function* () {
    const request = yield* groupRequest();
    const answer = Schema.decodeUnknownSync(InboundMessage)({
      ...request,
      msgId: digest("msg_", 42),
      sender: testAgentView("agent:carol"),
      content: yield* encodeCollectiveContent({
        kind: "response",
        operationId,
        action: "accept",
        content: { answer: "Monday" },
      }),
    });
    const close = Schema.decodeUnknownSync(InboundMessage)({
      ...request,
      msgId: digest("msg_", 43),
      content: yield* encodeCollectiveContent({
        kind: "close",
        closedAt: 60_000,
        closedBy: "deadline",
        operationId,
        included: [Schema.decodeUnknownSync(RecordHash)(answerHash)],
      }),
    });
    return { request, answer, close };
  });
}

function restoringLayer(
  store: DaemonStore,
  scope: Scope.Scope,
  emitted: InboundItem[],
) {
  return Effect.gen(function* () {
    const persistence = yield* collectivePersistencePorts(unavailable, self);
    return yield* makeCollectiveOperations({
      ...persistence,
      store,
      self: testAgentView(self),
      scope,
      sendMessage: unavailable,
      observeMessage: unavailable,
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
  });
}

function appendMessage(
  store: DaemonStore,
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
          msgId: message.msgId,
          authorAgentId: message.sender.agentId,
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
        { recipientAgentId: testAgentView(self).agentId, canonicalMessage },
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
      const store = yield* openDaemonStore(path, {
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
      const store = yield* openDaemonStore(path, {
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
          operationId,
          outcomes: [
            { member: testAgentView(self), outcome: { kind: "no-answer" } },
            {
              member: testAgentView("agent:carol"),
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
      const store = yield* openDaemonStore(path, {
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
      const store = yield* openDaemonStore(path, {
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
        msgId: digest("msg_", 81),
      });
      const requestHash = Schema.decodeUnknownSync(RecordHash)(
        digest("rch_", 82),
      );
      const earlyClose = Schema.decodeUnknownSync(InboundMessage)({
        ...request,
        msgId: record.msgId,
        content: yield* encodeCollectiveContent({
          kind: "close",
          closedAt: 60_000,
          closedBy: "deadline",
          operationId,
          included: [],
        }),
      });
      const context = { path, emitted, request, requestHash, earlyClose };
      yield* Effect.scoped(retainCloseBeforeRequest(context));
      yield* Effect.scoped(assertUnknownCloseAfterReopen(context));
      expect(emitted).toMatchObject([
        { kind: "collectiveResult", operationId },
      ]);
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
    const store = yield* openDaemonStore(path, {
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
    const store = yield* openDaemonStore(path, {
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
          collectiveResponse: { ...response.collectiveResponse, operationId },
        }),
      ),
    ).toMatchObject({ reason: "network-unavailable" });
    const close = Schema.decodeUnknownSync(InboundMessage)({
      ...earlyClose,
      msgId: digest("msg_", 83),
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
            operationId,
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
    const store = yield* openDaemonStore(path, {
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
    const store = yield* openDaemonStore(path, {
      liveWireVersions: LIVE_WIRE_VERSIONS,
    });
    const layer = yield* restoringLayer(store, yield* Scope.Scope, []);
    expect(yield* store.readCollectiveOperations()).toEqual([]);
    expect(
      yield* Effect.flip(
        layer.send({
          to: request.address,
          collectiveResponse: { operationId, action: "decline" },
        }),
      ),
    ).toMatchObject({ failure: { kind: "request-none" } });
    return yield* store.readCollectiveOperations();
  });
}

function assertAcknowledgedOrder(store: DaemonStore, requestHash: RecordHash) {
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
