/** @file Stores event references so Muse can wake its worker without copying messages. */

import type { FileSystem } from "@effect/platform";
import { Effect, Schema } from "effect";
import { join } from "node:path";
import { MuseWakeError } from "./errors.js";

/** An attempt is a local correlation value, not authentication or delivery authority. */
const museWork = Schema.Struct({
  attempt: Schema.UUID,
  eventId: Schema.NonEmptyString,
  expiresAt: Schema.Number.pipe(Schema.int(), Schema.positive()),
});

/** Only the owning receiver's live attempt can observe a matching worker confirmation. */
export type MuseWork = typeof museWork.Type;

/** Publication is atomic so the detector cannot observe a partially written reference. */
export const writeWork = Effect.fn("Muse.writeWork")(function* (
  fs: FileSystem.FileSystem,
  directory: string,
  work: MuseWork,
) {
  const bytes = yield* Schema.encode(Schema.parseJson(museWork))(work);
  const staging = join(directory, "publishing");
  yield* fs.writeFileString(staging, bytes, { mode: 0o600, flag: "wx" });
  yield* fs.rename(staging, join(directory, "work.json"));
});

/** The worker and detector share the receiver's reference format without reconstructing a Client item. */
export function readWork(fs: FileSystem.FileSystem, directory: string) {
  return readOptionalFile(fs, join(directory, "work.json")).pipe(
    Effect.flatMap((bytes) =>
      bytes === undefined
        ? Effect.succeed(undefined)
        : Schema.decode(Schema.parseJson(museWork))(bytes).pipe(
            Effect.catchTag("ParseError", () =>
              Effect.fail(new MuseWakeError({ reason: "decode-failed" })),
            ),
          ),
    ),
  );
}

/** Absence is normal while a reference is being published or released. Other I/O failures remain failures. */
export function readOptionalFile(fs: FileSystem.FileSystem, path: string) {
  return fs.readFileString(path).pipe(
    Effect.catchTags({
      SystemError: (error) =>
        error.reason === "NotFound"
          ? Effect.succeed(undefined)
          : Effect.fail(new MuseWakeError({ reason: "transport-failed" })),
      BadArgument: () =>
        Effect.fail(new MuseWakeError({ reason: "transport-failed" })),
    }),
  );
}

/** Exclusive creation lets overlapping native detector invocations emit one wake per attempt. */
export function createMarker(
  fs: FileSystem.FileSystem,
  path: string,
  bytes: string,
) {
  return fs.writeFileString(path, bytes, { flag: "wx", mode: 0o600 }).pipe(
    Effect.as(true),
    Effect.catchTag("SystemError", (error) =>
      error.reason === "AlreadyExists" || error.reason === "NotFound"
        ? Effect.succeed(false)
        : Effect.fail(new MuseWakeError({ reason: "transport-failed" })),
    ),
    Effect.catchTag("BadArgument", () =>
      Effect.fail(new MuseWakeError({ reason: "transport-failed" })),
    ),
  );
}
