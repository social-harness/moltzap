/** @file Real HTTP cancellation cannot publish an audit before request finalizers write. */

import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { scopedLive as it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Option, Schema } from "effect";
import { join } from "node:path";
import { describe, expect } from "vitest";
import type { HarnessMcpEventHandler } from "../harness/mcp/tools.js";
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
import { SendInput } from "../communication/collectives/forms.js";
import { openEndpointStore } from "../communication/store/index.js";
import { acquireHarnessEndpoint } from "../harness/endpoint/index.js";
import { acquireHarnessMcpHttpServer } from "../harness/mcp/http.js";
import { LIVE_WIRE_VERSIONS } from "../identity/wire-version.js";

const CHECK_ID = "request-check";

const makeHttpFixture = Effect.gen(function* () {
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
  return {
    fixture,
    harness,
    store,
    path: join(directory, "audit.ndjson"),
    evidence: yield* makeAuditFixture,
    started: yield* Deferred.make<undefined>(),
    finalizing: yield* Deferred.make<undefined>(),
    release: yield* Deferred.make<undefined>(),
    endpoint: yield* Deferred.make<URL>(),
  };
});

type HttpFixture = Effect.Effect.Success<typeof makeHttpFixture>;

function finalizerBarrierSend(fixture: HttpFixture) {
  const finalize = Effect.gen(function* () {
    yield* Deferred.succeed(fixture.finalizing, undefined);
    yield* Deferred.await(fixture.release);
    yield* fixture.store.admitFirewallOperation(
      {
        checkId: CHECK_ID,
        admit: false,
        canonicalResult: fixture.evidence.canonicalResult,
      },
      fixture.evidence.canonicalCandidate,
    );
  }).pipe(Effect.orDie);
  return Effect.gen(function* () {
    yield* fixture.store.beginFirewallAttempt({
      ...fixture.evidence,
      checkId: CHECK_ID,
      direction: "outgoing",
      revision: 0,
    });
    yield* Deferred.succeed(fixture.started, undefined);
    return yield* Effect.never;
  }).pipe(Effect.orDie, Effect.ensuring(finalize));
}

function listen(fixture: HttpFixture, handler: HarnessMcpEventHandler) {
  return Effect.gen(function* () {
    const server = yield* acquireHarnessMcpHttpServer({ port: 0, handler });
    const address = server.address();
    if (address === null || typeof address === "string") {
      return yield* Effect.dieMessage("expected a loopback TCP listener");
    }
    yield* Deferred.succeed(
      fixture.endpoint,
      new URL(`http://127.0.0.1:${address.port}/mcp`),
    );
  });
}

function httpHarness(fixture: HttpFixture): RuntimeHarness {
  const harness = fixture.harness;
  return {
    ...harness,
    dependencies: {
      ...harness.dependencies,
      acquireListener: ({ handler }) => listen(fixture, handler),
      makeHandler: (options) =>
        harness.dependencies.makeHandler({
          ...options,
          operations: {
            ...options.operations,
            send: () => finalizerBarrierSend(fixture),
          },
        }),
    },
  };
}

function assertCompleted(fixture: HttpFixture) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const { records, sha256 } = decodeAudit(
      yield* fileSystem.readFileString(fixture.path),
    );
    expect(records.map((record) => record.kind)).toEqual([
      "start",
      "check",
      "complete",
    ]);
    expect(records[1]).toMatchObject({
      kind: "check",
      checkId: CHECK_ID,
      disposition: "withheld",
      result: fixture.evidence.result,
    });
    expect(records.at(-1)).toMatchObject({
      kind: "complete",
      checkCount: 1,
      sha256,
    });
    expect((yield* fixture.store.readFirewallAuditPage(0))[0]).toMatchObject({
      disposition: "withheld",
    });
  });
}

/**
 * The bounded observation outlasts HTTP response draining so a closed response
 * cannot conceal a request finalizer that is still able to change the snapshot.
 */
function exerciseCancellation(
  fixture: HttpFixture,
  trigger: "request" | "daemon",
) {
  return Effect.gen(function* () {
    const runtime = yield* run(
      fixture.fixture,
      fixture.store,
      httpHarness(fixture),
      fixture.path,
    ).pipe(Effect.forkScoped);
    const endpoint = yield* acquireHarnessEndpoint(
      yield* awaitStage(Deferred.await(fixture.endpoint), "listener"),
    );
    const input = yield* Schema.decodeUnknown(SendInput)({
      to: "agent:bob",
      text: "hello",
    });
    const request = yield* endpoint.send(input).pipe(Effect.forkScoped);
    yield* awaitStage(Deferred.await(fixture.started), "unkeyed send");
    yield* trigger === "request"
      ? Fiber.interruptFork(request)
      : Fiber.interruptFork(runtime);
    yield* awaitStage(Deferred.await(fixture.finalizing), "request finalizer");
    if (trigger === "request") {
      expect(Option.isNone(yield* Fiber.poll(runtime))).toBe(true);
      yield* Fiber.interruptFork(runtime);
    }
    const prematureExit = yield* Fiber.await(runtime).pipe(
      Effect.timeoutOption("2 seconds"),
    );
    expect(Option.isNone(prematureExit)).toBe(true);
    const fileSystem = yield* FileSystem.FileSystem;
    expect(
      decodeAudit(yield* fileSystem.readFileString(fixture.path)).records.map(
        (record) => record.kind,
      ),
    ).toEqual(["start"]);
    yield* Deferred.succeed(fixture.release, undefined);
    yield* awaitStage(Fiber.await(runtime), "joined request and snapshot");
    yield* assertCompleted(fixture);
  });
}

describe("HTTP request audit shutdown", () => {
  it.each([{ trigger: "request" }, { trigger: "daemon" }] as const)(
    "joins unkeyed send finalizers after $trigger cancellation before publishing completion",
    (example) =>
      makeHttpFixture.pipe(
        Effect.flatMap((fixture) =>
          exerciseCancellation(fixture, example.trigger).pipe(
            Effect.ensuring(Deferred.succeed(fixture.release, undefined)),
          ),
        ),
        Effect.provide(NodeFileSystem.layer),
      ),
    { timeout: 30000 },
  );
});
