/** @file A committed gather admission remains ambiguous to its caller when the store response fails. */

import { live as it } from "@effect/vitest";
import { Effect, Scope } from "effect";
import { expect } from "vitest";
import type { DaemonStore } from "../store.js";
import { testAgentView } from "../../__tests__/agent-card-fixtures.js";
import { makeCollectiveOperations } from "../../__tests__/collective-send.js";
import {
  gatherSend,
  question,
} from "../../__tests__/firewall-collective-fixtures.js";
import {
  fixture,
  type Fixture,
} from "../../__tests__/firewall-runtime-fixtures.js";
import { withDaemonStore } from "../../__tests__/store-schema-fixtures.js";
import {
  type CollectiveOperationInput,
  EndpointStoreError,
} from "../../communication/store/index.js";

// @agent-code-guard/regression-only: Fault injection after the real admission transaction proves error classification and durable operation identity across reopen.

it("retains the admitted gather when its store response fails and reports outcome unknown", () =>
  Effect.gen(function* () {
    const { directory, retained } = yield* Effect.scoped(
      committedGatherFailure(),
    );
    expect(
      yield* withDaemonStore(directory, (store) =>
        store.readCollectiveOperations(),
      ),
    ).toEqual(retained);
  }));

function committedGatherFailure() {
  return Effect.gen(function* () {
    const subject = yield* fixture;
    const fault = new EndpointStoreError({ reason: "persistence" });
    const reported: EndpointStoreError[] = [];
    let original: CollectiveOperationInput | undefined;
    const store: DaemonStore = {
      ...subject.store,
      putCollectiveOperation: (operation) => {
        original = operation;
        return subject.store
          .putCollectiveOperation(operation)
          .pipe(Effect.zipRight(Effect.fail(fault)));
      },
    };
    const collectives = yield* admittingCollectives(subject, store, reported);
    expect(
      yield* Effect.flip(collectives.send(gatherSend(question))),
    ).toMatchObject({ reason: "outcome-unknown" });
    expect(reported).toEqual([fault]);
    const retained = yield* store.readCollectiveOperations();
    const admitted = yield* Effect.fromNullable(original);
    expect(retained).toHaveLength(1);
    expect(retained[0]).toMatchObject({
      operationId: admitted.operationId,
      canonicalRequest: admitted.canonicalRequest,
      canonicalDescriptor: admitted.canonicalDescriptor,
      phase: "collecting",
      origin: { kind: "local" },
    });
    expect(yield* store.readCollectiveMessages()).toEqual([]);
    return { directory: subject.directory, retained };
  });
}

function admittingCollectives(
  subject: Fixture,
  store: DaemonStore,
  reported: EndpointStoreError[],
) {
  return Effect.gen(function* () {
    const { engine } = subject;
    return yield* makeCollectiveOperations({
      store,
      self: testAgentView("agent:alice"),
      scope: yield* Scope.Scope,
      sendMessage: (input) => engine.send(input),

      prepareMessage: (input) => engine.prepare(input),
      acceptMessage: (prepared, hold) => engine.accept(prepared, hold),
      observeMessage: (msgId) => engine.observeMessage(msgId),
      reportStorageFault: (error) =>
        Effect.sync(() => {
          reported.push(error);
        }),
      emit: () => Effect.dieMessage("no result precedes gather request fanout"),
    });
  });
}
