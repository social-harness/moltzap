/** @file Remote Muse receiver and credential-free native detector/worker commands. */
import { FetchHttpClient } from "@effect/platform";
import { NodeFileSystem, NodeRuntime } from "@effect/platform-node";
import { acquireHarnessEndpoint } from "@moltzap/social-harness";
import { Config, Console, Effect, Layer, Stream } from "effect";
import { isAbsolute } from "node:path";
import { MuseWakeError } from "./errors.js";
import { acceptMuseWork, detectMuseWork, makeMuseWakeup } from "./index.js";

const runtimeCredential = Config.redacted("SHARNESS_RUNTIME_TOKEN");

const program = Effect.gen(function* () {
  const operation = yield* Config.literal(
    "receive",
    "detect",
    "accept",
  )("SHARNESS_MUSE_OPERATION").pipe(Config.withDefault("receive"));
  const directory = yield* Config.string("SHARNESS_MUSE_STATE_DIR");
  if (!isAbsolute(directory)) {
    return yield* new MuseWakeError({ reason: "invalid-configuration" });
  }
  switch (operation) {
    case "receive":
      return yield* receive(directory);
    case "accept": {
      const attempt = yield* Config.string("SHARNESS_MUSE_ATTEMPT");
      const eventId = yield* Config.string("SHARNESS_MUSE_EVENT_ID");
      return yield* acceptMuseWork(directory, attempt, eventId);
    }
    case "detect": {
      const references = yield* detectMuseWork(directory);
      return yield* Effect.forEach(
        references,
        (reference) => Console.log(JSON.stringify(reference)),
        { concurrency: 1, discard: true },
      );
    }
    default: {
      const exhaustive: never = operation;
      return exhaustive;
    }
  }
}).pipe(
  Effect.catchTag("ConfigError", () =>
    Effect.fail(new MuseWakeError({ reason: "invalid-configuration" })),
  ),
);

function receive(directory: string) {
  return Effect.gen(function* () {
    const config = yield* Config.all({
      endpoint: Config.url("SHARNESS_MCP_URL"),
      credential: runtimeCredential,
    });
    const wake = yield* makeMuseWakeup(directory);
    const endpoint = yield* acquireHarnessEndpoint(config.endpoint, {
      credential: config.credential,
      onReady: Effect.logInfo("Muse receiver ready"),
    });
    yield* endpoint.messages.pipe(Stream.runForEach(wake));
  });
}

NodeRuntime.runMain(
  program.pipe(
    Effect.provide(Layer.mergeAll(NodeFileSystem.layer, FetchHttpClient.layer)),
    Effect.scoped,
  ),
);
