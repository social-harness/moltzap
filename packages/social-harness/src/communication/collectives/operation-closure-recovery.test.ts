/** @file Signed all-gather completion survives interruption at each retained transition. */

import { SqlClient } from "@effect/sql";
import { scoped as it } from "@effect/vitest";
import {
  Deferred,
  Effect,
  Fiber,
  Option,
  Schema,
  Scope,
  TestClock,
} from "effect";
import { expect } from "vitest";
import type { EndpointEngine } from "../conversations/index.js";
import type { CollectivePorts } from "./ports.js";
import { untilLive } from "../../__tests__/advance-clock.js";
import { testAgentView } from "../../__tests__/agent-card-fixtures.js";
import {
  boundIntent,
  certifyBoundIntent,
  groupSubject,
  resumeEngine,
  retainingEmitter,
  seedGroupFirstMessage,
  waitForClose,
} from "../../__tests__/collective-recovery-fixtures.js";
import {
  type TestCollectiveOperations as CollectiveOperations,
  makeCollectiveOperations,
} from "../../__tests__/collective-send.js";
import {
  openTestDatabase,
  type TestDatabase,
} from "../../__tests__/communication-test-database.js";
import {
  engineFixture,
  type Fixture,
} from "../../__tests__/firewall-runtime-fixtures.js";
import {
  AgentAddress,
  type CertifiedRecord,
  MessageAddressInput,
  MessageIntent,
  mintMsgId,
} from "../records/index.js";
import { decodeRuntimeValue } from "../store/index.js";
import { InboundItem } from "./inbound.js";
import { encodeCollectiveContent, readCollectiveValue } from "./wire/index.js";
const self = Schema.decodeUnknownSync(AgentAddress)("agent:alice");
const closureCheckpoints = [
  "before-deadline",
  "before-bind",
  "after-bind",
  "before-publish",
] as const;
type ClosureCheckpoint = (typeof closureCheckpoints)[number];

it.each(closureCheckpoints)(
  "recovers the selected close and terminal identity after interruption %s",
  (checkpoint) =>
    Effect.gen(function* () {
      const subject = yield* groupSubject(
        yield* Effect.scoped(engineFixture()),
      );
      const head = yield* seedGroupFirstMessage(subject);
      const interrupted = yield* Effect.scoped(
        interruptClosure(subject, head, checkpoint),
      );
      yield* TestClock.adjust("2 hours");
      const recovered = yield* Effect.scoped(
        recoverClosure(subject, interrupted),
      );
      yield* verifyCompletedRestart(subject, interrupted, recovered);
    }),
);

function closurePorts(
  engine: EndpointEngine,
  scope: Scope.Scope,
): Omit<CollectivePorts, "emit"> {
  return {
    self: testAgentView(self),
    scope,
    sendMessage: engine.send,
    prepareMessage: engine.prepare,
    acceptMessage: engine.accept,
    observeMessage: engine.observeMessage,
    reportStorageFault: () => Effect.dieMessage("unexpected persistence fault"),
  };
}

function interruptClosure(
  subject: Fixture,
  head: CertifiedRecord,
  checkpoint: ClosureCheckpoint,
) {
  return Effect.gen(function* () {
    const store = yield* openTestDatabase(subject.directory);
    const engine = yield* resumeEngine(subject, store);
    const paused = yield* Deferred.make<undefined>();
    const barrier = Deferred.succeed(paused, undefined).pipe(
      Effect.zipRight(Effect.never),
    );
    const layer = yield* store.run(
      makeCollectiveOperations({
        ...closurePorts(engine, yield* Scope.Scope),
        sendMessage: (input) =>
          checkpoint === "before-bind" && input.collective?.role === "close"
            ? barrier
            : engine.send(input),
        emit: () => barrier,
      }),
    );
    const fixture = { subject, store, engine, layer };
    const { operationId, answer } = yield* requestWithOneDecline(fixture, head);
    yield* reachClosureCheckpoint(fixture, checkpoint, paused, answer);
    const operation = yield* Effect.fromNullable(
      yield* store.run(store.store.readCollectiveOperation(operationId)),
    );
    const [close] = yield* store.run(
      store.store.readCollectiveMessages({
        operationId,
        role: "close",
      }),
    );
    expect(operation.phase).toBe(
      checkpoint === "before-deadline" ? "collecting" : "finalizing",
    );
    return { operation, answer, close };
  });
}

type InterruptedClosure = Effect.Effect.Success<
  ReturnType<typeof interruptClosure>
>;
interface ClosureFixture {
  readonly subject: Fixture;
  readonly store: TestDatabase;
  readonly engine: EndpointEngine;
  readonly layer: CollectiveOperations;
}

function requestWithOneDecline(fixture: ClosureFixture, head: CertifiedRecord) {
  return Effect.gen(function* () {
    const { subject, store, engine, layer } = fixture;
    const sending = yield* layer
      .send({
        to: Schema.decodeUnknownSync(MessageAddressInput)(
          "group:alice,bob,carol",
        ),
        text: "Choose a time",
        collective: {
          op: "all_gather",
          deadline: 60,
          requestedSchema: { type: "object", properties: {} },
        },
      })
      .pipe(Effect.fork);
    yield* untilLive(
      store.run(store.store.readCollectiveMessages()).pipe(
        Effect.map((messages) =>
          messages.some((message) => message.role === "request"),
        ),
        Effect.orDie,
      ),
    );
    const intent = yield* boundIntent(store, "request");
    const request = yield* certifyBoundIntent(fixture, head, intent);
    const sent = yield* Fiber.join(sending);
    if (sent.kind !== "collective") {
      return yield* Effect.dieMessage("expected all-gather");
    }
    const answer = yield* certifyBoundIntent(fixture, request, {
      ...intent,
      authorAgentId: subject.remote.card.agentId,
      msgId: yield* mintMsgId(),
      content: yield* encodeCollectiveContent({
        kind: "response",
        operationId: sent.operationId,
        action: "decline",
      }),
    });
    const pending = yield* engine.readPendingMessages();
    const delivered = yield* Effect.fromNullable(
      pending.find(
        (entry) => entry.recordHash === answer.actionCertifiedRecord.recordHash,
      ),
    );
    yield* layer.classify(delivered);
    return { operationId: sent.operationId, answer };
  });
}

function reachClosureCheckpoint(
  fixture: ClosureFixture,
  checkpoint: ClosureCheckpoint,
  paused: Deferred.Deferred<undefined>,
  answer: CertifiedRecord,
) {
  return Effect.gen(function* () {
    if (checkpoint === "before-deadline") {
      return;
    }
    yield* TestClock.adjust("1 minute");
    if (checkpoint === "before-bind") {
      yield* Deferred.await(paused);
      return;
    }
    yield* waitForClose(fixture.store);
    if (checkpoint === "before-publish") {
      yield* certifyBoundIntent(
        fixture,
        answer,
        yield* boundIntent(fixture.store, "close"),
      );
      yield* Deferred.await(paused);
    }
  });
}

function recoverClosure(subject: Fixture, interrupted: InterruptedClosure) {
  return Effect.gen(function* () {
    const store = yield* openTestDatabase(subject.directory);
    const engine = yield* resumeEngine(subject, store);
    const emitted = yield* Deferred.make<InboundItem>();
    yield* makeCollectiveOperations({
      ...closurePorts(engine, yield* Scope.Scope),
      emit: retainingEmitter(store, emitted),
    }).pipe(Effect.provideService(SqlClient.SqlClient, store.sql));
    yield* waitForClose(store);
    const close = yield* boundIntent(store, "close");
    const metadata = yield* verifyRecoveredClose(close, interrupted);
    if (interrupted.close?.intent.completedRecordHash === undefined) {
      yield* certifyBoundIntent({ subject, engine }, interrupted.answer, close);
    }
    const result = yield* Deferred.await(emitted);
    expect(result).toMatchObject({
      ...metadata,
      outcomes: [
        { member: testAgentView("agent:bob"), outcome: { kind: "declined" } },
        {
          member: testAgentView("agent:carol"),
          outcome: { kind: "no-answer" },
        },
      ],
    });
    const operation = yield* Effect.fromNullable(
      yield* store.run(
        store.store.readCollectiveOperation(interrupted.operation.operationId),
      ),
    );
    if (interrupted.operation.canonicalSelection !== undefined) {
      expect(operation.canonicalSelection).toEqual(
        interrupted.operation.canonicalSelection,
      );
    }
    return { result, close, selection: operation.canonicalSelection };
  });
}

function verifyRecoveredClose(
  close: MessageIntent,
  interrupted: InterruptedClosure,
) {
  return Effect.gen(function* () {
    const original = interrupted.close?.intent;
    if (original !== undefined) {
      expect(close.msgId).toBe(original.msgId);
      expect(close).toEqual(
        yield* decodeRuntimeValue(MessageIntent, original.canonicalIntent),
      );
    }
    const metadata = {
      closedAt:
        interrupted.operation.phase === "collecting" ? 7_200_000 : 60_000,
      closedBy: "deadline",
    };
    expect(yield* readCollectiveValue(close.content)).toEqual(
      Option.some({
        kind: "close",
        operationId: interrupted.operation.operationId,
        ...metadata,
        included: [interrupted.answer.actionCertifiedRecord.recordHash],
      }),
    );
    return metadata;
  });
}

function verifyCompletedRestart(
  subject: Fixture,
  interrupted: InterruptedClosure,
  recovered: Effect.Effect.Success<ReturnType<typeof recoverClosure>>,
) {
  return Effect.gen(function* () {
    const store = yield* openTestDatabase(subject.directory);
    const engine = yield* resumeEngine(subject, store);
    yield* makeCollectiveOperations({
      ...closurePorts(engine, yield* Scope.Scope),
      emit: () =>
        Effect.dieMessage("a completed result cannot be emitted twice"),
    }).pipe(Effect.provideService(SqlClient.SqlClient, store.sql));
    const [operation] = yield* store.run(
      store.store.readCollectiveOperations(),
    );
    expect(operation?.deliveryToken).toBe(interrupted.operation.deliveryToken);
    expect(operation?.canonicalSelection).toEqual(recovered.selection);
    expect(operation).toMatchObject({ phase: "completed" });
    expect(yield* boundIntent(store, "close")).toEqual(recovered.close);
    expect(
      yield* store.run(
        store.store.readCollectiveMessages({
          operationId: interrupted.operation.operationId,
          role: "close",
        }),
      ),
    ).toHaveLength(1);
    const { items: inbox } = yield* store.run(store.store.readInbox());
    expect(inbox).toHaveLength(1);
    const item = yield* Effect.fromNullable(inbox[0]);
    expect(item.deliveryToken).toBe(interrupted.operation.deliveryToken);
    expect(yield* decodeRuntimeValue(InboundItem, item.canonicalItem)).toEqual(
      recovered.result,
    );
  }).pipe(Effect.scoped);
}
