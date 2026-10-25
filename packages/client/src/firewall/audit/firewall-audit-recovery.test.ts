/** @file Recovery preserves live writers and stored evidence under hostile paths or clock rollback. */

import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { scopedLive as it } from "@effect/vitest";
import { Clock, Deferred, Effect, Fiber } from "effect";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { awaitStage } from "../../__tests__/daemon-runtime-harness.js";
import {
  decodeAudit,
  makeAuditFixture,
} from "../../__tests__/firewall-audit-fixtures.js";
import {
  stateDirectory,
  withStore,
} from "../../__tests__/store-schema-fixtures.js";
import { openEndpointStore } from "../../communication/store/index.js";
import { LIVE_WIRE_VERSIONS } from "../../identity/wire-version.js";
import { beginFirewallAudit } from "./firewall-audit.js";

type UnsafeStaging = "symlink" | "hardlink" | "directory" | "public-file";
const RETAINED_CONTENT = "retain this operator evidence";

function unsafeStaging(kind: UnsafeStaging, target: string, staging: string) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    switch (kind) {
      case "symlink":
        return yield* fileSystem.symlink(target, staging);
      case "hardlink":
        return yield* fileSystem.link(target, staging);
      case "directory":
        return yield* fileSystem.makeDirectory(staging);
      case "public-file":
        yield* fileSystem.writeFileString(staging, RETAINED_CONTENT);
        // eslint-disable-next-line sonarjs/file-permissions -- The staging file is deliberately unsafe and must be left untouched.
        return yield* fileSystem.chmod(staging, 0o644);
      default:
        return yield* Effect.dieMessage("unknown unsafe staging fixture");
    }
  });
}

function refusesUnsafeStaging(kind: UnsafeStaging) {
  return Effect.gen(function* () {
    const directory = stateDirectory();
    const path = join(directory, "audit.ndjson");
    const staging = `${path}.partial`;
    const target = join(directory, "operator-file");
    const fileSystem = yield* FileSystem.FileSystem;
    const store = yield* openEndpointStore(directory, {
      liveWireVersions: LIVE_WIRE_VERSIONS,
    });
    yield* (yield* beginFirewallAudit(path, store)).finish;
    const published = yield* fileSystem.readFileString(path);
    yield* fileSystem.writeFileString(target, RETAINED_CONTENT);
    yield* fileSystem.chmod(target, 0o600);
    yield* unsafeStaging(kind, target, staging);
    expect(yield* Effect.flip(beginFirewallAudit(path, store))).toMatchObject({
      reason: "path",
    });
    expect(yield* fileSystem.exists(staging)).toBe(true);
    expect(yield* fileSystem.readFileString(target)).toBe(RETAINED_CONTENT);
    expect(yield* fileSystem.readFileString(path)).toBe(published);
  }).pipe(Effect.provide(NodeFileSystem.layer));
}

const competingWriterPreservesStaging = () =>
  Effect.gen(function* () {
    const path = join(stateDirectory(), "audit.ndjson");
    const entered = yield* Deferred.make<undefined>();
    const release = yield* Deferred.make<undefined>();
    const fileSystem = yield* FileSystem.FileSystem;
    const audit = yield* beginFirewallAudit(path, {
      readFirewallActivations: () => Effect.succeed([]),
      readFirewallAuditPage: () =>
        Deferred.succeed(entered, undefined).pipe(
          Effect.zipRight(Deferred.await(release)),
          Effect.as([]),
        ),
    });
    yield* Effect.gen(function* () {
      const first = yield* audit.finish.pipe(Effect.forkScoped);
      yield* awaitStage(Deferred.await(entered), "active snapshot write");
      const staging = yield* fileSystem.readFileString(`${path}.partial`);
      expect(yield* Effect.flip(audit.finish)).toMatchObject({
        reason: "persistence",
      });
      expect(yield* fileSystem.readFileString(`${path}.partial`)).toBe(staging);
      yield* Deferred.succeed(release, undefined);
      yield* awaitStage(Fiber.join(first), "first snapshot publication");
      const snapshot = decodeAudit(yield* fileSystem.readFileString(path));
      expect(snapshot.records.at(-1)).toMatchObject({
        kind: "complete",
        checkCount: 0,
        sha256: snapshot.sha256,
      });
      expect(yield* fileSystem.exists(`${path}.partial`)).toBe(false);
    }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
  }).pipe(Effect.provide(NodeFileSystem.layer));

/** A real middleware call observes a wall clock that steps backward on every read. */
const rollbackFixture = Effect.suspend(() => {
  const clock = Clock.make();
  let time = 1_000_000;
  clock.unsafeCurrentTimeMillis = () => {
    time -= 100;
    return time;
  };
  return makeAuditFixture.pipe(Effect.withClock(clock));
});

const preservesClockRollback = () =>
  Effect.gen(function* () {
    const directory = stateDirectory();
    const path = join(directory, "audit.ndjson");
    const fixture = yield* rollbackFixture;
    const elapsed = fixture.result.checks[0]?.elapsedMilliseconds;
    expect(elapsed).toBeLessThan(0);
    yield* withStore(directory, (store) =>
      store
        .beginFirewallAttempt({
          ...fixture,
          checkId: "clock-rollback",
          direction: "outgoing",
          revision: 0,
        })
        .pipe(
          Effect.zipRight(
            store.admitFirewallOperation(
              {
                checkId: "clock-rollback",
                admit: false,
                canonicalResult: fixture.canonicalResult,
              },
              fixture.canonicalCandidate,
            ),
          ),
        ),
    );
    const store = yield* openEndpointStore(directory, {
      liveWireVersions: LIVE_WIRE_VERSIONS,
    });
    yield* (yield* beginFirewallAudit(path, store)).finish;
    const fileSystem = yield* FileSystem.FileSystem;
    const snapshot = decodeAudit(yield* fileSystem.readFileString(path));
    expect(snapshot.records[1]).toMatchObject({
      kind: "check",
      checkId: "clock-rollback",
      result: { checks: [{ elapsedMilliseconds: elapsed }] },
    });
    expect(snapshot.records.at(-1)).toMatchObject({
      kind: "complete",
      checkCount: 1,
      sha256: snapshot.sha256,
    });
  }).pipe(Effect.provide(NodeFileSystem.layer));

describe("audit staging recovery", () => {
  it.each([
    { kind: "symlink" },
    { kind: "hardlink" },
    { kind: "directory" },
    { kind: "public-file" },
  ] as const)("preserves unsafe $kind staging entries", (example) =>
    refusesUnsafeStaging(example.kind),
  );
  it(
    "does not remove another active writer's staging file",
    competingWriterPreservesStaging,
  );
  it(
    "exports persisted negative elapsed time after a clock rollback and restart",
    preservesClockRollback,
  );
});
