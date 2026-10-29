/** @file A retained answer survives delayed storage responses and endpoint restart. */
import { scoped as it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Schema, Scope, TestClock } from "effect";
import { expect } from "vitest";
import type { CollectiveId } from "./contracts.js";
import type { InboundItem } from "./inbound.js";
import type { CollectivePorts } from "./ports.js";
import { testAgentView } from "../../__tests__/agent-card-fixtures.js";
import { appendCertifiedPost } from "../../__tests__/certified-history-fixtures.js";
import { retainingEmitter } from "../../__tests__/collective-recovery-fixtures.js";
import {
  engineFixture,
  seedIncoming,
} from "../../__tests__/firewall-runtime-fixtures.js";
import { LIVE_WIRE_VERSIONS } from "../../identity/wire-version.js";
import { InboundMessage } from "../conversations/message.js";
import { AgentAddress, mintPostId } from "../records/index.js";
import {
  decodeRuntimeValue,
  type EndpointStore,
  EndpointStoreError,
  openEndpointStore,
} from "../store/index.js";
import {
  type CollectiveOperations,
  makeCollectiveOperations,
} from "./index.js";
import { encodeCollectiveContent } from "./wire/index.js";

it("includes the answer retained before the deadline even when its store response is delayed", () =>
  Effect.gen(function* () {
    const fixture = yield* delayedAnswerFixture();
    const id = yield* beginGather(fixture.collective);
    const answer = yield* certifiedAnswer(fixture, id);
    const classifying = yield* fixture.collective
      .classify(answer)
      .pipe(Effect.fork);
    yield* Deferred.await(fixture.entered);
    expect(yield* fixture.store.readCollectiveAnswers()).toMatchObject([
      { operationId: id, recordHash: answer.recordHash },
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
        const id = yield* beginGather(fixture.collective);
        const answer = yield* certifiedAnswer(fixture, id);
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
    const store = yield* openEndpointStore(interrupted.subject.directory, {
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
    const ports: CollectivePorts = {
      store,
      self: Schema.decodeUnknownSync(AgentAddress)("agent:alice"),
      scope: yield* Scope.Scope,
      lookupMember: (member) => Effect.succeed(testAgentView(member)),
      sendPost: () =>
        mintPostId().pipe(
          Effect.orDie,
          Effect.map((postId) => ({
            postId,
            recordHash: head.actionCertifiedRecord.recordHash,
          })),
        ),
      bindPost: () => Effect.dieMessage("gather uses request fanout"),
      sendAdmitted: () => Effect.dieMessage("no firewall in this test"),
      observePost: () => Effect.dieMessage("gather owns no close"),
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
  id: CollectiveId,
) {
  return Effect.gen(function* () {
    const content = yield* encodeCollectiveContent({
      kind: "response",
      id,
      action: "accept",
      content: { answer: "yes" },
    });
    const answer = yield* appendCertifiedPost(
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
  store: EndpointStore,
  entered: Deferred.Deferred<undefined>,
  release: Deferred.Deferred<undefined>,
  failAfterRetain: boolean,
): EndpointStore {
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
