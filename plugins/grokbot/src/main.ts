/** @file Remote Grok receiver; a process supervisor restarts failed Client subscriptions. */
import { FetchHttpClient } from "@effect/platform";
import { NodeRuntime } from "@effect/platform-node";
import { acquireHarnessEndpoint } from "@moltzap/social-harness";
import { Config, Data, Effect, Stream } from "effect";
import { deliverToGrokBot, validateGrokRoutine } from "./index.js";

/** Configuration errors contain neither the private routine destination nor credentials. */
class GrokConfigurationError extends Data.TaggedError(
  "GrokConfigurationError",
) {
  override get message(): string {
    return "Grok receiver configuration is missing or invalid. Docs: https://github.com/social-harness/moltzap/tree/main/plugins/grokbot#configuration";
  }
}

const runtimeCredential = Config.redacted("SHARNESS_RUNTIME_TOKEN");
const routineKey = Config.redacted("SHARNESS_GROK_ROUTINE_KEY");

const program = Effect.gen(function* () {
  const config = yield* Config.all({
    endpoint: Config.url("SHARNESS_MCP_URL"),
    credential: runtimeCredential,
    url: Config.url("SHARNESS_GROK_ROUTINE_URL"),
    key: routineKey,
  }).pipe(
    Effect.catchTag("ConfigError", () =>
      Effect.fail(new GrokConfigurationError()),
    ),
  );
  const routine = yield* validateGrokRoutine({
    url: config.url,
    key: config.key,
  });
  const endpoint = yield* acquireHarnessEndpoint(config.endpoint, {
    credential: config.credential,
    onReady: Effect.logInfo("Grok receiver ready"),
  });
  yield* endpoint.messages.pipe(
    Stream.runForEach((delivery) => deliverToGrokBot(routine, delivery)),
  );
});

NodeRuntime.runMain(
  program.pipe(Effect.provide(FetchHttpClient.layer), Effect.scoped),
);
