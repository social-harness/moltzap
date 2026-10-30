/** @file A refused gather cannot acquire live custody again after a database reopen. */

import { scoped as it } from "@effect/vitest";
import { Effect, Schema, Scope, TestClock } from "effect";
import { expect } from "vitest";
import type { DaemonStore } from "../../daemon/store.js";
import type { InboundItem } from "./inbound.js";
import { resumeEngine } from "../../__tests__/collective-recovery-fixtures.js";
import {
  engineFixture,
  type Fixture,
} from "../../__tests__/firewall-runtime-fixtures.js";
import { withDaemonStore } from "../../__tests__/store-schema-fixtures.js";
import { AgentView } from "../../identity/cards.js";
import { SendInput } from "./contracts.js";
import { makeCollectiveOperations } from "./index.js";

const input = Schema.decodeUnknownSync(SendInput)({
  to: "group:bob,carol",
  text: "Choose a time",
  collective: {
    op: "gather",
    deadline: 1,
    requestedSchema: { type: "object", properties: {} },
  },
});

it("retires a gather refused when its deadline passes during descriptor persistence", () =>
  Effect.gen(function* () {
    const delivered: InboundItem[] = [];
    const subject = yield* Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* engineFixture();
        const store: DaemonStore = {
          ...fixture.store,
          putCollectiveOperation: (operation) =>
            fixture.store
              .putCollectiveOperation(operation)
              .pipe(Effect.tap(TestClock.adjust("2 seconds"))),
        };
        const operations = yield* collectives(fixture, store, delivered);
        const prepared = yield* operations.prepare(input);
        expect(yield* Effect.flip(operations.accept(prepared))).toMatchObject({
          failure: { kind: "deadline-passed" },
        });
        expect((yield* fixture.store.recover()).messageIntents).toEqual([]);
        return fixture;
      }),
    );
    yield* TestClock.adjust("2 minutes");
    yield* withDaemonStore(subject.directory, (store) =>
      Effect.scoped(collectives(subject, store, delivered)),
    );
    expect(delivered).toEqual([]);
  }));

/** Real engine preparation preserves resolved membership through the collective recovery boundary. */
function collectives(
  subject: Fixture,
  store: DaemonStore,
  delivered: InboundItem[],
) {
  return Effect.gen(function* () {
    const engine = yield* resumeEngine(subject, store);
    return yield* makeCollectiveOperations({
      store,
      self: AgentView.make(subject.local.card),
      scope: yield* Scope.Scope,
      sendMessage: engine.send,
      prepareMessage: engine.prepare,
      acceptMessage: engine.accept,
      observeMessage: engine.observeMessage,
      reportStorageFault: (error) => Effect.die(error),
      emit: (item) =>
        Effect.sync(() => {
          delivered.push(item);
        }),
    });
  });
}
