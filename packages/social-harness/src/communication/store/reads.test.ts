/** @file History pages retain their certified head while cursors survive replay and restart. */

import { assert, live as it } from "@effect/vitest";
import { Effect } from "effect";
import {
  bytes,
  stateDirectory,
  storedConversation,
  withDaemonStore,
  type TestStore,
} from "../../__tests__/store-schema-fixtures.js";
import type { CertifiedRecord } from "./index.js";

const { foundation, record } = storedConversation("history-cursor");
const identity = {
  agentId: "agent:alice",
  canonicalAgentCard: bytes("identity"),
};

/** Each immutable record has separate action and durability evidence. */
function historyRecord(position: number): CertifiedRecord {
  const recordHash = `record:${position}`;
  const actionHash = `action:${position}`;
  return {
    ...record,
    recordHash,
    actionHash,
    msgId: `message:${position}`,
    ...(position === 0 ? {} : { previousRecordHash: `record:${position - 1}` }),
    canonicalRecordCore: bytes(`original record ${position}`),
    actionEvidence: record.actionEvidence.map((item) => ({
      ...item,
      subjectId: actionHash,
    })),
    durabilityEvidence: record.durabilityEvidence.map((item) => ({
      ...item,
      subjectId: recordHash,
    })),
  };
}

/** Records arrive through the same certified-record operation used during recovery. */
function append(store: TestStore, position: number) {
  return store.applyCertifiedRecord(historyRecord(position), {
    recipientAgentId: identity.agentId,
    canonicalMessage: bytes(`message ${position}`),
  });
}

it("replays the same bounded certified prefix after appends, evidence growth and restart", () =>
  Effect.gen(function* () {
    const directory = stateDirectory();
    const continuation = yield* withDaemonStore(directory, (store) =>
      Effect.gen(function* () {
        yield* store.bindIdentity(identity);
        yield* store.putConversationFoundation(foundation);
        yield* Effect.forEach(
          Array.from({ length: 53 }, (_, position) => position),
          (position) => append(store, position),
          { discard: true },
        );
        const first = yield* store.readConversation({
          conversationId: foundation.conversationId,
        });
        assert.lengthOf(first.records, 50);
        assert.strictEqual(first.records[0]?.recordHash, "record:0");
        assert.strictEqual(first.records.at(-1)?.recordHash, "record:49");
        assert.isNotNull(first.continuation);
        const cursor = yield* Effect.fromNullable(first.continuation).pipe(
          Effect.orDie,
        );
        yield* append(store, 53);
        yield* store.mergeEvidence({
          conversationId: foundation.conversationId,
          kind: "durability",
          subjectId: "record:52",
          evidenceKey: "agent:carol",
          canonicalEvidence: bytes("later signed evidence"),
        });
        return cursor;
      }),
    );
    yield* withDaemonStore(directory, (store) =>
      Effect.gen(function* () {
        const second = yield* store.readConversation({ continuation });
        const replay = yield* store.readConversation({ continuation });
        assert.deepStrictEqual(
          second.records.map((item) => item.recordHash),
          ["record:50", "record:51", "record:52"],
        );
        assert.deepStrictEqual(replay, second);
        assert.isNull(second.continuation);
        assert.deepStrictEqual(
          second.records.at(-1)?.canonicalRecordCore,
          bytes("original record 52"),
        );
        assert.isTrue(
          second.records
            .at(-1)
            ?.durabilityEvidence.some(
              (item) => item.evidenceKey === "agent:carol",
            ) ?? false,
        );
      }),
    );
  }));

it("rejects an unreadable cursor instead of starting a different history read", () =>
  withDaemonStore(stateDirectory(), (store) =>
    Effect.gen(function* () {
      const failure = yield* store
        .readConversation({ continuation: "invalid cursor" })
        .pipe(Effect.flip);
      assert.strictEqual(failure.reason, "invalid-continuation");
    }),
  ));
