/** @file Condition-only process composition for adjacent wire releases. */
import { WireVersions } from "@moltzap/client/test";
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

/** Internal Identity capabilities stay within the Registry process boundary. */
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
