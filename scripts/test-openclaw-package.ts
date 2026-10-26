/** @file Imports the packed channel and installs it with OpenClaw's plugin installer. */
import { Effect } from "effect";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  installPackedConsumer,
  PackGateError,
  packProductClosure,
  readConsumerPins,
  runCommand,
  runGate,
} from "./test/packed-workspace.ts";

const workspaceRoot = dirname(dirname(fileURLToPath(import.meta.url)));

runGate("sharness-openclaw-pack-", (temporaryRoot) =>
  Effect.gen(function* () {
    const { archives } = yield* packProductClosure(
      workspaceRoot,
      "openclaw-channel",
      temporaryRoot,
    );
    const pins = yield* readConsumerPins(workspaceRoot);
    const consumerRoot = yield* installPackedConsumer({
      temporaryRoot,
      workspaceRoot,
      name: "sharness-openclaw-packed-consumer",
      archives,
      dependencies: { openclaw: pins.openclaw },
    });
    yield* runCommand(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'await import("@moltzap/openclaw-channel");',
      ],
      {
        cwd: consumerRoot,
        env: { NODE_PATH: "" },
      },
    );
    const archive = archives["@moltzap/openclaw-channel"];
    if (archive === undefined) {
      return yield* new PackGateError({
        message: "OpenClaw channel archive is missing",
      });
    }
    yield* installPlugin(temporaryRoot, archive, pins.openclaw);
    return `OpenClaw ${pins.openclaw} packed consumer check passed`;
  }),
);

function installPlugin(
  temporaryRoot: string,
  archive: string,
  openclawVersion: string,
) {
  return Effect.gen(function* () {
    const stateRoot = join(temporaryRoot, "openclaw-state");
    yield* runCommand(
      "npm",
      [
        "exec",
        "--yes",
        `--package=openclaw@${openclawVersion}`,
        "--",
        "openclaw",
        "plugins",
        "install",
        archive,
      ],
      {
        cwd: temporaryRoot,
        env: {
          HOME: stateRoot,
          NODE_PATH: "",
          OPENCLAW_CONFIG_PATH: join(stateRoot, "openclaw.json"),
          OPENCLAW_HOME: stateRoot,
          OPENCLAW_STATE_DIR: stateRoot,
        },
      },
    );
  });
}
