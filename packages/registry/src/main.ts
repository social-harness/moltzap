/** @file Registry process failure reporting and environment configuration. */
import { NodeRuntime } from "@effect/platform-node";
import { ConfigProvider, Console, Effect } from "effect";

/** Reports startup failure messages and runs the process with environment configuration. */
export function runRegistryMain<E extends { readonly message: string }>(
  program: Effect.Effect<void, E>,
): void {
  program.pipe(
    Effect.catchAll((error) =>
      Console.error(error.message).pipe(
        Effect.andThen(
          Effect.sync(() => {
            process.exitCode = 1;
          }),
        ),
      ),
    ),
    Effect.withConfigProvider(ConfigProvider.fromEnv()),
    NodeRuntime.runMain,
  );
}
