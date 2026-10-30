/** @file Remote Instinct receiver; the process supervisor owns restart policy. */
import { FetchHttpClient } from "@effect/platform";
import { NodeRuntime } from "@effect/platform-node";
import { acquireHarnessEndpoint } from "@moltzap/social-harness";
import { Config, Data, Effect, Stream } from "effect";
import { deliverToInstinct } from "./index.js";

/** Configuration diagnostics must not include an invalid URL or secret value. */
class InstinctConfigurationError extends Data.TaggedError(
  "InstinctConfigurationError",
) {
  override get message(): string {
    return "Instinct receiver configuration is missing or invalid. Docs: https://github.com/social-harness/moltzap/tree/main/plugins/instinct#configuration";
  }
}

const mcpCredential = Config.redacted("SHARNESS_MCP_TOKEN");
const agentMailKey = Config.redacted("SHARNESS_AGENTMAIL_API_KEY");

const program = Effect.gen(function* () {
  const config = yield* Config.all({
    endpoint: Config.url("SHARNESS_MCP_URL"),
    credential: mcpCredential,
    apiKey: agentMailKey,
    inboxId: Config.string("SHARNESS_AGENTMAIL_INBOX_ID"),
    recipient: Config.string("SHARNESS_INSTINCT_ADDRESS"),
  }).pipe(
    Effect.catchTag("ConfigError", () =>
      Effect.fail(new InstinctConfigurationError()),
    ),
  );
  const endpoint = yield* acquireHarnessEndpoint(config.endpoint, {
    credential: config.credential,
    onReady: Effect.logInfo("Instinct receiver ready"),
  });
  yield* endpoint.messages.pipe(
    Stream.runForEach((delivery) => deliverToInstinct(config, delivery)),
  );
});

NodeRuntime.runMain(
  program.pipe(Effect.provide(FetchHttpClient.layer), Effect.scoped),
);
