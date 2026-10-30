/** @file Runtime state and interrupted admission checks survive store restart. */

import { live as it } from "@effect/vitest";
import { Array, Effect, Schema } from "effect";
import { describe, expect } from "vitest";
import type {
  FirewallHistoryEntry,
  FirewallLocalEntry,
} from "../firewall/store/types.js";
import type { DaemonStore } from "./store.js";
import { digest } from "../__tests__/agent-card-fixtures.js";
import {
  bytes,
  stateDirectory,
  storedConversation,
  withDaemonStore,
} from "../__tests__/store-schema-fixtures.js";
import {
  type CertifiedRecord,
  DeliveryToken,
  inspectEndpointStore,
} from "../communication/store/index.js";
import { WIRE_VERSION } from "../identity/wire-version.js";

/* eslint-disable agent-code-guard/no-hardcoded-assertion-literals -- Store mutation outcomes and recovery state are the contract under test. */

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
const seedState = (store: DaemonStore) =>
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
        expect(
          (yield* store.readFirewallEvidence({
            conversationId: foundation.conversationId,
            maximumRecords: 10,
          })).pendingOutgoing,
        ).toBe(true);
      }),
    );
  });
}

function scopesUnresolvedSendEvidenceToEachSlicesConversation() {
  const other = storedConversation("other-slice");
  const otherRecord = {
    ...other.record,
    recordHash: digest("rch_", 4),
    durabilityEvidence: other.record.durabilityEvidence.map((evidence) => ({
      ...evidence,
      subjectId: digest("rch_", 4),
    })),
  };
  return withDaemonStore(stateDirectory(), (store) =>
    Effect.gen(function* () {
      yield* seedState(store);
      yield* store.putConversationFoundation(other.foundation);
      yield* store.applyCertifiedRecord(otherRecord, {
        recipientAgentId: identity.agentId,
        canonicalMessage: bytes("delivery"),
      });
      const own = yield* store.readFirewallEvidence({
        conversationId: foundation.conversationId,
        maximumRecords: 10,
      });
      const elsewhere = yield* store.readFirewallEvidence({
        conversationId: other.foundation.conversationId,
        maximumRecords: 10,
      });
      const captured = yield* store.readFirewallEvidenceSlices({
        ranges: [
          { beforeRecord: record.recordHash },
          { beforeRecord: otherRecord.recordHash },
          { conversationId: other.foundation.conversationId },
          {},
        ],
        maximumRecords: 10,
      });

      expect(own.pendingOutgoing).toBe(true);
      expect(elsewhere.pendingOutgoing).toBe(false);
      expect(captured.slices[1]?.candidate).toBeDefined();
      expect(captured.slices.map((slice) => slice.pendingOutgoing)).toEqual([
        true,
        false,
        false,
        false,
      ]);
    }),
  );
}

function invalidatesInterruptedChecks() {
  const path = stateDirectory();
  const checkId = "interrupted-check";
  const completion = { checkId, admit: true, canonicalResult: bytes("allow") };
  return Effect.gen(function* () {
    yield* withDaemonStore(path, (store) =>
      Effect.gen(function* () {
        yield* seedState(store);
        yield* store.beginFirewallAttempt({
          checkId,
          direction: "outgoing",
          canonicalCandidate: bytes("draft"),
          canonicalInput: bytes("fixed policy and evidence"),
        });
      }),
    );
    yield* withDaemonStore(path, (store) =>
      Effect.gen(function* () {
        expect(
          (yield* store.readFirewallEvidence({
            conversationId: foundation.conversationId,
            maximumRecords: 10,
          })).pendingOutgoing,
        ).toBe(true);
        expect(
          yield* Effect.flip(
            store.completeFirewallAttempt(
              completion,
              "outgoing",
              bytes("draft"),
            ),
          ),
        ).toMatchObject({ reason: "conflict" });
        expect((yield* store.recover()).messageIntents).toHaveLength(1);
      }),
    );
  });
}

const local = bytes("local item");
const historyDelivery = {
  recipientAgentId: identity.agentId,
  canonicalMessage: bytes("delivery"),
};

function historyRecord(ordinal: number): CertifiedRecord {
  const { record } = storedConversation("history-window");
  const recordHash = `rch_history:${ordinal}`;
  const actionHash = `ach_history:${ordinal}`;
  return {
    ...record,
    recordHash,
    actionHash,
    msgId: `msg_history:${ordinal}`,
    canonicalRecordCore: bytes(`history:${ordinal}`),
    ...(ordinal === 0
      ? {}
      : { previousRecordHash: `rch_history:${ordinal - 1}` }),
    actionEvidence: record.actionEvidence.map((evidence) => ({
      ...evidence,
      subjectId: actionHash,
    })),
    durabilityEvidence: record.durabilityEvidence.map((evidence) => ({
      ...evidence,
      subjectId: recordHash,
    })),
  };
}

/** A window entry's bytes: a record's core, or a local entry's projection. */
function entryBytes(entry: FirewallHistoryEntry | FirewallLocalEntry) {
  return "canonicalRecordCore" in entry
    ? entry.canonicalRecordCore
    : entry.canonicalEntry;
}

function selectsRecentHistoryFromALongConversation() {
  const { foundation } = storedConversation("history-window");
  const other = storedConversation("other-history");
  const delivery = historyDelivery;
  return withDaemonStore(stateDirectory(), (store) =>
    Effect.gen(function* () {
      yield* store.bindIdentity(identity);
      yield* store.putConversationFoundation(other.foundation);
      yield* store.applyCertifiedRecord(other.record, delivery);
      yield* store.putConversationFoundation(foundation);
      yield* Effect.forEach(
        Array.range(0, 1_003),
        (ordinal) =>
          store.applyCertifiedRecord(historyRecord(ordinal), delivery),
        { concurrency: 1, discard: true },
      );
      const candidate = (yield* store.readPendingDeliveries()).find(
        (item) => item.recordHash === "rch_history:1002",
      );
      const incoming = yield* store.readFirewallEvidence({
        beforeDelivery: yield* Effect.fromNullable(
          candidate?.deliveryToken,
        ).pipe(Effect.orDie),
        maximumRecords: 2,
      });
      const outgoing = yield* store.readFirewallEvidence({
        conversationId: foundation.conversationId,
        maximumRecords: 2,
      });

      expect(incoming.history.map(entryBytes)).toEqual([
        bytes("history:1000"),
        bytes("history:1001"),
      ]);
      expect(incoming.candidate?.canonicalRecordCore).toEqual(
        bytes("history:1002"),
      );
      expect(outgoing.history.map(entryBytes)).toEqual([
        bytes("history:1002"),
        bytes("history:1003"),
      ]);
      expect([incoming, outgoing].map(windowBounds)).toEqual([
        { earlierHistoryOmitted: true, overflow: false },
        { earlierHistoryOmitted: true, overflow: false },
      ]);
    }),
  );
}

/** Whether a window omitted older entries, and whether it hit the byte bound. */
function windowBounds(window: {
  readonly earlierHistoryOmitted: boolean;
  readonly overflow: boolean;
}) {
  return {
    earlierHistoryOmitted: window.earlierHistoryOmitted,
    overflow: window.overflow,
  };
}

/**
 * A local item's evidence is kept under its conversation's address and
 * follows the certified records that preceded its admission, so a window
 * reads it in certification order and keeps the newest entries.
 */
function anchorsLocalEvidenceInItsConversation() {
  const { foundation } = storedConversation("history-window");
  return withDaemonStore(stateDirectory(), (store) =>
    Effect.gen(function* () {
      const later = yield* seedLocalEvidenceBetweenRecords(store);
      const window = (maximumRecords: number, conversation = "agent:bob") =>
        store.readFirewallEvidence({
          conversationId: foundation.conversationId,
          conversation,
          maximumRecords,
        });
      const whole = yield* window(10);
      const recent = yield* window(3);
      const elsewhere = yield* window(10, "agent:carol");
      const beforeLater = yield* store.readFirewallEvidence({
        beforeDelivery: later,
        conversation: "agent:bob",
        maximumRecords: 10,
      });

      const records = [0, 1, 2, 3].map((ordinal) =>
        bytes(`history:${ordinal}`),
      );
      const evidence = bytes("local evidence");
      expect(whole.history.map(entryBytes)).toEqual([
        ...records.slice(0, 2),
        evidence,
        ...records.slice(2),
      ]);
      expect(recent.history.map(entryBytes)).toEqual([
        evidence,
        ...records.slice(2),
      ]);
      expect(recent.earlierHistoryOmitted).toBe(true);
      expect(beforeLater.history.map(entryBytes)).toEqual([
        ...records.slice(0, 2),
        evidence,
      ]);
      expect(elsewhere.history.map(entryBytes)).toEqual(records);
      expect((yield* store.readInboxItem(token))?.canonicalItem).toEqual(
        bytes("projection"),
      );
    }),
  );
}

/**
 * Two records, then a local item queued with evidence under `agent:bob`, a
 * third record certified before the item is admitted, and a fourth after.
 * The evidence belongs where the item was queued, before the third.
 * @param store The store to seed.
 * @returns The delivery of the first record after the local item.
 */
function seedLocalEvidenceBetweenRecords(store: DaemonStore) {
  const { foundation } = storedConversation("history-window");
  return Effect.gen(function* () {
    yield* store.bindIdentity(identity);
    yield* store.putConversationFoundation(foundation);
    for (const ordinal of [0, 1]) {
      yield* store.applyCertifiedRecord(
        historyRecord(ordinal),
        historyDelivery,
      );
    }
    yield* store.queueFirewallItem({
      deliveryToken: token,
      conversation: "agent:bob",
      canonicalItem: local,
    });
    yield* store.applyCertifiedRecord(historyRecord(2), historyDelivery);
    expect(
      yield* store.admitFirewallLocalItem({
        queuedItem: local,
        item: { deliveryToken: token, canonicalItem: bytes("projection") },
        completions: [],
        deterministic: {
          checkId: "local-check",
          direction: "incoming",
          canonicalCandidate: local,
          canonicalInput: bytes("fixed policy"),
          canonicalResult: bytes("allow"),
        },
        answers: [],
        evidence: {
          conversation: "agent:bob",
          canonicalEntry: bytes("local evidence"),
        },
      }),
    ).toBe("admitted");
    yield* store.applyCertifiedRecord(historyRecord(3), historyDelivery);
    const pending = yield* store.readPendingDeliveries();
    const later = pending.find((item) => item.recordHash === "rch_history:2");
    return yield* Effect.fromNullable(later?.deliveryToken).pipe(Effect.orDie);
  });
}

describe("endpoint runtime state", () => {
  it(
    "preserves identity, protocol and admitted runtime state across restart",
    preservesStateAcrossRestart,
  );
  it(
    "scopes unresolved-send evidence to each slice's conversation",
    scopesUnresolvedSendEvidenceToEachSlicesConversation,
  );
  it(
    "invalidates interrupted checks while preserving unresolved intent evidence",
    invalidatesInterruptedChecks,
  );
  it(
    "reports creation and reopening without changing stored identity",
    reportsHowCurrentStoreOpens,
  );
  it(
    "selects recent incoming and outgoing windows from a long conversation",
    selectsRecentHistoryFromALongConversation,
    { timeout: 30_000 },
  );
  it(
    "orders a local item's evidence where it was queued, before records certified while it waited",
    anchorsLocalEvidenceInItsConversation,
  );
});

/* eslint-enable agent-code-guard/no-hardcoded-assertion-literals -- Restore repository defaults. */
