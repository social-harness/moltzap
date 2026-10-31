/** @file Runtime state survives store restart. */

import { live as it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { describe, expect } from "vitest";
import { digest } from "../__tests__/agent-card-fixtures.js";
import {
  bytes,
  stateDirectory,
  storedConversation,
  type TestStore,
  withDaemonStore,
} from "../__tests__/store-schema-fixtures.js";
import { DeliveryToken } from "../communication/store/index.js";
import { WIRE_VERSION } from "../identity/wire-version.js";
import { inspectEndpointStore } from "./store.js";
const token = Schema.decodeUnknownSync(DeliveryToken)(digest("dlv_", 1));
const identity = {
  agentId: "agent:alice",
  canonicalAgentCard: new Uint8Array([1, 2, 3]),
};
const { foundation, record } = storedConversation("restart");
const eventState = bytes('{"subscription":"private"}');
const inboxItem = bytes('{"kind":"operationFailed"}');
/**
 * Give the store Alice's identity, one certified conversation with a pending
 * delivery, a proposal lock, a message intent and a queued envelope, plus the
 * host's inbox and event state, and return the queued envelope's
 * outbox identity.
 */
const seedState = (store: TestStore) =>
  Effect.gen(function* () {
    yield* store.bindIdentity(identity);
    yield* store.putConversationFoundation(foundation);
    yield* store.bindMessageIntent({
      kind: "existing-conversation",
      intent: {
        conversationId: foundation.conversationId,
        membershipHash: foundation.membershipHash,
        authorAgentId: identity.agentId,
        msgId: digest("msg_", 2),
        canonicalIntent: bytes("intent"),
      },
    });
    yield* store.lockProposal({
      conversationId: foundation.conversationId,
      actionHash: record.actionHash,
      canonicalActionCore: bytes("action-core"),
    });
    yield* store.applyCertifiedRecord(record, {
      recipientAgentId: identity.agentId,
      canonicalMessage: bytes("delivery"),
    });
    const outbound = yield* store.enqueueOutbound({
      conversationId: foundation.conversationId,
      envelopeId: "env_restart",
      wireVersion: WIRE_VERSION,
      canonicalSignedMessage: bytes("plaintext outer envelope"),
    });
    yield* store.writeEventState(eventState);
    yield* store.putInboxItem({
      deliveryToken: token,
      canonicalItem: inboxItem,
    });
    return outbound.envelopeId;
  });
function reportsHowCurrentStoreOpens() {
  const path = stateDirectory();
  return Effect.gen(function* () {
    const absent = yield* inspectEndpointStore(path);
    yield* withDaemonStore(path, seedState);
    const current = yield* inspectEndpointStore(path);
    expect([absent, current]).toEqual(["create", "reopen"]);
    expect(
      yield* withDaemonStore(path, (store) => store.readIdentity()),
    ).toEqual(identity);
  });
}
function preservesStateAcrossRestart() {
  const path = stateDirectory();
  return Effect.gen(function* () {
    yield* withDaemonStore(path, seedState);
    const before = yield* withDaemonStore(path, (store) => store.recover());
    yield* withDaemonStore(path, (store) =>
      Effect.gen(function* () {
        expect(yield* store.readIdentity()).toEqual(identity);
        expect(yield* store.recover()).toEqual(before);
        expect(yield* store.readEventState()).toEqual(eventState);
        expect((yield* store.readInbox()).items[0]?.canonicalItem).toEqual(
          inboxItem,
        );
      }),
    );
  });
}
describe("endpoint runtime state", () => {
  it(
    "preserves identity, protocol and admitted runtime state across restart",
    preservesStateAcrossRestart,
  );
  it(
    "reports creation and reopening without changing stored identity",
    reportsHowCurrentStoreOpens,
  );
});
