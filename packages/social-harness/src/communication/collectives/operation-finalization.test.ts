/** @file A retained answer survives delayed storage responses and endpoint restart. */

import { scoped as it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Schema, Scope, TestClock } from "effect";
import { expect } from "vitest";
import type { CollectiveId } from "./contracts.js";
import type { InboundItem } from "./inbound.js";
import type { CollectivePorts } from "./ports.js";
import { testAgentView } from "../../__tests__/agent-card-fixtures.js";
import { appendCertifiedMessage } from "../../__tests__/certified-history-fixtures.js";
import { retainingEmitter } from "../../__tests__/collective-recovery-fixtures.js";
import {
  type TestCollectiveOperations as CollectiveOperations,
  makeCollectiveOperations,
} from "../../__tests__/collective-send.js";
import { collectivePersistencePorts } from "../../__tests__/collective-message-fixtures.js";
import {
  engineFixture,
  seedIncoming,
} from "../../__tests__/firewall-runtime-fixtures.js";
import { type DaemonStore, openDaemonStore } from "../../daemon/store.js";
import { LIVE_WIRE_VERSIONS } from "../../identity/wire-version.js";
import { InboundMessage } from "../conversations/message.js";
import { AgentAddress, mintMsgId } from "../records/index.js";
import { decodeRuntimeValue, EndpointStoreError } from "../store/index.js";
import { encodeCollectiveContent } from "./wire/index.js";

it("includes the answer retained before the deadline even when its store response is delayed", () =>
  Effect.gen(function* () {
    const fixture = yield* delayedAnswerFixture();
    const operationId = yield* beginGather(fixture.collective);
    const answer = yield* certifiedAnswer(fixture, operationId);
    const classifying = yield* fixture.collective
      .classify(answer)
      .pipe(Effect.fork);
    yield* Deferred.await(fixture.entered);
    expect(yield* fixture.store.readCollectiveAnswers()).toMatchObject([
      { operationId, recordHash: answer.recordHash },
    ]);
    yield* TestClock.adjust("2 minutes");
    yield* Deferred.succeed(fixture.release, undefined);
    yield* Fiber.join(classifying);
    expect(fixture.faults).toEqual([]);
    expect(yield* Deferred.await(fixture.emitted)).toMatchObject({
      kind: "collectiveResult",
      closedAt: 120_000,
      closedBy: "settled",
      outcomes: [
        {
          member: testAgentView("agent:bob"),
          outcome: { kind: "answered", content: { answer: "yes" } },
        },
      ],
    });
  }));

it("restores a retained answer before choosing settled completion after an offline deadline", () =>
  Effect.gen(function* () {
    const interrupted = yield* Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* delayedAnswerFixture(true);
        const operationId = yield* beginGather(fixture.collective);
        const answer = yield* certifiedAnswer(fixture, operationId);
        expect(
          yield* Effect.flip(fixture.collective.classify(answer)),
        ).toMatchObject({
          _tag: "CollectiveEmitError",
        });
        expect(fixture.faults).toHaveLength(1);
        expect(yield* fixture.store.readCollectiveOperations()).toMatchObject([
          { phase: "collecting" },
        ]);
        return fixture;
      }),
    );
    yield* TestClock.adjust("2 minutes");
    const store = yield* openDaemonStore(interrupted.subject.directory, {
      liveWireVersions: LIVE_WIRE_VERSIONS,
    });
    const emitted = yield* Deferred.make<InboundItem>();
    yield* makeCollectiveOperations({
      ...interrupted.ports,
      store,
      scope: yield* Scope.Scope,
      emit: retainingEmitter(store, emitted),
    });
    expect(yield* Deferred.await(emitted)).toMatchObject({
      closedAt: 120_000,
      closedBy: "settled",
      outcomes: [
        {
          member: testAgentView("agent:bob"),
          outcome: { kind: "answered", content: { answer: "yes" } },
        },
      ],
    });
  }));

function delayedAnswerFixture(failAfterRetain = false) {
  return Effect.gen(function* () {
    const subject = yield* engineFixture();
    const head = yield* seedIncoming(subject);
    const entered = yield* Deferred.make<undefined>();
    const release = yield* Deferred.make<undefined>();
    const emitted = yield* Deferred.make<InboundItem>();
    const faults: EndpointStoreError[] = [];
    const store = delayedAnswerStore(
      subject.store,
      entered,
      release,
      failAfterRetain,
    );
    const persistence = yield* collectivePersistencePorts(() =>
      mintMsgId().pipe(
        Effect.orDie,
        Effect.map((msgId) => ({
          msgId,
          recordHash: head.actionCertifiedRecord.recordHash,
        })),
      ),
    );
    const ports: CollectivePorts = {
      ...persistence,
      store,
      self: testAgentView("agent:alice"),
      scope: yield* Scope.Scope,
      reportStorageFault: (fault) =>
        Effect.sync(() => {
          faults.push(fault);
        }),
      emit: retainingEmitter(store, emitted),
    };
    const collective = yield* makeCollectiveOperations(ports);
    return {
      subject,
      head,
      store,
      ports,
      collective,
      entered,
      release,
      emitted,
      faults,
    };
  });
}

function beginGather(collective: CollectiveOperations) {
  return Effect.gen(function* () {
    const sent = yield* collective.send({
      to: Schema.decodeUnknownSync(AgentAddress)("agent:bob"),
      text: "Can you attend?",
      collective: {
        op: "gather",
        deadline: 60,
        requestedSchema: {
          type: "object",
          properties: { answer: { type: "string" } },
          required: ["answer"],
        },
      },
    });
    if (sent.kind !== "collective") {
      return yield* Effect.dieMessage("expected gather");
    }
    return sent.operationId;
  });
}

function certifiedAnswer(
  fixture: Effect.Effect.Success<ReturnType<typeof delayedAnswerFixture>>,
  operationId: CollectiveId,
) {
  return Effect.gen(function* () {
    const content = yield* encodeCollectiveContent({
      kind: "response",
      operationId,
      action: "accept",
      content: { answer: "yes" },
    });
    const answer = yield* appendCertifiedMessage(
      fixture.subject,
      fixture.head,
      content,
    );
    const recordHash = answer.actionCertifiedRecord.recordHash;
    const pending = yield* fixture.store.readPendingDeliveries();
    const row = yield* Effect.fromNullable(
      pending.find((item) => item.recordHash === recordHash),
    );
    const message = yield* decodeRuntimeValue(
      InboundMessage,
      row.canonicalMessage,
    );
    return { message, recordHash };
  });
}

function delayedAnswerStore(
  store: DaemonStore,
  entered: Deferred.Deferred<undefined>,
  release: Deferred.Deferred<undefined>,
  failAfterRetain: boolean,
): DaemonStore {
  return {
    ...store,
    recordCollectiveAnswer: (answer) =>
      store.recordCollectiveAnswer(answer).pipe(
        Effect.tap(() => Deferred.succeed(entered, undefined)),
        Effect.tap(() =>
          failAfterRetain
            ? Effect.fail(new EndpointStoreError({ reason: "persistence" }))
            : Deferred.await(release),
        ),
      ),
  };
}
