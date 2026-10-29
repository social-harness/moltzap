/**
 * @file Collective ownership and publication stay atomic with their durable post intents.
 */

import { live as it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";
import type {
  CollectiveOperationInput,
  DeliveryToken,
  EndpointStore,
  PostIntent,
} from "./index.js";
import {
  bytes,
  stateDirectory,
  storedConversation,
  withStore,
} from "../../__tests__/store-schema-fixtures.js";

const { foundation, record } = storedConversation("collective-request");
const request = bytes("authenticated request bytes");
const remote: CollectiveOperationInput = {
  operationId: "remote-operation",
  origin: {
    kind: "remote",
    recordHash: record.recordHash,
    requiresAdmission: true,
  },
  canonicalRequest: request,
  canonicalDescriptor: bytes("received request"),
};
const local: CollectiveOperationInput = {
  operationId: "local-operation",
  origin: { kind: "local" },
  canonicalRequest: bytes("authored request"),
  canonicalDescriptor: bytes("complete local descriptor"),
};
const intent = (postId: string): PostIntent => ({
  authorAgentId: "agent:alice",
  postId,
  conversationId: foundation.conversationId,
  membershipHash: foundation.membershipHash,
  canonicalIntent: bytes(postId),
});

function seed(store: EndpointStore) {
  return Effect.gen(function* () {
    yield* store.bindIdentity({
      agentId: "agent:alice",
      canonicalAgentCard: bytes("identity"),
    });
    yield* store.putConversationFoundation(foundation);
    yield* store.applyCertifiedRecord(record, {
      recipientAgentId: "agent:alice",
      canonicalMessage: request,
    });
    const [delivery] = yield* store.readPendingDeliveries();
    if (delivery === undefined) {
      return yield* Effect.dieMessage("missing certified request");
    }
    return delivery;
  });
}

// @agent-code-guard/regression-only: transaction and reopen cases exercise immutable identity, admission, selection, and query boundaries.
it("binds a collective id to one authenticated origin and exact request bytes across reopen", () =>
  Effect.gen(function* () {
    const path = stateDirectory();
    yield* withStore(path, rejectChangedOrigin);
    const retained = yield* withStore(path, assertRetainedOrigins);
    expect(retained).toHaveLength(2);
  }));

it("requires an accepted request and admission before atomically claiming one response intent", () =>
  Effect.gen(function* () {
    const path = stateDirectory();
    yield* withStore(path, claimAdmittedAnswer);
    const posts = yield* withStore(path, (store) =>
      store.readCollectivePosts(),
    );
    expect(
      posts.map((post) => ({ role: post.role, postId: post.intent.postId })),
    ).toEqual([{ role: "response", postId: "first-answer" }]);
  }));

it("freezes answer references and commits one close and terminal token without resurrection after acknowledgment", () =>
  Effect.gen(function* () {
    const path = stateDirectory();
    const token = yield* withStore(path, freezeAndPublish);
    yield* withStore(path, (store) => assertCompleted(store, token));
  }));

it("reads one retained operation and only the post roles requested for that operation", () =>
  Effect.gen(function* () {
    const found = yield* withStore(stateDirectory(), readOperationQueries);
    expect(found).toMatchObject({
      local: { ...local, phase: "finalizing" },
      remote: { operationId: remote.operationId, phase: "collecting" },
      requests: ["local-request"],
      localPosts: ["local-request", "first-close"],
      responses: ["remote-response"],
    });
  }));

function readOperationQueries(store: EndpointStore) {
  return Effect.gen(function* () {
    const delivery = yield* seed(store);
    yield* store.putCollectiveOperation(local);
    yield* store.putCollectiveOperation(remote);
    yield* store.putInboxItem({
      deliveryToken: delivery.deliveryToken,
      canonicalItem: bytes("admitted request"),
    });
    yield* store.bindPostIntent({
      kind: "existing-conversation",
      intent: intent("local-request"),
      collective: {
        operationId: local.operationId,
        role: "request",
        destination: "agent:bob",
      },
    });
    yield* store.bindPostIntent({
      kind: "existing-conversation",
      intent: intent("remote-response"),
      collective: {
        operationId: remote.operationId,
        role: "response",
        destination: "agent:bob",
      },
    });
    yield* bindFrozenClose(store);
    return {
      local: yield* store.readCollectiveOperation(local.operationId),
      remote: yield* store.readCollectiveOperation(remote.operationId),
      requests: (yield* store.readCollectivePosts({
        operationId: local.operationId,
        role: "request",
      })).map((post) => post.intent.postId),
      localPosts: (yield* store.readCollectivePosts({
        operationId: local.operationId,
      })).map((post) => post.intent.postId),
      responses: (yield* store.readCollectivePosts({
        operationId: remote.operationId,
        role: "response",
      })).map((post) => post.intent.postId),
    };
  });
}

function rejectChangedOrigin(store: EndpointStore) {
  return Effect.gen(function* () {
    yield* seed(store);
    yield* store.putCollectiveOperation(local);
    expect(
      yield* Effect.flip(
        store.putCollectiveOperation({
          ...remote,
          operationId: local.operationId,
        }),
      ),
    ).toMatchObject({ reason: "conflict" });
    expect(
      yield* Effect.flip(
        store.putCollectiveOperation({
          ...remote,
          canonicalRequest: bytes("changed peer bytes"),
        }),
      ),
    ).toMatchObject({ reason: "conflict" });
    yield* store.putCollectiveOperation(remote);
  });
}

function assertRetainedOrigins(store: EndpointStore) {
  return Effect.gen(function* () {
    yield* store.putCollectiveOperation(local);
    yield* store.putCollectiveOperation(remote);
    expect(
      yield* Effect.flip(
        store.putCollectiveOperation({
          ...remote,
          canonicalDescriptor: bytes("different request context"),
        }),
      ),
    ).toMatchObject({ reason: "conflict" });
    expect(
      (yield* store.readCollectiveOperations()).map(
        ({ operationId, creatorAgentId }) => ({ operationId, creatorAgentId }),
      ),
    ).toEqual([
      { operationId: local.operationId, creatorAgentId: "agent:alice" },
      { operationId: remote.operationId, creatorAgentId: record.authorAgentId },
    ]);
    return yield* store.readCollectiveOperations();
  });
}

function claimAdmittedAnswer(store: EndpointStore) {
  return Effect.gen(function* () {
    const delivery = yield* seed(store);
    const binding = {
      kind: "existing-conversation",
      intent: intent("first-answer"),
      collective: {
        operationId: remote.operationId,
        role: "response",
        destination: "agent:bob",
      },
    } as const;
    expect(yield* Effect.flip(store.bindPostIntent(binding))).toMatchObject({
      reason: "not-found",
    });
    yield* store.putCollectiveOperation(remote);
    expect(yield* Effect.flip(store.bindPostIntent(binding))).toMatchObject({
      reason: "conflict",
    });
    expect((yield* store.recover()).postIntents).toEqual([]);
    yield* store.putInboxItem({
      deliveryToken: delivery.deliveryToken,
      canonicalItem: bytes("admitted request"),
    });
    yield* store.bindPostIntent(binding);
    expect(
      yield* Effect.flip(
        store.bindPostIntent({
          ...binding,
          intent: intent("second-answer"),
          collective: {
            ...binding.collective,
            destination: "another-spelling",
          },
        }),
      ),
    ).toMatchObject({ reason: "conflict" });
    expect(
      (yield* store.recover()).postIntents.map(({ postId }) => postId),
    ).toEqual(["first-answer"]);
  });
}

function freezeAndPublish(store: EndpointStore) {
  return Effect.gen(function* () {
    yield* seed(store);
    yield* store.putCollectiveOperation(local);
    expect(
      yield* store.recordCollectiveAnswer({
        operationId: local.operationId,
        member: "agent:bob",
        recordHash: record.recordHash,
      }),
    ).toBe(record.recordHash);
    yield* bindFrozenClose(store);
    const [operation] = yield* store.readCollectiveOperations();
    if (operation === undefined) {
      return yield* Effect.dieMessage("missing operation");
    }
    const terminal = terminalItem(operation.deliveryToken);
    expect(
      yield* Effect.flip(
        store.publishCollectiveItem({
          ...terminal,
          canonicalItem: new Uint8Array(2 * 1024 * 1024 + 1),
        }),
      ),
    ).toMatchObject({ reason: "invalid-input" });
    expect((yield* store.readCollectiveOperations())[0]).toMatchObject({
      phase: "finalizing",
    });
    yield* store.publishCollectiveItem(terminal);
    yield* store.acknowledgeInboxItem(operation.deliveryToken);
    return operation.deliveryToken;
  });
}

function bindFrozenClose(store: EndpointStore) {
  return Effect.gen(function* () {
    const close = {
      kind: "existing-conversation",
      intent: intent("first-close"),
      collective: {
        operationId: local.operationId,
        role: "close",
        destination: "group:alice,bob,carol",
      },
    } as const;
    expect(yield* Effect.flip(store.bindPostIntent(close))).toMatchObject({
      reason: "conflict",
    });
    yield* store.finalizeCollectiveOperation(
      local.operationId,
      bytes("frozen answer references"),
    );
    yield* store.bindPostIntent(close);
    expect(
      yield* Effect.flip(
        store.bindPostIntent({ ...close, intent: intent("second-close") }),
      ),
    ).toMatchObject({ reason: "conflict" });
  });
}

function assertCompleted(store: EndpointStore, token: DeliveryToken) {
  return Effect.gen(function* () {
    yield* store.publishCollectiveItem(terminalItem(token));
    expect((yield* store.readCollectiveOperations())[0]).toMatchObject({
      phase: "completed",
      deliveryToken: token,
    });
    expect((yield* store.readInboxItem(token))?.acknowledged).toBe(true);
    expect((yield* store.readInbox()).items).toEqual([]);
    expect(
      (yield* store.readCollectivePosts()).map((post) => post.intent.postId),
    ).toEqual(["first-close"]);
  });
}

function terminalItem(deliveryToken: DeliveryToken) {
  return {
    operationId: local.operationId,
    deliveryToken,
    canonicalItem: bytes("terminal result"),
    conversation: "group:alice,bob,carol",
    firewall: false,
  };
}
