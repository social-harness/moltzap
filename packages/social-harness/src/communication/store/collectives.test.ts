/**
 * @file Collective identities and message claims survive protocol store reopening.
 */

import { live as it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";
import type {
  CollectiveOperationInput,
  EndpointStore,
  MessageIntent,
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
const intent = (msgId: string): MessageIntent => ({
  authorAgentId: "agent:alice",
  msgId,
  conversationId: foundation.conversationId,
  membershipHash: foundation.membershipHash,
  canonicalIntent: bytes(msgId),
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

// @agent-code-guard/regression-only: transaction and reopen cases exercise immutable identity, selection, and query boundaries.
it("binds a collective id to one authenticated origin and exact request bytes across reopen", () =>
  Effect.gen(function* () {
    const path = stateDirectory();
    yield* withStore(path, rejectChangedOrigin);
    const retained = yield* withStore(path, assertRetainedOrigins);
    expect(retained).toHaveLength(2);
  }));

it("requires an accepted request before atomically claiming one response intent", () =>
  Effect.gen(function* () {
    const path = stateDirectory();
    yield* withStore(path, claimAnswer);
    const messages = yield* withStore(path, (store) =>
      store.readCollectiveMessages(),
    );
    expect(
      messages.map((message) => ({
        role: message.role,
        msgId: message.intent.msgId,
      })),
    ).toEqual([{ role: "response", msgId: "first-answer" }]);
  }));

it("reads one retained operation and only the message roles requested for that operation", () =>
  Effect.gen(function* () {
    const found = yield* withStore(stateDirectory(), readOperationQueries);
    expect(found).toMatchObject({
      local: { ...local, phase: "finalizing" },
      remote: { operationId: remote.operationId, phase: "collecting" },
      requests: ["local-request"],
      localMessages: ["local-request", "first-close"],
      responses: ["remote-response"],
    });
  }));

function readOperationQueries(store: EndpointStore) {
  return Effect.gen(function* () {
    yield* seed(store);
    yield* store.putCollectiveOperation(local);
    yield* store.putCollectiveOperation(remote);
    yield* store.bindMessageIntent({
      kind: "existing-conversation",
      intent: intent("local-request"),
      collective: {
        operationId: local.operationId,
        role: "request",
        destination: "agent:bob",
      },
    });
    yield* store.bindMessageIntent({
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
      requests: (yield* store.readCollectiveMessages({
        operationId: local.operationId,
        role: "request",
      })).map((message) => message.intent.msgId),
      localMessages: (yield* store.readCollectiveMessages({
        operationId: local.operationId,
      })).map((message) => message.intent.msgId),
      responses: (yield* store.readCollectiveMessages({
        operationId: remote.operationId,
        role: "response",
      })).map((message) => message.intent.msgId),
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

function claimAnswer(store: EndpointStore) {
  return Effect.gen(function* () {
    yield* seed(store);
    const binding = {
      kind: "existing-conversation",
      intent: intent("first-answer"),
      collective: {
        operationId: remote.operationId,
        role: "response",
        destination: "agent:bob",
      },
    } as const;
    expect(yield* Effect.flip(store.bindMessageIntent(binding))).toMatchObject({
      reason: "not-found",
    });
    yield* store.putCollectiveOperation(remote);
    yield* store.bindMessageIntent(binding);
    expect(
      yield* Effect.flip(
        store.bindMessageIntent({
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
      (yield* store.recover()).messageIntents.map(({ msgId }) => msgId),
    ).toEqual(["first-answer"]);
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
    expect(yield* Effect.flip(store.bindMessageIntent(close))).toMatchObject({
      reason: "conflict",
    });
    yield* store.finalizeCollectiveOperation(
      local.operationId,
      bytes("frozen answer references"),
    );
    yield* store.bindMessageIntent(close);
    expect(
      yield* Effect.flip(
        store.bindMessageIntent({ ...close, intent: intent("second-close") }),
      ),
    ).toMatchObject({ reason: "conflict" });
  });
}
