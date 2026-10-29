/** @file A retained answer remains in the deadline selection when its store response is delayed. */

import { scoped as it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Schema, Scope, TestClock } from "effect";
import { expect } from "vitest";
import type { CollectiveId } from "./contracts.js";
import type { InboundItem } from "./inbound.js";
import type { CollectivePorts } from "./ports.js";
import { appendCertifiedPost } from "../../__tests__/certified-history-fixtures.js";
import {
  engineFixture,
  seedIncoming,
} from "../../__tests__/firewall-runtime-fixtures.js";
import { InboundMessage } from "../conversations/message.js";
import { AgentAddress, mintPostId } from "../records/index.js";
import {
  decodeRuntimeValue,
  encodeRuntimeValue,
  type EndpointStore,
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
    expect(yield* Deferred.await(fixture.emitted)).toMatchObject({
      kind: "collectiveResult",
      outcomes: [
        {
          member: "agent:bob",
          outcome: { kind: "answered", content: { answer: "yes" } },
        },
      ],
    });
  }));

function delayedAnswerFixture() {
  return Effect.gen(function* () {
    const subject = yield* engineFixture();
    const head = yield* seedIncoming(subject);
    const entered = yield* Deferred.make<undefined>();
    const release = yield* Deferred.make<undefined>();
    const emitted = yield* Deferred.make<InboundItem>();
    const store: EndpointStore = {
      ...subject.store,
      recordCollectiveAnswer: (answer) =>
        subject.store.recordCollectiveAnswer(answer).pipe(
          Effect.tap(() => Deferred.succeed(entered, undefined)),
          Effect.tap(() => Deferred.await(release)),
        ),
    };
    const collective = yield* makeCollectiveOperations({
      store,
      self: Schema.decodeUnknownSync(AgentAddress)("agent:alice"),
      scope: yield* Scope.Scope,
      lookupMember: () => Effect.void,
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
      reportStorageFault: () => Effect.dieMessage("unexpected storage fault"),
      emit: retainingEmitter(store, emitted),
    });
    return { subject, head, store, collective, entered, release, emitted };
  });
}

function retainingEmitter(
  store: EndpointStore,
  emitted: Deferred.Deferred<InboundItem>,
): CollectivePorts["emit"] {
  return (item, ...[, terminal]) =>
    Effect.gen(function* () {
      if (terminal === undefined || item.kind !== "collectiveResult") {
        return yield* Effect.dieMessage("expected one retained gather result");
      }
      yield* store.publishCollectiveItem({
        ...terminal,
        canonicalItem: yield* encodeRuntimeValue(item),
        conversation: item.to,
        firewall: false,
      });
      yield* Deferred.succeed(emitted, item);
    }).pipe(Effect.orDie);
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
