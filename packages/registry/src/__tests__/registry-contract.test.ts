/** @file Registry configuration and server startup contract tests. */

import { ConfigProvider, Effect, Either, Layer, Redacted } from "effect";
import { describe, expect, it } from "vitest";

import {
  loadRegistryConfiguration,
  layer as registryServerLayer,
  StartupError,
} from "../server.js";

const CONFIGURATION_PHASE = "configuration";

const requiredConfiguration = new Map([
  ["SHARNESS_REGISTRY_PORT", "4317"],
  [
    "SHARNESS_REGISTRY_POSTGRESQL_URL",
    "postgresql://registry:secret@127.0.0.1:5432/registry?sslmode=disable",
  ],
  ["SHARNESS_REGISTRY_ADMISSION_CREDENTIAL", "admission-token="],
  [
    "SHARNESS_REGISTRY_SIGNING_PRIVATE_KEY_PATH",
    "/run/secrets/registry-key.pem",
  ],
]);
const noConfigurationOverrides = new Map<string, string>();

const loadConfiguration = (
  overrides: ReadonlyMap<string, string> = noConfigurationOverrides,
) =>
  loadRegistryConfiguration.pipe(
    Effect.withConfigProvider(
      ConfigProvider.fromMap(
        new Map([
          ...requiredConfiguration,
          ["UNRELATED_DEPLOYMENT_VALUE", "ignored"],
          ...overrides,
        ]),
      ),
    ),
  );

const effectFails = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<boolean, never, R> =>
  effect.pipe(
    Effect.either,
    Effect.map(
      Either.match({
        onLeft: () => true,
        onRight: () => false,
      }),
    ),
  );

const invalidConfigurationOverrides = [
  new Map([["SHARNESS_REGISTRY_PORT", "0"]]),
  new Map([["SHARNESS_REGISTRY_PORT", "01"]]),
  new Map([["SHARNESS_REGISTRY_PORT", "65536"]]),
  // eslint-disable-next-line sonarjs/no-clear-text-protocols -- The configuration boundary must reject this intentionally wrong scheme.
  new Map([["SHARNESS_REGISTRY_POSTGRESQL_URL", "http://db/registry"]]),
  new Map([["SHARNESS_REGISTRY_ADMISSION_CREDENTIAL", "short"]]),
  new Map([["SHARNESS_REGISTRY_ADMISSION_CREDENTIAL", "invalid!token"]]),
  new Map([["SHARNESS_REGISTRY_SIGNING_PRIVATE_KEY_PATH", "relative.pem"]]),
  new Map([["SHARNESS_REGISTRY_REQUEST_CONCURRENCY_LIMIT", "+2"]]),
  new Map([["SHARNESS_REGISTRY_LIVE_NONCE_CAPACITY", "1.5"]]),
  new Map([["SHARNESS_REGISTRY_SQL_POOL_SIZE", "0"]]),
  new Map([["SHARNESS_REGISTRY_SQL_OPERATION_TIMEOUT_MS", "1e3"]]),
];

const assertDefaultConfiguration = Effect.gen(function* () {
  const configuration = yield* loadConfiguration();
  expect(configuration).toMatchObject({
    host: "127.0.0.1",
    port: 4317,
    requestConcurrencyLimit: 256,
    liveNonceCapacity: 10_000,
    sqlPoolSize: 10,
    sqlOperationTimeoutMs: 5_000,
  });
  expect(Redacted.isRedacted(configuration.postgresqlUrl)).toBe(true);
  expect(Redacted.isRedacted(configuration.admissionCredential)).toBe(true);
  expect(Redacted.isRedacted(configuration.signingPrivateKeyPath)).toBe(true);
  expect(Redacted.value(configuration.postgresqlUrl)).toBe(
    requiredConfiguration.get("SHARNESS_REGISTRY_POSTGRESQL_URL"),
  );

  const overridden = yield* loadConfiguration(
    new Map([
      ["SHARNESS_REGISTRY_HOST", "::"],
      ["SHARNESS_REGISTRY_REQUEST_CONCURRENCY_LIMIT", "8"],
      ["SHARNESS_REGISTRY_LIVE_NONCE_CAPACITY", "9"],
      ["SHARNESS_REGISTRY_SQL_POOL_SIZE", "3"],
      ["SHARNESS_REGISTRY_SQL_OPERATION_TIMEOUT_MS", "250"],
    ]),
  );
  expect(overridden).toMatchObject({
    host: "::",
    requestConcurrencyLimit: 8,
    liveNonceCapacity: 9,
    sqlPoolSize: 3,
    sqlOperationTimeoutMs: 250,
  });
});

const assertInvalidConfigurations = Effect.gen(function* () {
  for (const overrides of invalidConfigurationOverrides) {
    expect(yield* effectFails(loadConfiguration(overrides))).toBe(true);
  }
});

const assertTypedStartupFailure = Effect.gen(function* () {
  const provider = ConfigProvider.fromMap(
    new Map([...requiredConfiguration, ["SHARNESS_REGISTRY_PORT", "0"]]),
  );
  const startupFailure = yield* Layer.build(registryServerLayer).pipe(
    Effect.scoped,
    Effect.flip,
    Effect.withConfigProvider(provider),
  );
  expect(startupFailure).toBeInstanceOf(StartupError);
  expect(startupFailure.phase).toBe(CONFIGURATION_PHASE);
});

const configurationBehavior = Effect.gen(function* () {
  yield* assertDefaultConfiguration;
  yield* assertInvalidConfigurations;
  yield* assertTypedStartupFailure;
});

describe("Registry private contracts", () => {
  it("loads exact refined redacted configuration from an isolated provider", () => {
    expect.hasAssertions();
    return Effect.runPromise(configurationBehavior);
  });
});
