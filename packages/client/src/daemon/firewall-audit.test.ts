/** @file Snapshot publication follows resource shutdown while the endpoint store remains open. */

import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { scopedLive as it } from "@effect/vitest";
import { Cause, Deferred, Effect, Exit, Fiber, Option } from "effect";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { makeFixture } from "../__tests__/daemon-runtime-fixtures.js";
import {
  awaitStage,
  makeHarness,
  run,
  type RuntimeHarness,
} from "../__tests__/daemon-runtime-harness.js";
import {
  decodeAudit,
  makeAuditFixture,
} from "../__tests__/firewall-audit-fixtures.js";
import { stateDirectory } from "../__tests__/store-schema-fixtures.js";
import { openEndpointStore } from "../communication/store/index.js";
import { LIVE_WIRE_VERSIONS } from "../identity/wire-version.js";

function auditKinds(text: string) {
  return decodeAudit(text).records.map((entry) => entry.kind);
}

const makeAuditedRuntime = Effect.gen(function* () {
  const directory = stateDirectory();
  const fixture = yield* makeFixture;
  const harness = yield* makeHarness(fixture, "none");
  harness.delivery.acknowledged = true;
  const store = yield* openEndpointStore(directory, {
    liveWireVersions: LIVE_WIRE_VERSIONS,
  });
  yield* store.bindIdentity({
    agentId: fixture.localCard.agentId,
    canonicalAgentCard: fixture.canonicalLocalCard,
  });
  return { fixture, harness, store, path: join(directory, "audit.ndjson") };
});

function withWorkerFinalizer(
  harness: RuntimeHarness,
  stoppedWrite: Effect.Effect<void>,
): RuntimeHarness {
  return {
    ...harness,
    dependencies: {
      ...harness.dependencies,
      makeWorker: (input) =>
        harness.dependencies.makeWorker(input).pipe(
          Effect.map((worker) => ({
            ...worker,
            run: worker.run.pipe(Effect.ensuring(stoppedWrite)),
          })),
        ),
    },
  };
}

const readsOnlyAfterWorkersStop = () =>
  Effect.gen(function* () {
    const { fixture, harness, store, path } = yield* makeAuditedRuntime;
    const evidence = yield* makeAuditFixture;
    const stopping = yield* Deferred.make<undefined>();
    const release = yield* Deferred.make<undefined>();
    const fileSystem = yield* FileSystem.FileSystem;
    const stoppedWrite = Effect.gen(function* () {
      yield* Deferred.succeed(stopping, undefined);
      yield* Deferred.await(release);
      yield* store.beginFirewallAttempt({
        ...evidence,
        checkId: "last-worker-write",
        direction: "outgoing",
        revision: 0,
      });
    }).pipe(Effect.orDie);
    const fiber = yield* run(
      fixture,
      store,
      withWorkerFinalizer(harness, stoppedWrite),
      path,
    ).pipe(Effect.forkScoped);
    yield* awaitStage(Deferred.await(harness.listenerReady), "listener");
    expect(auditKinds(yield* fileSystem.readFileString(path))).toEqual([
      "start",
    ]);
    yield* Fiber.interruptFork(fiber);
    yield* awaitStage(Deferred.await(stopping), "worker finalizer");
    expect(auditKinds(yield* fileSystem.readFileString(path))).toEqual([
      "start",
    ]);
    yield* Deferred.succeed(release, undefined);
    const exit = yield* awaitStage(Fiber.await(fiber), "shutdown snapshot");
    expect(Exit.isFailure(exit) && Cause.isInterruptedOnly(exit.cause)).toBe(
      true,
    );
    const { records } = decodeAudit(yield* fileSystem.readFileString(path));
    expect(records[1]).toMatchObject({
      kind: "check",
      checkId: "last-worker-write",
      disposition: "checking",
      result: null,
    });
    expect(records.at(-1)).toMatchObject({ kind: "complete", checkCount: 1 });
    expect((yield* store.readFirewallAuditPage(0)).length).toBe(1);
  }).pipe(Effect.provide(NodeFileSystem.layer));

const invalidDestinationPreventsListening = () =>
  Effect.gen(function* () {
    const directory = stateDirectory();
    const fixture = yield* makeFixture;
    const harness = yield* makeHarness(fixture, "none");
    const store = yield* openEndpointStore(directory, {
      liveWireVersions: LIVE_WIRE_VERSIONS,
    });
    const error = yield* Effect.flip(
      run(fixture, store, harness, join(directory, "missing", "audit.ndjson")),
    );
    expect(error).toMatchObject({ phase: "storage" });
    expect(Option.isNone(yield* Deferred.poll(harness.listenerReady))).toBe(
      true,
    );
  });

const exportFailureFailsShutdown = () =>
  Effect.gen(function* () {
    const { fixture, harness, store, path } = yield* makeAuditedRuntime;
    const fiber = yield* run(fixture, store, harness, path).pipe(
      Effect.forkScoped,
    );
    yield* awaitStage(Deferred.await(harness.listenerReady), "listener");
    const evidence = yield* makeAuditFixture;
    yield* store.beginFirewallAttempt({
      ...evidence,
      checkId: "bad-input",
      direction: "outgoing",
      revision: 0,
      canonicalInput: new TextEncoder().encode("corrupt"),
    });
    const exit = yield* Fiber.interrupt(fiber);
    expect(Exit.isFailure(exit) && !Cause.isInterruptedOnly(exit.cause)).toBe(
      true,
    );
    const fileSystem = yield* FileSystem.FileSystem;
    expect(auditKinds(yield* fileSystem.readFileString(path))).toEqual([
      "start",
    ]);
  }).pipe(Effect.provide(NodeFileSystem.layer));

describe("daemon audit lifecycle", () => {
  it(
    "waits for workers before snapshotting and retains an open store until completion",
    readsOnlyAfterWorkersStop,
  );
  it(
    "fails startup before listening when its audit destination cannot be opened",
    invalidDestinationPreventsListening,
  );
  it(
    "propagates snapshot failure through shutdown without a complete footer",
    exportFailureFailsShutdown,
  );
});
