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
} from "../../communication/collectives/part/index.js";
import { SendError } from "../../communication/conversations/errors.js";
import { InboundMessage } from "../../communication/conversations/message.js";
import { RecordHash } from "../../communication/records/index.js";
import { AgentAddress } from "../../communication/records/values.js";
import {
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
    sendAdmitted: unavailable,
    observePost: unavailable,
    reportStorageFault: () => Effect.dieMessage("unexpected storage fault"),
    emit: () => Effect.dieMessage("a request emits no local result"),
    ...(firewall
      ? {
          admission: {
            bindPost: <E>(
              _: unknown,
              hold: Effect.Effect<Effect.Effect<void>, E>,
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
      const group = "group:alice,bob,carol";
      const members = ["agent:alice", "agent:bob", "agent:carol"];
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
      const request = Schema.decodeUnknownSync(InboundMessage)({
        kind: "group",
        postId: record.postId,
        sender,
        address: group,
        members,
        content,
      });
      const answerHash = digest("rch_", 41);
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
          id,
          included: [Schema.decodeUnknownSync(RecordHash)(answerHash)],
        }),
      });
      const emitted: InboundItem[] = [];
      function layer(store: EndpointStore, scope: Scope.Scope) {
        return makeCollectiveOperations({
          store,
          self,
          scope,
          lookupMember: () => Effect.void,
          sendPost: unavailable,
          sendAdmitted: unavailable,
          observePost: unavailable,
          reportStorageFault: () =>
            Effect.dieMessage("unexpected storage fault"),
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
                  : {
                      canonicalProvenance:
                        yield* encodeRuntimeValue(provenance),
                    }),
                firewall: false,
              });
              emitted.push(item);
            }).pipe(Effect.orDie),
        });
      }
      function append(
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
                durabilityEvidence: record.durabilityEvidence.map(
                  (evidence) => ({ ...evidence, subjectId: hash }),
                ),
              },
              { recipientAgentId: "agent:alice", canonicalMessage },
            ),
          ),
        );
      }
      yield* Effect.scoped(
        Effect.gen(function* () {
          const store = yield* openEndpointStore(path, {
            liveWireVersions: LIVE_WIRE_VERSIONS,
          });
          yield* seedRequest(store, request);
          yield* append(store, answer, answerHash, record.recordHash);
          const collective = yield* layer(store, yield* Scope.Scope);
          const item = yield* collective.classify({
            message: request,
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
      yield* TestClock.adjust(Duration.hours(2));
      const token = yield* Effect.scoped(
        Effect.gen(function* () {
          const store = yield* openEndpointStore(path, {
            liveWireVersions: LIVE_WIRE_VERSIONS,
          });
          yield* append(store, close, digest("rch_", 44), answerHash);
          yield* layer(store, yield* Scope.Scope);
          expect(emitted).toMatchObject([
            {
              kind: "collectiveResult",
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
      yield* Effect.scoped(
        Effect.gen(function* () {
          const store = yield* openEndpointStore(path, {
            liveWireVersions: LIVE_WIRE_VERSIONS,
          });
          yield* layer(store, yield* Scope.Scope);
          expect(emitted).toHaveLength(1);
          expect(
            (yield* store.readInbox()).items.map(
              ({ deliveryToken }) => deliveryToken,
            ),
          ).toEqual([token]);
          yield* store.acknowledgeInboxItem(token);
        }),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const store = yield* openEndpointStore(path, {
            liveWireVersions: LIVE_WIRE_VERSIONS,
          });
          yield* layer(store, yield* Scope.Scope);
          expect(emitted).toHaveLength(1);
          expect((yield* store.readInbox()).items).toEqual([]);
        }),
      );
    }),
);
