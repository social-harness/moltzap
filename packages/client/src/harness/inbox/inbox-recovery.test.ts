/**
 * @file A pending collective request delivery stays answerable across a
 * restart of a current store, and one still waiting for firewall admission
 * retires unseen.
 */

import { live as it } from "@effect/vitest";
import { Effect, Encoding, Option, Schema, Scope } from "effect";
import { expect } from "vitest";
import { digest } from "../../__tests__/agent-card-fixtures.js";
import {
  bytes,
  stateDirectory,
  storedConversation,
} from "../../__tests__/store-schema-fixtures.js";
import { makeCollectiveOperations } from "../../communication/collectives/index.js";
import { collectiveIdOf } from "../../communication/collectives/part/index.js";
import { InboundMessage } from "../../communication/conversations/message.js";
import { PostId, RecordHash } from "../../communication/records/index.js";
import { AgentAddress } from "../../communication/records/values.js";
import {
  decodeRuntimeValue,
  DeliveryToken,
  encodeRuntimeValue,
  type EndpointStore,
  openEndpointStore,
} from "../../communication/store/index.js";
import { LIVE_WIRE_VERSIONS } from "../../identity/wire-version.js";
import { readRuntimeInbox, recoverRuntimeInbox } from "./inbox.js";

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
const makeCollectives = (counter: { count: number }, scope: Scope.Scope) =>
  makeCollectiveOperations({
    self,
    lookupMember: () => Effect.void,
    sendPost: () =>
      Effect.sync(() => {
        counter.count += 1;
        return {
          postId: Schema.decodeUnknownSync(PostId)(
            digest("pst_", counter.count + 10),
          ),
          recordHash,
        };
      }),
    emit: () => Effect.void,
    scope,
  });
/**
 * Give the store alice's identity and Bob's gather request as a certified
 * record whose delivery is still pending.
 */
const seedRequest = (store: EndpointStore, request: InboundMessage) =>
  Effect.gen(function* () {
    yield* store.bindIdentity({
      agentId: "agent:alice",
      canonicalAgentCard: bytes("identity"),
    });
    yield* store.putConversationFoundation(foundation);
    yield* store.applyCertifiedRecord(record, {
      recipientAgentId: "agent:alice",
      canonicalMessage: bytes(JSON.stringify(request)),
    });
  });

/** Store Bob's request, still unanswered, and return what the store recovers. */
const storeRequest = (path: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const store = yield* openEndpointStore(path, {
        liveWireVersions: LIVE_WIRE_VERSIONS,
      });
      yield* seedRequest(store, message());
      return yield* store.recover();
    }),
  );

const preservesUnprojectedRequest = () => {
  const path = stateDirectory();
  const counter = { count: 0 };
  return Effect.gen(function* () {
    const before = yield* storeRequest(path);
    yield* Effect.scoped(
      Effect.gen(function* () {
        const store = yield* openEndpointStore(path, {
          liveWireVersions: LIVE_WIRE_VERSIONS,
        });
        yield* recoverRuntimeInbox(store);
        const pending = yield* store.readPendingDeliveries();
        expect(pending).toEqual(before.pendingDeliveries);
        expect((yield* readRuntimeInbox(store, {})).items).toEqual([]);
        const entry = yield* Effect.fromNullable(pending[0]).pipe(
          Effect.orElse(() =>
            Effect.dieMessage(
              "expected the unprojected request to remain pending",
            ),
          ),
        );
        const restarted = makeCollectives(counter, yield* Scope.Scope);
        const item = yield* restarted.classify({
          message: yield* decodeRuntimeValue(
            InboundMessage,
            entry.canonicalMessage,
          ),
          recordHash,
        });
        expect(Option.getOrNull(item)).toMatchObject({
          kind: "collectiveRequest",
          id,
        });
        yield* restarted.send(response, "result");
        expect(counter.count).toBe(1);
      }),
    );
  });
};

it(
  "keeps an unprojected request answerable after restart of a current store",
  preservesUnprojectedRequest,
);

it("retires a request still waiting for admission, and its raw delivery, without a failure", () => {
  const path = stateDirectory();
  const counter = { count: 0 };
  return Effect.gen(function* () {
    yield* queueRequestBeforeRestart(path, counter);
    yield* Effect.scoped(
      Effect.gen(function* () {
        const store = yield* openEndpointStore(path, {
          liveWireVersions: LIVE_WIRE_VERSIONS,
        });
        yield* recoverRuntimeInbox(store, true);
        expect(yield* store.readPendingDeliveries()).toEqual([]);
        expect((yield* readRuntimeInbox(store, {})).items).toEqual([]);
        expect(yield* store.readFirewallFrontiers()).toEqual([]);
        yield* recoverRuntimeInbox(store, true);
        expect(yield* store.readFirewallFrontiers()).toEqual([]);
      }),
    );
  });
});

function queueRequestBeforeRestart(path: string, counter: { count: number }) {
  return Effect.scoped(
    Effect.gen(function* () {
      const store = yield* openEndpointStore(path, {
        liveWireVersions: LIVE_WIRE_VERSIONS,
      });
      const request = message();
      yield* seedRequest(store, request);
      const pending = yield* store.readPendingDeliveries();
      const entry = pending[0];
      if (entry === undefined) {
        return yield* Effect.dieMessage("missing request delivery");
      }
      const collectives = makeCollectives(counter, yield* Scope.Scope);
      const classified = yield* collectives.classify({
        message: request,
        recordHash,
      });
      if (Option.isNone(classified)) {
        return yield* Effect.dieMessage("missing classified request");
      }
      yield* store.queueFirewallItem({
        deliveryToken: entry.deliveryToken,
        conversation: "agent:bob",
        canonicalItem: yield* encodeRuntimeValue(classified.value),
      });
    }),
  );
}

it("delivers retained collective results with historical approval holds", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const store = yield* openEndpointStore(stateDirectory(), {
        liveWireVersions: LIVE_WIRE_VERSIONS,
      });
      const withheld = {
        kind: "withheld",
        checkId: `chk_${"a".repeat(64)}`,
        reason: "approval-required",
      };
      const item = {
        kind: "collectiveResult",
        op: "gather",
        id,
        to: sender,
        question: withheld,
        outcomes: [{ member: sender, outcome: withheld }],
      };
      yield* store.putInboxItem({
        deliveryToken: Schema.decodeUnknownSync(DeliveryToken)(
          digest("dlv_", 99),
        ),
        canonicalItem: yield* encodeRuntimeValue(item),
      });
      const projected = { ...withheld, reason: "unresolved-evidence" };
      expect((yield* readRuntimeInbox(store, {})).items).toMatchObject([
        {
          item: {
            ...item,
            question: projected,
            outcomes: [{ member: sender, outcome: projected }],
          },
        },
      ]);
    }),
  ));
