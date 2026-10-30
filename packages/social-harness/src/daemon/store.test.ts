/** @file Completed policy decisions and immutable host views survive rollback, acknowledgment and restart. */

import { assert, live as it } from "@effect/vitest";
import { Effect } from "effect";
import type { FirewallCompletion } from "../firewall/store/index.js";
import type { CollectiveDelivery } from "./inbox/store.js";
import {
  bytes,
  stateDirectory,
  storedConversation,
  type TestStore,
  withDaemonStore,
} from "../__tests__/store-schema-fixtures.js";
import * as Evidence from "./inbox/evidence.js";

const identity = {
  agentId: "agent:alice",
  canonicalAgentCard: bytes("local identity"),
};
const policy = bytes("installed rules");
const candidate = bytes("captured candidate");
const input = bytes("captured policy and evidence");
const result = bytes("completed judgment");
const guidance = bytes("registered guidance");
const { foundation, record } = storedConversation("daemon-persistence");
const completion: FirewallCompletion = {
  checkId: "completed-check",
  direction: "incoming",
  canonicalCandidate: candidate,
  canonicalInput: input,
  canonicalResult: result,
  admit: true,
};

it(
  "retains completed check input and the saved policy across restart",
  retainsCompletedCheck,
);
it("rolls back a failed host publication and preserves the saved content and guidance after acknowledgment", () =>
  withDaemonStore(stateDirectory(), retainsMessageView));
it(
  "commits collective completion with its host item and retains its identity after reopen",
  retainsCollectiveResult,
);

function retainsCompletedCheck() {
  return Effect.gen(function* () {
    const directory = stateDirectory();
    yield* withDaemonStore(directory, saveCompletedCheck);
    yield* withDaemonStore(directory, expectCompletedCheck);
  });
}
function saveCompletedCheck(store: TestStore) {
  return Effect.gen(function* () {
    yield* store.writeFirewallPolicy(policy);
    yield* store.saveCheckDecision(completion);
    const rejected = yield* store
      .saveCheckDecision({
        ...completion,
        canonicalCandidate: bytes("changed candidate"),
      })
      .pipe(Effect.flip);
    assert.include(rejected, { reason: "conflict" });
  });
}
function expectCompletedCheck(store: TestStore) {
  return Effect.gen(function* () {
    assert.deepStrictEqual(yield* store.readFirewallPolicy(), policy);
    const [saved] = yield* store.readFirewallDecisions();
    assert.isDefined(saved);
    assert.deepStrictEqual(saved.canonicalCandidate, candidate);
    assert.deepStrictEqual(saved.canonicalInput, input);
    assert.deepStrictEqual(saved.canonicalResult, result);
  });
}
function retainsMessageView(store: TestStore) {
  return Effect.gen(function* () {
    const delivery = yield* seedProtocol(store);
    const item = {
      deliveryToken: delivery.deliveryToken,
      canonicalItem: candidate,
      canonicalGuidance: guidance,
    };
    yield* store.queueFirewallItem({ ...item, conversation: "agent:bob" });
    const rejected = yield* store
      .saveMessageDecision(
        { ...item, canonicalGuidance: new Uint8Array(3 * 1024 * 1024) },
        completion,
      )
      .pipe(Effect.flip);
    assert.include(rejected, { reason: "invalid-input" });
    yield* store.saveMessageDecision(item, completion);
    yield* store.acknowledgeInboxItem(item.deliveryToken);
    const changed = yield* store
      .putInboxItem({ ...item, canonicalGuidance: bytes("changed guidance") })
      .pipe(Effect.flip);
    assert.include(changed, { reason: "conflict" });
    const retained = yield* store.readInboxItem(item.deliveryToken);
    assert.isDefined(retained);
    assert.isTrue(retained.acknowledged);
    assert.deepStrictEqual(retained.canonicalItem, candidate);
    assert.deepStrictEqual(retained.canonicalGuidance, guidance);
    assert.deepStrictEqual(
      yield* Evidence.readFirewallRequestAdmission(record.recordHash),
      { presented: true, checkId: completion.checkId, canonicalResult: result },
    );
    const [view] = yield* store.readHistoryViews([
      {
        conversationId: foundation.conversationId,
        recordHash: record.recordHash,
      },
    ]);
    assert.isDefined(view);
    assert.deepStrictEqual(view.canonicalItem, candidate);
    assert.deepStrictEqual(view.canonicalGuidance, guidance);
  });
}
/** Certification supplies a real delivery identity for the daemon's pending queue. */
function seedProtocol(store: TestStore) {
  return Effect.gen(function* () {
    yield* store.bindIdentity(identity);
    yield* store.putConversationFoundation(foundation);
    yield* store.applyCertifiedRecord(record, {
      recipientAgentId: identity.agentId,
      canonicalMessage: bytes("verified peer message"),
    });
    const [delivery] = yield* store.readPendingDeliveries();
    assert.isDefined(delivery);
    return delivery;
  });
}
function retainsCollectiveResult() {
  return Effect.gen(function* () {
    const directory = stateDirectory();
    const terminal = yield* withDaemonStore(directory, publishCollectiveResult);
    yield* withDaemonStore(directory, (store) =>
      expectCollectiveResult(store, terminal),
    );
  });
}
function publishCollectiveResult(store: TestStore) {
  return Effect.gen(function* () {
    yield* store.bindIdentity(identity);
    yield* store.putCollectiveOperation({
      operationId: "local-operation",
      origin: { kind: "local" },
      canonicalRequest: bytes("question"),
      canonicalDescriptor: bytes("descriptor"),
    });
    yield* store.finalizeCollectiveOperation(
      "local-operation",
      bytes("selected answers"),
    );
    const operation = yield* store.readCollectiveOperation("local-operation");
    assert.isDefined(operation);
    const delivery: CollectiveDelivery = {
      operationId: operation.operationId,
      deliveryToken: operation.deliveryToken,
      canonicalItem: bytes("result"),
      conversation: "group:alice,bob",
      firewall: false,
    };
    const rejected = yield* store
      .publishCollectiveItem({
        ...delivery,
        canonicalItem: new Uint8Array(3 * 1024 * 1024),
      })
      .pipe(Effect.flip);
    assert.include(rejected, { reason: "invalid-input" });
    const pending = yield* store.readCollectiveOperation(operation.operationId);
    assert.isDefined(pending);
    assert.include(pending, { phase: "finalizing" });
    yield* store.publishCollectiveItem(delivery);
    yield* store.acknowledgeInboxItem(delivery.deliveryToken);
    return delivery;
  });
}
function expectCollectiveResult(
  store: TestStore,
  terminal: CollectiveDelivery,
) {
  return Effect.gen(function* () {
    yield* store.publishCollectiveItem(terminal);
    const operation = yield* store.readCollectiveOperation(
      terminal.operationId,
    );
    assert.isDefined(operation);
    assert.include(operation, { phase: "completed" });
    const retained = yield* store.readInboxItem(terminal.deliveryToken);
    assert.isDefined(retained);
    assert.isTrue(retained.acknowledged);
    assert.deepStrictEqual(retained.canonicalItem, terminal.canonicalItem);
  });
}
