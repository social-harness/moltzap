/** @file Condition-only process composition for adjacent wire releases. */
import { Effect, Layer } from "effect";
import { installInternalResolution } from "./internal-resolution.js";
import { RegistryModuleLoadError, runRegistryMain } from "./main.js";

/** Internal Identity capabilities stay within the Registry process boundary. */
export function startRegistry(versions: {
  readonly emitted: string;
  readonly live: readonly string[];
  readonly history: readonly string[];
}): void {
  installInternalResolution();
  Effect.gen(function* () {
    const { WireVersions } = yield* Effect.tryPromise({
      try: () => import("@moltzap/identity/test"),
      catch: (cause) =>
        new RegistryModuleLoadError({
          cause,
          message:
            "Could not load Registry startup module @moltzap/identity/test",
        }),
    });
    const { layer } = yield* Effect.tryPromise({
      try: () => import("./server.js"),
      catch: (cause) =>
        new RegistryModuleLoadError({
          cause,
          message: "Could not load Registry startup module ./server.js",
        }),
    });
    return yield* Layer.launch(layer).pipe(
      Effect.provideService(WireVersions, versions),
    );
  }).pipe(Effect.withSpan("startRegistry"), runRegistryMain);
}
