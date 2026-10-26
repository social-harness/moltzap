/** @file Production Registry process configuration, composition, and startup boundary. */

import type { SqlError } from "@effect/sql/SqlError";
import * as Reactivity from "@effect/experimental/Reactivity";
import { FileSystem, HttpServer, HttpServerResponse } from "@effect/platform";
import { NodeContext, NodeHttpServer } from "@effect/platform-node";
import { PgClient } from "@effect/sql-pg";
import {
  AgentSigningAuthority,
  legacyKeys,
  WIRE_VERSION,
} from "@moltzap/client";
import {
  Cause,
  Config,
  ConfigError,
  Console,
  Data,
  Duration,
  Effect,
  Layer,
  Match,
  Redacted,
  Schema,
} from "effect";
// eslint-disable-next-line agent-code-guard/prefer-effect-platform -- NodeHttpServer.make requires the platform listener constructor at this adapter boundary.
import { createServer } from "node:http";
import { isAbsolute } from "node:path";
import { makeRegistryHttpApp } from "./http.js";
import {
  makeRegistryRpcClient,
  makeRegistryRpcHandlersLayer,
  registryAdmissionLayer,
} from "./rpc.js";
import {
  initializeRegistryStorage,
  makeRegistryStorage,
  type RegistryStorage,
  RegistryStorageInitializationError,
} from "./storage.js";

const MAXIMUM_PROCESS_INTEGER = 2_147_483_647;
const canonicalUnsignedDecimal = Schema.String.pipe(
  Schema.pattern(/^(?:0|[1-9]\d*)$/),
);
const processInteger = canonicalUnsignedDecimal.pipe(
  Schema.compose(Schema.NumberFromString),
  Schema.int(),
  Schema.between(1, MAXIMUM_PROCESS_INTEGER),
);
const port = canonicalUnsignedDecimal.pipe(
  Schema.compose(Schema.NumberFromString),
  Schema.int(),
  Schema.between(1, 65_535),
);
const bindHost = Schema.String.pipe(Schema.minLength(1));
const postgresqlUrl = Schema.String.pipe(
  Schema.filter((value) => {
    try {
      const parsed = new URL(value);
      return (
        (parsed.protocol === "postgres:" ||
          parsed.protocol === "postgresql:") &&
        parsed.pathname.length > 1 &&
        parsed.hash === ""
      );
      // eslint-disable-next-line agent-code-guard/bare-catch -- URL parsing failure is the false branch of this Schema predicate.
    } catch {
      return false;
    }
  }),
  Schema.annotations({
    identifier: "PostgreSQL URL with a database name and no fragment",
  }),
);
const admissionCredential = Schema.String.pipe(
  Schema.minLength(8),
  Schema.maxLength(512),
  Schema.pattern(/^[A-Za-z0-9\-._~+/]+=*$/),
);
const absolutePath = Schema.String.pipe(
  Schema.filter((value) => isAbsolute(value)),
  Schema.annotations({ identifier: "absolute file path" }),
);

const configurationFields = {
  host: setting("SHARNESS_REGISTRY_HOST", bindHost, "127.0.0.1"),
  port: setting("SHARNESS_REGISTRY_PORT", port),
  postgresqlUrl: setting("SHARNESS_REGISTRY_POSTGRESQL_URL", postgresqlUrl),
  admissionCredential: setting(
    "SHARNESS_REGISTRY_ADMISSION_CREDENTIAL",
    admissionCredential,
  ),
  signingPrivateKeyPath: setting(
    "SHARNESS_REGISTRY_SIGNING_PRIVATE_KEY_PATH",
    absolutePath,
  ),
  requestConcurrencyLimit: setting(
    "SHARNESS_REGISTRY_REQUEST_CONCURRENCY_LIMIT",
    processInteger,
    256,
  ),
  liveNonceCapacity: setting(
    "SHARNESS_REGISTRY_LIVE_NONCE_CAPACITY",
    processInteger,
    10_000,
  ),
  sqlPoolSize: setting("SHARNESS_REGISTRY_SQL_POOL_SIZE", processInteger, 10),
  sqlOperationTimeoutMs: setting(
    "SHARNESS_REGISTRY_SQL_OPERATION_TIMEOUT_MS",
    processInteger,
    5_000,
  ),
};

const configuredValues = Config.all(configurationFields);

/** Usage is generated from the same fields consumed by the process. */
export const processHelp = [
  "Usage: sharness-registry [--help]",
  "",
  "Environment:",
  ...Object.values(configurationFields).map((field) => `  ${field.usage}`),
].join("\n");

/**
 * Complete validated configuration for one Registry process.
 *
 * @internal
 */
export interface RegistryConfiguration {
  readonly host: string;
  readonly port: number;
  readonly postgresqlUrl: Redacted.Redacted;
  readonly admissionCredential: Redacted.Redacted;
  readonly signingPrivateKeyPath: Redacted.Redacted;
  readonly requestConcurrencyLimit: number;
  readonly liveNonceCapacity: number;
  readonly sqlPoolSize: number;
  readonly sqlOperationTimeoutMs: number;
}

/** Closed Registry startup failure. */
export class StartupError extends Data.TaggedError(
  "RegistryServerStartupError",
)<{
  readonly phase: "configuration" | "storage" | "listener";
  readonly detail?: string;
  readonly reason?: RegistryStorageInitializationError["reason"] | "legacy-key";
  readonly keys?: readonly string[];
}> {
  /** Operator diagnostics exclude rejected inputs and platform paths. */
  override get message(): string {
    const keys = this.keys === undefined ? "" : `: ${this.keys.join(", ")}`;
    const detail = this.detail === undefined ? keys : `: ${this.detail}`;
    const reason = this.reason === undefined ? "" : ` (${this.reason})`;
    const remedy =
      this.reason === "pre-reset"
        ? ". Start with a fresh Registry database and register agents again; see https://github.com/social-harness/moltzap/blob/main/docs/guides/upgrades.mdx#apply-a-reset-release."
        : "";
    return `sharness-registry startup failed in phase ${this.phase}${reason}${detail}${remedy}`;
  }
}

/**
 * Loads the complete private Registry process configuration.
 *
 * @internal
 */
export const loadRegistryConfiguration: Effect.Effect<
  RegistryConfiguration,
  ConfigError.ConfigError | StartupError
> = Effect.suspend(
  (): Effect.Effect<
    RegistryConfiguration,
    ConfigError.ConfigError | StartupError
  > => {
    // eslint-disable-next-line agent-code-guard/no-process-env-at-runtime -- Configuration acquisition enumerates unknown legacy keys, which Effect.Config cannot name in advance.
    const keys = legacyKeys(process.env);
    if (keys.length > 0) {
      return Effect.fail(
        new StartupError({
          phase: "configuration",
          reason: "legacy-key",
          keys,
        }),
      );
    }
    return configuredValues.pipe(
      Effect.map(
        (configuration): RegistryConfiguration => ({
          ...configuration,
          postgresqlUrl: Redacted.make(configuration.postgresqlUrl),
          admissionCredential: Redacted.make(configuration.admissionCredential),
          signingPrivateKeyPath: Redacted.make(
            configuration.signingPrivateKeyPath,
          ),
        }),
      ),
      Effect.withSpan("loadRegistryConfiguration"),
    );
  },
);

const runRegistryServer = Effect.gen(function* () {
  const configuration = yield* loadRegistryConfiguration.pipe(
    Effect.mapError(configurationFailure),
  );
  const registrySigningAuthority = yield* loadSigningAuthority(configuration);
  const registrySignerPublicKey = AgentSigningAuthority.publicKey(
    registrySigningAuthority,
  );
  const storage = yield* connectStorage(configuration, registrySignerPublicKey);
  const app = yield* buildRegistryApp({
    configuration,
    storage,
    registrySigningAuthority,
  });
  yield* serveRegistry(configuration, guardRegistryApp(app));
});

/**
 * Complete production Registry process composition.
 *
 * ```mermaid
 * flowchart TD
 *   Binary["sharness-registry"] --> Server["runRegistryServer"]
 *   Server --> Configuration["loadRegistryConfiguration"]
 *   Server --> Storage["RegistryStorage"]
 *   Server --> Http["makeRegistryHttpApp"]
 *   Http --> Admission["verifyBootstrapRegistration"]
 *   Http --> Rpc["RegistryRpcClient"]
 *   Admission --> Storage
 *   Rpc --> Storage
 *   Http --> Response["HttpServerResponse"]
 * ```
 */
// safer-arch-ignore require-boundary-owned-types: The declared Layer type is the public boundary; this composition root provides the Node adapter internally.
export const layer: Layer.Layer<never, StartupError> = Layer.scopedDiscard(
  runRegistryServer.pipe(Effect.provide(NodeContext.layer)),
);

function loadSigningAuthority(configuration: RegistryConfiguration) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const privateKeyText = yield* fileSystem
      .readFileString(Redacted.value(configuration.signingPrivateKeyPath))
      .pipe(Effect.mapError(signingKeyFailure));
    return yield* AgentSigningAuthority.fromPkcs8(
      Redacted.make(privateKeyText),
    ).pipe(Effect.mapError(signingKeyFailure));
  });
}

function connectStorage(
  configuration: RegistryConfiguration,
  registrySignerPublicKey: ReturnType<typeof AgentSigningAuthority.publicKey>,
) {
  return Effect.gen(function* () {
    const sql = yield* PgClient.make({
      url: configuration.postgresqlUrl,
      maxConnections: configuration.sqlPoolSize,
      connectTimeout: Duration.millis(configuration.sqlOperationTimeoutMs),
      applicationName: "sharness-registry",
    }).pipe(Effect.provide(Reactivity.layer), Effect.mapError(storageFailure));
    yield* initializeRegistryStorage({
      sql,
      registrySignerPublicKey,
    }).pipe(
      Effect.mapError(storageFailure),
      Effect.timeoutFail({
        duration: Duration.millis(configuration.sqlOperationTimeoutMs),
        onTimeout: () => storageFailure(),
      }),
    );
    return makeRegistryStorage({
      sql,
      registrySignerPublicKey,
      operationTimeoutMilliseconds: configuration.sqlOperationTimeoutMs,
    });
  });
}

function buildRegistryApp(input: {
  readonly configuration: RegistryConfiguration;
  readonly storage: RegistryStorage;
  readonly registrySigningAuthority: AgentSigningAuthority;
}) {
  return Effect.gen(function* () {
    const handlers = makeRegistryRpcHandlersLayer({
      storage: input.storage,
      registrySigningAuthority: input.registrySigningAuthority,
    });
    const client = yield* makeRegistryRpcClient.pipe(
      Effect.provide(handlers),
      Effect.provide(registryAdmissionLayer),
    );
    const requestSemaphore = yield* Effect.makeSemaphore(
      input.configuration.requestConcurrencyLimit,
    );
    return makeRegistryHttpApp({
      client,
      storage: input.storage,
      admissionCredential: input.configuration.admissionCredential,
      nonceCapacity: input.configuration.liveNonceCapacity,
      requestSemaphore,
    });
  });
}

function guardRegistryApp(app: ReturnType<typeof makeRegistryHttpApp>) {
  return app.pipe(
    Effect.catchAllCause((cause) =>
      Effect.logError(
        "Registry HTTP application failed",
        Cause.squash(cause),
      ).pipe(Effect.as(HttpServerResponse.empty({ status: 500 }))),
    ),
  );
}

function serveRegistry(
  configuration: RegistryConfiguration,
  app: ReturnType<typeof guardRegistryApp>,
) {
  return Effect.gen(function* () {
    const httpServer = yield* NodeHttpServer.make(createServer, {
      host: configuration.host,
      port: configuration.port,
    }).pipe(Effect.mapError(listenerFailure));
    yield* HttpServer.serveEffect(app).pipe(
      Effect.provideService(HttpServer.HttpServer, httpServer),
    );
    yield* Console.log(
      `sharness-registry listening on ${listeningUrl(httpServer.address)} (WIRE_VERSION ${WIRE_VERSION})`,
    );
  });
}

function configurationFailure(cause: unknown) {
  if (cause instanceof StartupError) {
    return cause;
  }
  return new StartupError({
    phase: "configuration",
    detail: ConfigError.isConfigError(cause)
      ? configurationMessage(cause)
      : undefined,
  });
}

function signingKeyFailure() {
  return new StartupError({
    phase: "configuration",
    detail:
      "SHARNESS_REGISTRY_SIGNING_PRIVATE_KEY_PATH must name a readable Ed25519 PKCS#8 key file",
  });
}

function storageFailure(error?: RegistryStorageInitializationError | SqlError) {
  return new StartupError({
    phase: "storage",
    reason:
      error instanceof RegistryStorageInitializationError
        ? error.reason
        : "unavailable",
  });
}

function listenerFailure() {
  return new StartupError({ phase: "listener" });
}

/** Config and operator text share the name, schema and default at declaration. */
function setting<A, D = never>(
  name: string,
  schema: Schema.Schema<A, string>,
  ...defaults: [] | [D]
) {
  const config = Schema.Config(name, schema);
  return Object.assign(
    defaults.length === 0
      ? config
      : config.pipe(Config.withDefault(defaults[0])),
    {
      name,
      reason: `must satisfy ${schema.ast.toString()}`,
      usage: `${name}: ${settingUsage(defaults)}`,
    },
  );
}

/** Distinguishes absent defaults from explicitly unset or empty defaults in operator help. */
function settingUsage(defaults: readonly unknown[]): string {
  if (defaults.length === 0) {
    return "required; default: none";
  }
  if (defaults[0] === undefined) {
    return "optional; default: unset";
  }
  if (defaults[0] === "") {
    return "optional; default: none";
  }
  return `optional; default: ${JSON.stringify(defaults[0])}`;
}

/** ConfigError trees retain every missing field without printing rejected inputs. */
function configurationMessage(error: ConfigError.ConfigError): string {
  return Match.value(error).pipe(
    Match.discriminatorsExhaustive("_op")({
      And: (cause) =>
        `${configurationMessage(cause.left)}; ${configurationMessage(cause.right)}`,
      Or: (cause) =>
        `${configurationMessage(cause.left)} or ${configurationMessage(cause.right)}`,
      MissingData: (cause) => `${Array.from(cause.path).join("_")} is required`,
      InvalidData: invalidConfigurationMessage,
      SourceUnavailable: (cause) =>
        `${Array.from(cause.path).join("_")} configuration source unavailable`,
      Unsupported: (cause) =>
        `${Array.from(cause.path).join("_")} configuration source unavailable`,
    }),
  );
}

/** Only declared setting constraints may appear in invalid-value diagnostics. */
function invalidConfigurationMessage(error: ConfigError.InvalidData): string {
  const name = Array.from(error.path).join("_");
  const field = Object.values(configurationFields).find(
    (candidate) => candidate.name === name,
  );
  return field === undefined
    ? "environment configuration is invalid"
    : `${name} ${field.reason}`;
}

/** IPv6 listener addresses need brackets in a URL authority. */
function listeningUrl(address: HttpServer.Address): string {
  if (address._tag === "UnixAddress") {
    return HttpServer.formatAddress(address);
  }
  const host = address.hostname.includes(":")
    ? `[${address.hostname}]`
    : address.hostname;
  return `http://${host}:${address.port}`;
}
