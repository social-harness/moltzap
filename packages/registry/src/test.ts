/** @file Condition-only process composition for adjacent wire releases. */
import { WireVersions } from "@moltzap/social-harness/test";
import { Data, Effect, Layer } from "effect";
import { installInternalResolution } from "./internal-resolution.js";
import { runRegistryMain } from "./main.js";

/** A startup module that fails to load, with its cause in the reported message. */
class RegistryModuleLoadError extends Data.TaggedError(
  "RegistryModuleLoadError",
)<{
  readonly cause: unknown;
  readonly message: string;
}> {}

/**
 * Starts Registry with explicit wire compatibility sets and its ordinary
 * environment settings.
 *
 * The supplied history extends the library's built-in retained history.
 * Importing this module leaves export conditions unchanged. Calling
 * `startRegistry` enables the scoped conditions described by
 * `installInternalResolution`. Startup failures print their message to stderr
 * and produce an unsuccessful process exit, as with `sharness-registry`.
 */
export function startRegistry(versions: {
  readonly emitted: string;
  readonly live: readonly string[];
  readonly history: readonly string[];
}): void {
  installInternalResolution();
  Effect.gen(function* () {
    const { layer } = yield* Effect.tryPromise({
      try: () => import("./server.js"),
      catch: (cause) =>
        new RegistryModuleLoadError({
          cause,
          message: `Could not load Registry startup module ./server.js: ${cause instanceof Error ? cause.message : String(cause)}`,
        }),
    });
    return yield* Layer.launch(layer).pipe(
      Effect.provideService(WireVersions, versions),
    );
  }).pipe(Effect.withSpan("startRegistry"), runRegistryMain);
}
