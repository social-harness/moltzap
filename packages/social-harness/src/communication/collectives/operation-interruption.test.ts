/** @file Accepted gather admission and fanout keep their owner after caller interruption. */

import { scoped as it } from "@effect/vitest";
import {
  Deferred,
  Effect,
  Exit,
  Fiber,
  Schema,
  Scope,
  TestClock,
} from "effect";
import { expect } from "vitest";
import type { DaemonStore } from "../../daemon/store.js";
import type { EndpointStoreError } from "../store/index.js";
import type { InboundItem } from "./inbound.js";
import { testAgentView } from "../../__tests__/agent-card-fixtures.js";
import { makeCollectiveOperations } from "../../__tests__/collective-send.js";
import { collectivePersistencePorts } from "../../__tests__/collective-storage-stub.js";
import { engineFixture } from "../../__tests__/firewall-runtime-fixtures.js";
import { AgentAddress } from "../records/index.js";

it("finalizes accepted gather custody after its caller is interrupted", () =>
  Effect.gen(function* () {
    const fixture = yield* admissionFixture();
    const sending = yield* fixture.collective
      .send({
        to: Schema.decodeUnknownSync(AgentAddress)("agent:bob"),
        text: "Can you attend?",
        collective: {
          op: "gather",
          deadline: 60,
          requestedSchema: { type: "object", properties: {} },
        },
      })
      .pipe(Effect.fork);
    yield* Deferred.await(fixture.committed);
    expect(yield* fixture.store.readCollectiveOperations()).toMatchObject([
      { phase: "collecting" },
    ]);
    yield* Fiber.interruptFork(sending);
    yield* Deferred.succeed(fixture.release, undefined);
    expect(Exit.isInterrupted(yield* Fiber.await(sending))).toBe(true);
    yield* Deferred.await(fixture.started);
    yield* TestClock.adjust("2 minutes");
    expect(fixture.emitted).toMatchObject([
      {
        kind: "collectiveResult",
        outcomes: [
          {
            member: testAgentView("agent:bob"),
            outcome: { kind: "no-answer" },
          },
        ],
      },
    ]);
  }));

function admissionFixture() {
  return Effect.gen(function* () {
    const subject = yield* engineFixture();
    const committed = yield* Deferred.make<undefined>();
    const release = yield* Deferred.make<undefined>();
    const started = yield* Deferred.make<undefined>();
    const emitted: InboundItem[] = [];
    const store: DaemonStore = {
      ...subject.store,
      putCollectiveOperation: (operation) =>
        pauseCommit(
          subject.store.putCollectiveOperation(operation),
          committed,
          release,
        ),
    };
    const persistence = yield* collectivePersistencePorts(() =>
      Deferred.succeed(started, undefined).pipe(Effect.zipRight(Effect.never)),
    );
    const collective = yield* makeCollectiveOperations({
      ...persistence,
      store,
      self: testAgentView("agent:alice"),
      scope: yield* Scope.Scope,
      sendMessage: () =>
        Deferred.succeed(started, undefined).pipe(
          Effect.zipRight(Effect.never),
        ),
      observeMessage: () => Effect.never,
      reportStorageFault: () => Effect.dieMessage("unexpected storage fault"),
      emit: (item) =>
        Effect.sync(() => {
          emitted.push(item);
        }),
    });
    return { store, collective, committed, release, started, emitted };
  });
}

function pauseCommit<A>(
  write: Effect.Effect<A, EndpointStoreError>,
  committed: Deferred.Deferred<undefined>,
  release: Deferred.Deferred<undefined>,
) {
  return write.pipe(
    Effect.tap(() => Deferred.succeed(committed, undefined)),
    Effect.tap(() => Deferred.await(release)),
  );
}
