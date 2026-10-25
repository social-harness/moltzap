/** @file Registry configuration, private RPC, client, and server composition contract tests. */

import { AgentName, AgentSigningAuthority, PrincipalId } from "@moltzap/client";
import { httpErrors, registryContract } from "@moltzap/client/internal";
import {
  ConfigProvider,
  Effect,
  Either,
  Layer,
  Redacted,
  Ref,
  Schema,
} from "effect";
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { RegistryStorage } from "../storage.js";

import {
  makeRegistryRpcClient,
  makeRegistryRpcHandlersLayer,
  registryAdmissionLayer,
  withBootstrapAdmission,
} from "../rpc.js";
import {
  loadRegistryConfiguration,
  layer as registryServerLayer,
  StartupError,
} from "../server.js";

/* eslint-disable @typescript-eslint/naming-convention -- Closed HTTP error constructors retain their class names when bound from the service capability. */
const { UnavailableError } = httpErrors;
/* eslint-enable @typescript-eslint/naming-convention -- Restore variable naming after binding error constructors. */

const CONFIGURATION_PHASE = "configuration";
const AUTHENTICATION_FAILED_TAG = "AuthenticationFailedError";
const UNAVAILABLE_TAG = "UnavailableError";
const NAME_TAKEN_KIND = "name_taken";
const NOT_FOUND_KIND = "not_found";
const PAGE_KIND = "page";

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
  new Map([["SHARNESS_REGISTRY_LIST_PAGE_SIZE", "0"]]),
  new Map([["SHARNESS_REGISTRY_REQUEST_CONCURRENCY_LIMIT", "+2"]]),
  new Map([["SHARNESS_REGISTRY_LIVE_NONCE_CAPACITY", "1.5"]]),
  new Map([["SHARNESS_REGISTRY_SQL_POOL_SIZE", "0"]]),
  new Map([["SHARNESS_REGISTRY_SQL_OPERATION_TIMEOUT_MS", "1e3"]]),
];

const makePrivateKeyPem = (): string => {
  const { privateKey } = generateKeyPairSync("ed25519");
  return privateKey.export({ format: "pem", type: "pkcs8" });
};

const makeRequest = (name: string) =>
  Schema.decodeUnknownSync(registryContract.RegistryRegisterRequest)({
    operationId: Schema.decodeUnknownSync(registryContract.OperationId)(
      "opn_AAAAAAAAAAAAAAAAAAAAAA",
    ),
    principalId: Schema.decodeUnknownSync(PrincipalId)(
      "prn_AAAAAAAAAAAAAAAAAAAAAA",
    ),
    agentName: Schema.decodeUnknownSync(AgentName)(name),
    publicKey: {
      crv: "Ed25519",
      kty: "OKP",
      x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo",
    },
  });

const makeRpcStorage = (calls: Ref.Ref<number>): RegistryStorage => ({
  checkReadiness: () => Effect.void,
  claimRegistrationNonce: () => Effect.succeed("claimed"),
  register: ({ request }) =>
    Ref.updateAndGet(calls, (current) => current + 1).pipe(
      Effect.flatMap(() =>
        request.agentName === "rpc-failure"
          ? Effect.fail(new UnavailableError())
          : Effect.succeed(Object.freeze({ kind: NAME_TAKEN_KIND })),
      ),
    ),
  lookup: () => Effect.succeed(Object.freeze({ kind: NOT_FOUND_KIND })),
  list: () =>
    Effect.succeed(
      Object.freeze({
        kind: PAGE_KIND,
        agentCards: Object.freeze([]),
        hasMore: false,
      }),
    ),
});

const assertDefaultConfiguration = Effect.gen(function* () {
  const configuration = yield* loadConfiguration();
  expect(configuration).toMatchObject({
    host: "127.0.0.1",
    port: 4317,
    listPageSize: 100,
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
      ["SHARNESS_REGISTRY_LIST_PAGE_SIZE", "7"],
      ["SHARNESS_REGISTRY_REQUEST_CONCURRENCY_LIMIT", "8"],
      ["SHARNESS_REGISTRY_LIVE_NONCE_CAPACITY", "9"],
      ["SHARNESS_REGISTRY_SQL_POOL_SIZE", "3"],
      ["SHARNESS_REGISTRY_SQL_OPERATION_TIMEOUT_MS", "250"],
    ]),
  );
  expect(overridden).toMatchObject({
    host: "::",
    listPageSize: 7,
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

const failureTag = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => error._tag),
  );

const rpcBehavior = Effect.gen(function* () {
  const calls = yield* Ref.make(0);
  const storage = makeRpcStorage(calls);
  const registrySigningAuthority = yield* AgentSigningAuthority.fromPkcs8(
    Redacted.make(makePrivateKeyPem()),
  );
  const handlers = makeRegistryRpcHandlersLayer({
    storage,
    registrySigningAuthority,
  });
  const client = yield* makeRegistryRpcClient.pipe(
    Effect.provide(handlers),
    Effect.provide(registryAdmissionLayer),
  );

  const unauthenticatedTag = yield* failureTag(
    client.register(makeRequest("rpc-refusal")),
  );
  expect(unauthenticatedTag).toBe(AUTHENTICATION_FAILED_TAG);
  expect(yield* Ref.get(calls)).toBe(0);

  const refusal = yield* withBootstrapAdmission(
    client.register(makeRequest("rpc-refusal")),
  );
  expect(refusal.kind).toBe(NAME_TAKEN_KIND);

  const unavailableTag = yield* failureTag(
    withBootstrapAdmission(client.register(makeRequest("rpc-failure"))),
  );
  expect(unavailableTag).toBe(UNAVAILABLE_TAG);
  expect(yield* Ref.get(calls)).toBe(2);

  const lookup = yield* client.lookup({
    agentName: Schema.decodeUnknownSync(AgentName)("rpc-lookup"),
  });
  expect(lookup.kind).toBe(NOT_FOUND_KIND);
  expect((yield* client.list({})).kind).toBe(PAGE_KIND);
});

describe("Registry private contracts", () => {
  it("loads exact refined redacted configuration from an isolated provider", () => {
    expect.hasAssertions();
    return Effect.runPromise(configurationBehavior);
  });
  it("enforces private RPC admission and preserves typed channels", () => {
    expect.hasAssertions();
    return Effect.runPromise(rpcBehavior.pipe(Effect.scoped));
  });
});
