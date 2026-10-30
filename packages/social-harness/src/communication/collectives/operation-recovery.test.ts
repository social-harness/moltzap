/** @file Signed collective messages and completion decisions survive endpoint restarts. */

import { SqlClient } from "@effect/sql";

import { live as it, scoped as itOnClock } from "@effect/vitest";
import { Effect, Fiber, Option, Schema, Scope, TestClock } from "effect";
import { expect } from "vitest";
import { untilLive } from "../../__tests__/advance-clock.js";
import { testAgentView } from "../../__tests__/agent-card-fixtures.js";
import {
  appendCertifiedIntent,
  appendCertifiedMessage,
  buildCertifiedFirstMessage,
  storeCertifiedFirstMessage,
} from "../../__tests__/certified-history-fixtures.js";
import { collectiveOperationId } from "../../__tests__/collective-id-fixtures.js";
import {
  anchor,
  certifyBoundIntent,
  resumeEngine,
} from "../../__tests__/collective-recovery-fixtures.js";
import { makeCollectiveOperations } from "../../__tests__/collective-send.js";
import {
  engineFixture,
  type Fixture,
} from "../../__tests__/firewall-runtime-fixtures.js";
import { withDaemonStore } from "../../__tests__/store-schema-fixtures.js";
import {
  type TestDatabase,
  openTestDatabase,
} from "../../__tests__/communication-test-database.js";
import {
  AgentAddress,
  type CertifiedRecord,
  MessageIntent,
} from "../records/index.js";
import {
  decodeRuntimeValue,
  type MessageIntent as StoredMessageIntent,
} from "../store/index.js";
import { encodeCollectiveContent } from "./wire/index.js";

const self = Schema.decodeUnknownSync(AgentAddress)("agent:alice");
const sender = Schema.decodeUnknownSync(AgentAddress)("agent:bob");
const operationId = collectiveOperationId(testAgentView(sender).agentId);
const response = {
  to: sender,
  collectiveResponse: {
    operationId,
    action: "accept",
    content: { answer: "yes" },
  },
} as const;

function resume(subject: Fixture, store: TestDatabase) {
  return Effect.gen(function* () {
    const engine = yield* resumeEngine(subject, store);
    const collective = yield* makeCollectiveOperations({
      self: testAgentView(self),
      scope: yield* Scope.Scope,
      sendMessage: engine.send,
      prepareMessage: engine.prepare,
      acceptMessage: engine.accept,
      observeMessage: engine.observeMessage,
      reportStorageFault: () =>
        Effect.dieMessage("unexpected collective storage failure"),
      emit: () => Effect.dieMessage("a gather receiver emits no local result"),
    }).pipe(Effect.provideService(SqlClient.SqlClient, store.sql));
    const pending = yield* engine.readPendingMessages();
    yield* Effect.forEach(pending, collective.classify, {
      concurrency: 1,
      discard: true,
    });
    return collective;
  });
}

it(
  "keeps one bound response after caller interruption and two engine restarts, then recognizes its certificate",
  () =>
    Effect.gen(function* () {
      const subject = yield* Effect.scoped(engineFixture());
      const request = yield* seedRemoteRequest(subject);
      const original = yield* claimPendingResponse(subject);
      yield* assertRecoveredResponse(subject, original, false);
      yield* certifyRecoveredResponse(subject, request, original);
      yield* assertRecoveredResponse(subject, original, true);
    }),
  20_000,
);

function seedRemoteRequest(subject: Fixture) {
  return withDaemonStore(subject.directory, (store) =>
    Effect.gen(function* () {
      const firstMessage = yield* buildCertifiedFirstMessage(
        subject.local,
        subject.remote,
        subject.membership,
        anchor.routerInstanceId,
      );
      yield* storeCertifiedFirstMessage(
        store,
        subject.local.card,
        subject.membership,
        firstMessage,
      );
      const content = yield* encodeCollectiveContent(
        {
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
        "Can you attend?",
      );
      return yield* appendCertifiedMessage(
        { ...subject, store },
        firstMessage,
        content,
      );
    }),
  );
}

function claimPendingResponse(subject: Fixture) {
  return Effect.scoped(
    Effect.gen(function* () {
      const store = yield* openTestDatabase(subject.directory);
      const collective = yield* resume(subject, store);
      const sending = yield* collective.send(response).pipe(Effect.forkScoped);
      yield* untilLive(
        store.run(store.store.readCollectiveMessages()).pipe(
          Effect.map((messages) => messages.length === 1),
          Effect.orDie,
        ),
      );
      yield* Fiber.interrupt(sending);
      expect(yield* Effect.flip(collective.send(response))).toMatchObject({
        failure: { kind: "request-answered" },
      });
      const messages = yield* store.run(store.store.readCollectiveMessages());
      expect(messages).toHaveLength(1);
      const [message] = messages;
      if (message === undefined) {
        return yield* Effect.dieMessage("missing response intent");
      }
      return message.intent;
    }),
  );
}

function assertRecoveredResponse(
  subject: Fixture,
  original: StoredMessageIntent,
  completed: boolean,
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const store = yield* openTestDatabase(subject.directory);
      const collective = yield* resume(subject, store);
      expect(yield* Effect.flip(collective.send(response))).toMatchObject({
        failure: { kind: "request-answered" },
      });
      const messages = yield* store.run(store.store.readCollectiveMessages());
      expect(messages).toHaveLength(1);
      expect(messages[0]?.intent).toMatchObject({
        msgId: original.msgId,
        canonicalIntent: original.canonicalIntent,
      });
      expect(messages[0]?.intent.completedRecordHash !== undefined).toBe(
        completed,
      );
    }),
  );
}

itOnClock(
  "keeps a local message pending when a peer certifies the same message ID",
  () =>
    Effect.gen(function* () {
      const subject = yield* Effect.scoped(engineFixture());
      const head = yield* seedRemoteRequest(subject);
      const store = yield* openTestDatabase(subject.directory);
      const engine = yield* resumeEngine(subject, store);
      const sending = yield* engine
        .send({
          to: sender,
          content: [{ type: "text", text: "Local request" }],
        })
        .pipe(Effect.fork);
      yield* untilLive(
        store.run(store.store.recover()).pipe(
          Effect.map((recovery) => recovery.messageIntents.length === 1),
          Effect.orDie,
        ),
      );
      const recovery = yield* store.run(store.store.recover());
      const retained = yield* Effect.fromNullable(recovery.messageIntents[0]);
      const intent = yield* decodeRuntimeValue(
        MessageIntent,
        retained.canonicalIntent,
      );
      const peer = yield* certifyBoundIntent({ subject, engine }, head, {
        ...intent,
        authorAgentId: subject.remote.card.agentId,
        content: [{ type: "text", text: "Peer request" }],
      });
      const observing = yield* engine
        .observeMessage(intent.msgId)
        .pipe(Effect.timeoutOption("10 millis"), Effect.fork);
      yield* TestClock.adjust("10 millis");
      expect(Option.isNone(yield* Fiber.join(observing))).toBe(true);
      const local = yield* certifyBoundIntent(
        { subject, engine },
        peer,
        intent,
      );
      expect(yield* engine.observeMessage(intent.msgId)).toEqual({
        msgId: intent.msgId,
        recordHash: local.actionCertifiedRecord.recordHash,
      });
      expect(
        (yield* store.run(store.store.recover())).messageIntents[0]
          ?.completedRecordHash,
      ).toBe(local.actionCertifiedRecord.recordHash);
      yield* Fiber.interrupt(sending);
    }),
);

function certifyRecoveredResponse(
  subject: Fixture,
  request: CertifiedRecord,
  original: StoredMessageIntent,
) {
  return withDaemonStore(subject.directory, (store) =>
    Effect.gen(function* () {
      const intent = yield* decodeRuntimeValue(
        MessageIntent,
        original.canonicalIntent,
      );
      yield* appendCertifiedIntent({ ...subject, store }, request, intent);
    }),
  );
}
