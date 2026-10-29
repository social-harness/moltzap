/** @file A committed gather admission remains ambiguous to its caller when the store response fails. */

import { resolvedMemberView } from "../../__tests__/firewall-runtime-fixtures.js";
import { live as it } from "@effect/vitest";
import { Effect, Schema, Scope } from "effect";
import { expect } from "vitest";
import {
  gatherSend,
  question,
} from "../../__tests__/firewall-collective-fixtures.js";
import {
  fixture,
  type Fixture,
  installation,
  pass,
  policy,
} from "../../__tests__/firewall-runtime-fixtures.js";
import { withStore } from "../../__tests__/store-schema-fixtures.js";
import { makeCollectiveOperations } from "../../communication/collectives/index.js";
import { AgentAddress } from "../../communication/records/index.js";
import {
  type CollectiveOperationInput,
  type EndpointStore,
  EndpointStoreError,
} from "../../communication/store/index.js";
import { collectiveAdmission } from "./index.js";

// @agent-code-guard/regression-only: Fault injection after the real admission transaction proves error classification and durable operation identity across reopen.

it("retains the admitted gather when its store response fails and reports outcome unknown", () =>
  Effect.gen(function* () {
    const { directory, retained } = yield* Effect.scoped(
      committedGatherFailure(),
    );
    expect(
      yield* withStore(directory, (store) => store.readCollectiveOperations()),
    ).toEqual(retained);
  }));

function committedGatherFailure() {
  return Effect.gen(function* () {
    const subject = yield* fixture;
    const fault = new EndpointStoreError({ reason: "persistence" });
    const reported: EndpointStoreError[] = [];
    let original: CollectiveOperationInput | undefined;
    const store: EndpointStore = {
      ...subject.store,
      admitFirewallOperation: (completion, candidate, operation) => {
        original = operation;
        return subject.store
          .admitFirewallOperation(completion, candidate, operation)
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
    expect(yield* store.readCollectivePosts()).toEqual([]);
    return { directory: subject.directory, retained };
  });
}

function admittingCollectives(
  subject: Fixture,
  store: EndpointStore,
  reported: EndpointStoreError[],
) {
  return Effect.gen(function* () {
    const installed = yield* installation(
      store,
      policy(() => Effect.succeed(pass)),
    );
    const { engine } = subject;
    return yield* makeCollectiveOperations({
      store,
      self: yield* Schema.decodeUnknown(AgentAddress)("agent:alice"),
      scope: yield* Scope.Scope,
      lookupMember: (member) => resolvedMemberView(engine, member),
      sendPost: (input) => engine.send(input),
      bindPost: (input, hold) => engine.bind(input, hold),
      sendAdmitted: (input, checkId) => engine.sendAdmitted(input, checkId),
      observePost: (postId) => engine.observePost(postId),
      reportStorageFault: (error) =>
        Effect.sync(() => {
          reported.push(error);
        }),
      emit: () => Effect.dieMessage("no result precedes gather request fanout"),
      admission: collectiveAdmission(
        { installed, store, localAgentCard: subject.local.card },
        engine,
      ),
    });
  });
}
