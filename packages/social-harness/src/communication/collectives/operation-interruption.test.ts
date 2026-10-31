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

import type { InboundItem } from "./inbound.js";
import { testAgentView } from "../../__tests__/agent-card-fixtures.js";
import { collectivePersistencePorts } from "../../__tests__/collective-message-fixtures.js";
import { makeCollectiveOperations } from "../../__tests__/collective-send.js";
import { AgentAddress } from "../records/index.js";

it("keeps accepted gather custody when its caller is interrupted during fanout", () =>
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
    yield* Deferred.await(fixture.started);
    expect(
      yield* fixture.run(fixture.store.readCollectiveOperations()),
    ).toMatchObject([{ phase: "collecting" }]);
    yield* Fiber.interruptFork(sending);
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
    const started = yield* Deferred.make<undefined>();
    const emitted: InboundItem[] = [];
    const persistence = yield* collectivePersistencePorts(() =>
      Deferred.succeed(started, undefined).pipe(Effect.zipRight(Effect.never)),
    );
    const collective = yield* persistence.run(
      makeCollectiveOperations({
        ...persistence,
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
      }),
    );
    return {
      store: persistence.store,
      run: persistence.run,
      collective,
      started,
      emitted,
    };
  });
}
