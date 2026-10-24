/** @file Muse's credential-free hook hands an immutable work reference to a started native worker. */

import type { InboundDelivery } from "@moltzap/client";
import { FileSystem } from "@effect/platform";
import { Clock, Duration, Effect, Schedule } from "effect";
import { randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { MuseWakeError } from "./errors.js";
import { type MuseWork, readOptionalFile, writeWork } from "./work.js";

/** Native commands access references only, never Client credentials or receipts. */
export { acceptMuseWork, detectMuseWork } from "./worker.js";

const acceptanceBudget = Duration.minutes(5);

type MuseDelivery = Pick<InboundDelivery, "eventId" | "acknowledge">;

/**
 * Publishes an event reference while Client retains its consumer and lease.
 * Only a started worker's matching acceptance permits acknowledgment. Detector
 * output alone cannot acknowledge a message. A crash may cause another wake for
 * the same event; callers must not assume exactly-once model execution.
 *
 * ```mermaid
 * flowchart TD
 *   Client[Client delivery] --> Reference[Local event and attempt reference]
 *   Reference --> Hook[Credential-free Muse hook]
 *   Hook --> Worker[Started native worker reads canonical event]
 *   Worker --> Confirmation[Confirm matching attempt]
 *   Confirmation --> Handoff[Acknowledge through Client]
 * ```
 *
 * @param directory Persistent runtime directory shared with the native hook and worker.
 * @returns A handoff that waits up to five minutes without owning message transport.
 */
export const makeMuseWakeup = Effect.fn("Muse.makeWakeup")(function* (
  directory: string,
) {
  if (!isAbsolute(directory)) {
    return yield* Effect.fail(
      new MuseWakeError({ reason: "invalid-configuration" }),
    );
  }
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 }).pipe(
    Effect.catchTags({
      BadArgument: () =>
        Effect.fail(new MuseWakeError({ reason: "invalid-configuration" })),
      SystemError: () =>
        Effect.fail(new MuseWakeError({ reason: "invalid-configuration" })),
    }),
  );
  const wake = (delivery: MuseDelivery) =>
    awaitWorker(fs, directory, delivery.eventId).pipe(
      Effect.scoped,
      Effect.catchTags({
        BadArgument: () =>
          Effect.fail(new MuseWakeError({ reason: "transport-failed" })),
        SystemError: () =>
          Effect.fail(new MuseWakeError({ reason: "transport-failed" })),
        ParseError: () =>
          Effect.fail(new MuseWakeError({ reason: "decode-failed" })),
      }),
      Effect.timeoutFail({
        duration: acceptanceBudget,
        onTimeout: () => new MuseWakeError({ reason: "timed-out" }),
      }),
      Effect.andThen(delivery.acknowledge),
    );
  return wake;
});

function awaitWorker(
  fs: FileSystem.FileSystem,
  directory: string,
  eventId: string,
) {
  return Effect.gen(function* () {
    const attempt = yield* Effect.sync(randomUUID);
    const path = join(directory, attempt);
    yield* Effect.acquireRelease(fs.makeDirectory(path, { mode: 0o700 }), () =>
      fs
        .remove(path, { recursive: true, force: true })
        .pipe(
          Effect.catchAll(() =>
            Effect.logWarning("Muse work-reference cleanup failed"),
          ),
        ),
    );
    const work: MuseWork = {
      attempt,
      eventId,
      expiresAt:
        (yield* Clock.currentTimeMillis) + Duration.toMillis(acceptanceBudget),
    };
    yield* writeWork(fs, path, work);
    yield* readOptionalFile(fs, join(path, "accepted")).pipe(
      Effect.map((accepted) => accepted === eventId),
      Effect.repeat({
        schedule: Schedule.spaced("250 millis"),
        until: (accepted) => accepted,
      }),
    );
  });
}
