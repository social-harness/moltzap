/** @file Condition-only process composition for adjacent wire releases. */
import { WireVersions } from "@moltzap/client/test";
import { Data, Effect, Layer } from "effect";
import { installInternalResolution } from "./internal-resolution.js";
import { runRouterMain } from "./main.js";

/** A startup module that fails to load, with its cause in the reported message. */
class RouterModuleLoadError extends Data.TaggedError("RouterModuleLoadError")<{
  readonly cause: unknown;
  readonly message: string;
}> {}

/** Internal Identity capabilities stay within the Router process boundary. */
export function startRouter(versions: {
  readonly emitted: string;
  readonly live: readonly string[];
  readonly history: readonly string[];
}): void {
  installInternalResolution();
  Effect.gen(function* () {
    const { RouterServer } = yield* Effect.tryPromise({
      try: () => import("./server.js"),
      catch: (cause) =>
        new RouterModuleLoadError({
          cause,
          message: `Could not load Router startup module ./server.js: ${cause instanceof Error ? cause.message : String(cause)}`,
        }),
    });
    return yield* Layer.launch(RouterServer.layer).pipe(
      Effect.provideService(WireVersions, versions),
    );
  }).pipe(Effect.withSpan("startRouter"), runRouterMain);
}
