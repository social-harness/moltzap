/**
 * @file Runs the copied two-agents example with the packed Client and local
 * service images selected through SHARNESS_REGISTRY_IMAGE and SHARNESS_ROUTER_IMAGE.
 * The example supplies its own third-party dependencies. The gate passes when
 * Bob's endpoint delivers Alice's message within EXAMPLE_DEADLINE.
 */
import { FileSystem } from "@effect/platform";
import { Duration, Effect, Schema } from "effect";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type GateError,
  type GateServices,
  installPackedConsumer,
  PackGateError,
  packProductClosure,
  readJsonFile,
  requireCondition,
  runCommand,
  runGate,
} from "../../scripts/test/packed-workspace.js";

const workspaceRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const exampleRoot = join(workspaceRoot, "examples", "two-agents");

const exampleManifest = Schema.Struct({
  dependencies: Schema.Record({ key: Schema.String, value: Schema.String }),
});

/**
 * How long the example may run, startup and shutdown included. Its own run
 * timeout is two minutes; the rest covers a child that does not stop.
 */
const EXAMPLE_DEADLINE = Duration.minutes(4);

/** The line the example prints once bob's endpoint delivers the message. */
const receivedLine = "bob received: from agent:alice: Hi Bob, this is Alice.";

runGate("sharness-two-agents-example-", (temporaryRoot) =>
  Effect.gen(function* () {
    const { archives } = yield* packProductClosure(
      workspaceRoot,
      "client",
      temporaryRoot,
    );
    const manifest = yield* readJsonFile(
      join(exampleRoot, "package.json"),
      exampleManifest,
    );
    const consumerRoot = yield* installPackedConsumer({
      temporaryRoot,
      name: "sharness-two-agents-example",
      archives,
      dependencies: Object.fromEntries(
        Object.entries(manifest.dependencies).filter(
          ([name]) => !(name in archives),
        ),
      ),
    });
    const output = yield* runExample(consumerRoot);
    yield* requireCondition(
      output.split("\n").includes(receivedLine),
      `the example did not print "${receivedLine}":\n${output}`,
    );
    return `${output}two-agents example passed`;
  }),
);

/**
 * Copy the example into `consumerRoot` and run it there, failing once it
 * outlasts `EXAMPLE_DEADLINE`. The run is disconnected so that the deadline
 * reports even while a child that ignores SIGTERM holds up its cleanup.
 * @returns What the example printed on standard output.
 */
function runExample(
  consumerRoot: string,
): Effect.Effect<string, GateError, GateServices> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.copyFile(
      join(exampleRoot, "two-agents.ts"),
      join(consumerRoot, "two-agents.ts"),
    );
    yield* fs.copyFile(
      join(exampleRoot, "compose.yaml"),
      join(consumerRoot, "compose.yaml"),
    );
    return yield* runCommand(process.execPath, ["two-agents.ts"], {
      cwd: consumerRoot,
      env: {
        NODE_PATH: "",
      },
    }).pipe(
      Effect.disconnect,
      Effect.timeoutFail({
        duration: EXAMPLE_DEADLINE,
        onTimeout: () =>
          new PackGateError({
            message: `the example did not finish within ${Duration.format(EXAMPLE_DEADLINE)}`,
          }),
      }),
    );
  });
}
