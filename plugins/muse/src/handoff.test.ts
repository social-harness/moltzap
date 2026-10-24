/** @file Real filesystem handoffs preserve receipt ownership until the matching worker accepts. */
import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { scopedLive as it, scoped as withClock } from "@effect/vitest";
import {
  Clock,
  ConfigProvider,
  Effect,
  Fiber,
  Option,
  Ref,
  TestClock,
} from "effect";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { acceptMuseWork, detectMuseWork, makeMuseWakeup } from "./index.js";

const eventId = `evt_${"A".repeat(43)}`;
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped({
    prefix: "sharness-muse-",
  });
  const wake = yield* makeMuseWakeup(directory);
  const receipts = yield* Ref.make(0);
  const receive = (reference = eventId) =>
    wake({
      eventId: reference,
      acknowledge: Ref.update(receipts, (count) => count + 1),
    });
  return { directory, receive, receipts };
});
type Fixture = Effect.Effect.Success<typeof fixture>;

function staysIdle() {
  return inDirectory(({ directory }) =>
    Effect.gen(function* () {
      expect(yield* detectMuseWork(directory)).toEqual([]);
    }),
  );
}

function waitsForWorker() {
  return inDirectory(({ directory, receive, receipts }) =>
    Effect.gen(function* () {
      const waiting = yield* receive().pipe(Effect.forkScoped);
      const work = yield* nextWork(directory);
      expect(work.eventId).toBe(eventId);
      expect(
        Object.keys(work).sort((left, right) => left.localeCompare(right)),
      ).toEqual(["attempt", "eventId", "expiresAt"]);
      expect(yield* detectMuseWork(directory)).toEqual([]);
      expect(yield* Ref.get(receipts)).toBe(0);
      yield* acceptMuseWork(directory, work.attempt, eventId);
      yield* Fiber.join(waiting);
      expect(yield* Ref.get(receipts)).toBe(1);
      expect(yield* detectMuseWork(directory)).toEqual([]);
      expect(
        yield* acceptMuseWork(directory, work.attempt, eventId).pipe(
          Effect.flip,
        ),
      ).toMatchObject({ reason: "refused" });
      expect(yield* Ref.get(receipts)).toBe(1);
    }),
  );
}

function rejectsWrongEvent() {
  return inDirectory(({ directory, receive, receipts }) =>
    Effect.gen(function* () {
      const waiting = yield* receive().pipe(Effect.forkScoped);
      const work = yield* nextWork(directory);
      expect(
        yield* acceptMuseWork(directory, work.attempt, "another-event").pipe(
          Effect.flip,
        ),
      ).toMatchObject({ reason: "refused" });
      expect(yield* Ref.get(receipts)).toBe(0);
      expect(Option.isNone(yield* Fiber.poll(waiting))).toBe(true);
      yield* acceptMuseWork(directory, work.attempt, eventId);
      yield* Fiber.join(waiting);
      expect(yield* Ref.get(receipts)).toBe(1);
    }),
  );
}

function fencesOldWorker() {
  return inDirectory(({ directory, receive, receipts }) =>
    Effect.gen(function* () {
      const oldReceiver = yield* receive().pipe(Effect.forkScoped);
      const oldWork = yield* nextWork(directory);
      yield* Fiber.interrupt(oldReceiver);
      expect(yield* Ref.get(receipts)).toBe(0);
      const replacement = yield* receive().pipe(Effect.forkScoped);
      const work = yield* nextWork(directory);
      expect(work.attempt).not.toBe(oldWork.attempt);
      expect(
        yield* acceptMuseWork(directory, oldWork.attempt, eventId).pipe(
          Effect.flip,
        ),
      ).toMatchObject({ reason: "refused" });
      expect(Option.isNone(yield* Fiber.poll(replacement))).toBe(true);
      expect(yield* Ref.get(receipts)).toBe(0);
      yield* acceptMuseWork(directory, work.attempt, eventId);
      yield* Fiber.join(replacement);
      expect(yield* Ref.get(receipts)).toBe(1);
    }),
  );
}

function announcesOnce() {
  return inDirectory(({ directory, receive, receipts }) =>
    Effect.gen(function* () {
      const waiting = yield* receive().pipe(Effect.forkScoped);
      const references = yield* Effect.all(
        [detectMuseWork(directory), detectMuseWork(directory)],
        { concurrency: 2 },
      ).pipe(
        Effect.map((batches) => batches.flat()),
        Effect.repeat({ until: (batch) => batch.length > 0 }),
      );
      expect(references).toHaveLength(1);
      const work = references[0];
      if (work === undefined) {
        return yield* Effect.dieMessage("Expected native work reference");
      }
      expect(yield* Ref.get(receipts)).toBe(0);
      yield* acceptMuseWork(directory, work.attempt, eventId);
      yield* Fiber.join(waiting);
      expect(yield* Ref.get(receipts)).toBe(1);
    }),
  );
}

function expiresWork() {
  return inDirectory(({ directory, receive, receipts }) =>
    Effect.gen(function* () {
      const waiting = yield* receive().pipe(Effect.either, Effect.forkScoped);
      yield* nextWork(directory);
      yield* TestClock.adjust("5 minutes");
      expect(yield* Fiber.join(waiting)).toMatchObject({
        _tag: "Left",
        left: { reason: "timed-out" },
      });
      expect(yield* Ref.get(receipts)).toBe(0);
      expect(yield* detectMuseWork(directory)).toEqual([]);
    }),
  );
}

function ignoresExpiredReference() {
  return inDirectory(({ directory }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const work = yield* seedReference(directory, -1);
      expect(yield* detectMuseWork(directory)).toEqual([]);
      expect(
        yield* acceptMuseWork(directory, work.attempt, eventId).pipe(
          Effect.flip,
        ),
      ).toMatchObject({ reason: "refused" });
      expect(yield* fs.exists(join(directory, work.attempt))).toBe(true);
    }),
  );
}

function fencesCrashReference() {
  return inDirectory(({ directory, receive, receipts }) =>
    Effect.gen(function* () {
      const orphan = yield* seedReference(directory, 60000);
      expect(yield* detectMuseWork(directory)).toEqual([orphan]);
      const waiting = yield* receive().pipe(Effect.forkScoped);
      const replacement = yield* nextWork(directory);
      yield* acceptMuseWork(directory, orphan.attempt, eventId);
      yield* TestClock.adjust("1 second");
      expect(yield* Ref.get(receipts)).toBe(0);
      expect(Option.isNone(yield* Fiber.poll(waiting))).toBe(true);
      yield* acceptMuseWork(directory, replacement.attempt, eventId);
      yield* TestClock.adjust("1 second");
      yield* Fiber.join(waiting);
      expect(yield* Ref.get(receipts)).toBe(1);
    }),
  );
}

function skipsCorruptReference() {
  return inDirectory(({ directory, receive, receipts }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const corrupt = yield* seedReference(directory, 60000);
      yield* fs.writeFileString(
        join(directory, corrupt.attempt, "work.json"),
        "{",
      );
      const waiting = yield* receive().pipe(Effect.forkScoped);
      const work = yield* nextWork(directory);
      expect(work.attempt).not.toBe(corrupt.attempt);
      expect(
        yield* acceptMuseWork(directory, corrupt.attempt, eventId).pipe(
          Effect.flip,
        ),
      ).toMatchObject({ reason: "decode-failed" });
      expect(yield* Ref.get(receipts)).toBe(0);
      yield* acceptMuseWork(directory, work.attempt, eventId);
      yield* Fiber.join(waiting);
      expect(yield* Ref.get(receipts)).toBe(1);
    }),
  );
}

function rejectsPathAttempt() {
  return inDirectory(({ directory, receipts }) =>
    Effect.gen(function* () {
      expect(
        yield* acceptMuseWork(directory, "../other-installation", eventId).pipe(
          Effect.flip,
        ),
      ).toMatchObject({ reason: "refused" });
      expect(yield* Ref.get(receipts)).toBe(0);
    }),
  );
}

/** Crash leftovers enter through the persisted reference format, without a live owning receiver. */
function seedReference(directory: string, remainingMilliseconds: number) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const work = {
      attempt: randomUUID(),
      eventId,
      expiresAt: (yield* Clock.currentTimeMillis) + remainingMilliseconds,
    };
    const path = join(directory, work.attempt);
    yield* fs.makeDirectory(path);
    yield* fs.writeFileString(join(path, "work.json"), JSON.stringify(work));
    return work;
  });
}

function inDirectory<E, R>(run: (value: Fixture) => Effect.Effect<void, E, R>) {
  return Effect.flatMap(fixture, run).pipe(
    Effect.provide(NodeFileSystem.layer),
    Effect.withConfigProvider(ConfigProvider.fromMap(new Map())),
  );
}

function nextWork(directory: string) {
  return detectMuseWork(directory).pipe(
    Effect.repeat({ until: (references) => references.length > 0 }),
    Effect.flatMap(([work]) =>
      work === undefined
        ? Effect.dieMessage("Expected native work reference")
        : Effect.succeed(work),
    ),
  );
}

describe("Muse native handoff", () => {
  it("stays silent without pending work or credentials", staysIdle);
  it(
    "waits for worker acceptance after a credential-free notice",
    waitsForWorker,
  );
  it("refuses a different event without acknowledging", rejectsWrongEvent);
  it("fences an interrupted worker from replacement work", fencesOldWorker);
  it("announces once when native detector calls overlap", announcesOnce);
  withClock(
    "expires unaccepted work without acknowledging",
    expiresWork,
    15000,
  );
  it(
    "ignores expired references left by a killed receiver",
    ignoresExpiredReference,
  );
  withClock(
    "keeps crash-reference confirmation separate from replacement receipt",
    fencesCrashReference,
  );
  it(
    "delivers valid work alongside a corrupt reference",
    skipsCorruptReference,
  );
  it("refuses a path-like worker attempt", rejectsPathAttempt);
});
