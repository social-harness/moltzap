/** @file Daemon persistence keeps protocol, assessment and host transitions atomic across reopen. */

import { assert, live as it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { digest } from "../__tests__/agent-card-fixtures.js";
import {
  bytes,
  stateDirectory,
  storedConversation,
} from "../__tests__/store-schema-fixtures.js";
import {
  DeliveryToken,
  type EndpointStoreError,
  type OutboxTooOldError,
} from "../communication/store/index.js";
import { LIVE_WIRE_VERSIONS } from "../identity/wire-version.js";
import { type DaemonStore, openDaemonStore } from "./store.js";

/* eslint-disable agent-code-guard/no-hardcoded-assertion-literals -- Closed store rejection and lifecycle values are the behavior under test. */

const identity = {
  agentId: "agent:alice",
  canonicalAgentCard: bytes("verified local identity"),
};
const policy = bytes("installed rules");
const captured = bytes("captured outgoing draft");
const input = bytes("captured policy and evidence");
const result = bytes("settled decision");
const eventState = bytes("host consumer state");
const item = bytes("admitted host item");
const guidance = bytes("registered guidance");
const { foundation, record } = storedConversation("daemon-ownership");
const token = Schema.decodeUnknownSync(DeliveryToken)(digest("dlv_", 42));

/** Independent scopes exercise the same close/reopen boundary used by daemon restart. */
function withDaemon<Value, Failure>(
  directory: string,
  use: (store: DaemonStore) => Effect.Effect<Value, Failure>,
): Effect.Effect<Value, Failure | EndpointStoreError | OutboxTooOldError> {
  return Effect.scoped(
    openDaemonStore(directory, {
      liveWireVersions: LIVE_WIRE_VERSIONS,
    }).pipe(Effect.flatMap(use)),
  );
}

/** Certified custody supplies a real protocol delivery for cross-owner admission. */
function seedProtocol(store: DaemonStore) {
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

it("reopens all three owners and retains the settled captured candidate after context changes", () =>
  Effect.gen(function* () {
    const directory = stateDirectory();
    yield* withDaemon(directory, settleCapturedCheck);
    yield* withDaemon(directory, assertReopenedOwners);
  }));

function settleCapturedCheck(store: DaemonStore) {
  return Effect.gen(function* () {
    yield* store.beginFirewallAttempt({
      checkId: "captured-check",
      direction: "outgoing",
      canonicalCandidate: captured,
      canonicalInput: input,
    });
    yield* seedProtocol(store);
    yield* store.writeFirewallPolicy(policy);
    yield* store.putInboxItem({
      deliveryToken: token,
      canonicalItem: item,
      canonicalGuidance: guidance,
    });
    yield* store.writeEventState(eventState);
    const completion = {
      checkId: "captured-check",
      canonicalResult: result,
      admit: true,
    };
    const mismatch = yield* store
      .completeFirewallAttempt(completion, "outgoing", bytes("different draft"))
      .pipe(Effect.flip);
    assert.strictEqual(mismatch.reason, "conflict");
    assert.strictEqual(
      yield* store.completeFirewallAttempt(completion, "outgoing", captured),
      "admitted",
    );
  });
}

function assertReopenedOwners(store: DaemonStore) {
  return Effect.gen(function* () {
    assert.deepStrictEqual(yield* store.readIdentity(), identity);
    assert.deepStrictEqual(yield* store.readFirewallPolicy(), policy);
    assert.deepStrictEqual(yield* store.readEventState(), eventState);
    const retained = yield* store.readInboxItem(token);
    assert.isDefined(retained);
    assert.deepStrictEqual(retained.canonicalItem, item);
    assert.deepStrictEqual(retained.canonicalGuidance, guidance);
    const [decision] = yield* store.readFirewallDecisions();
    assert.isDefined(decision);
    assert.strictEqual(decision.disposition, "admitted");
    assert.deepStrictEqual(decision.canonicalCandidate, captured);
    assert.deepStrictEqual(decision.canonicalInput, input);
    assert.deepStrictEqual(decision.canonicalResult, result);
    const evidence = yield* store.readFirewallEvidence({
      conversationId: foundation.conversationId,
      maximumRecords: 10,
    });
    assert.deepStrictEqual(evidence.history, [
      {
        canonicalRecordCore: record.canonicalRecordCore,
        canonicalMembership: foundation.canonicalMembership,
        visible: false,
      },
    ]);
  });
}

it("rolls back incoming settlement when host publication fails and retains guidance after acknowledgment", () =>
  withDaemon(stateDirectory(), admitAfterPublicationRollback));

function queuedIncoming(store: DaemonStore) {
  return Effect.gen(function* () {
    const delivery = yield* seedProtocol(store);
    const incoming = {
      deliveryToken: delivery.deliveryToken,
      canonicalItem: item,
      canonicalGuidance: guidance,
    };
    yield* store.queueFirewallItem({ ...incoming, conversation: "agent:bob" });
    yield* store.beginFirewallAttempt({
      checkId: "incoming-check",
      direction: "incoming",
      canonicalCandidate: item,
      canonicalInput: input,
    });
    return {
      incoming,
      completion: {
        checkId: "incoming-check",
        canonicalResult: result,
        admit: true,
      },
    };
  });
}

function admitAfterPublicationRollback(store: DaemonStore) {
  return Effect.gen(function* () {
    const { incoming, completion } = yield* queuedIncoming(store);
    const rejected = yield* store
      .admitFirewallItem(
        {
          ...incoming,
          canonicalGuidance: new Uint8Array(3 * 1024 * 1024),
        },
        completion,
      )
      .pipe(Effect.flip);
    assert.strictEqual(rejected.reason, "invalid-input");
    assert.strictEqual(
      yield* store.admitFirewallItem(incoming, completion),
      "admitted",
    );
    yield* store.acknowledgeInboxItem(incoming.deliveryToken);
    const changedGuidance = yield* store
      .putInboxItem({
        ...incoming,
        canonicalGuidance: bytes("different advice"),
      })
      .pipe(Effect.flip);
    assert.strictEqual(changedGuidance.reason, "conflict");
    const retained = yield* store.readInboxItem(incoming.deliveryToken);
    assert.isDefined(retained);
    assert.isTrue(retained.acknowledged);
    assert.deepStrictEqual(retained.canonicalItem, item);
    assert.deepStrictEqual(retained.canonicalGuidance, guidance);
    assert.deepStrictEqual(
      yield* store.readFirewallRequestAdmission(record.recordHash),
      { presented: true, checkId: completion.checkId, canonicalResult: result },
    );
  });
}

it("commits collective completion with host publication and preserves its identity after reopen", () =>
  Effect.gen(function* () {
    const directory = stateDirectory();
    const delivery = yield* withDaemon(directory, publishAfterRollback);
    yield* withDaemon(directory, (store) =>
      assertReopenedTerminal(store, delivery),
    );
  }));

function publishAfterRollback(store: DaemonStore) {
  return Effect.gen(function* () {
    yield* store.bindIdentity(identity);
    yield* store.putCollectiveOperation({
      operationId: "local-operation",
      origin: { kind: "local" },
      canonicalRequest: bytes("local request"),
      canonicalDescriptor: bytes("local descriptor"),
    });
    yield* store.finalizeCollectiveOperation(
      "local-operation",
      bytes("frozen answer selection"),
    );
    const operation = yield* store.readCollectiveOperation("local-operation");
    assert.isDefined(operation);
    const terminal = {
      operationId: operation.operationId,
      deliveryToken: operation.deliveryToken,
      canonicalItem: bytes("terminal result"),
      conversation: "group:alice,bob",
      firewall: false,
    };
    const rejected = yield* store
      .publishCollectiveItem({
        ...terminal,
        canonicalItem: new Uint8Array(3 * 1024 * 1024),
      })
      .pipe(Effect.flip);
    assert.strictEqual(rejected.reason, "invalid-input");
    assert.strictEqual(
      (yield* store.readCollectiveOperation(operation.operationId))?.phase,
      "finalizing",
    );
    yield* store.publishCollectiveItem(terminal);
    yield* store.acknowledgeInboxItem(operation.deliveryToken);
    return terminal;
  });
}

function assertReopenedTerminal(
  store: DaemonStore,
  delivery: Effect.Effect.Success<ReturnType<typeof publishAfterRollback>>,
) {
  return Effect.gen(function* () {
    yield* store.publishCollectiveItem(delivery);
    const operation = yield* store.readCollectiveOperation(
      delivery.operationId,
    );
    assert.isDefined(operation);
    assert.strictEqual(operation.phase, "completed");
    assert.strictEqual(operation.deliveryToken, delivery.deliveryToken);
    const retained = yield* store.readInboxItem(delivery.deliveryToken);
    assert.isDefined(retained);
    assert.isTrue(retained.acknowledged);
    assert.deepStrictEqual(retained.canonicalItem, delivery.canonicalItem);
  });
}

/* eslint-enable agent-code-guard/no-hardcoded-assertion-literals -- Restore repository defaults. */
