/** @file Shared real-process fixtures for the cross-package suites. */

import type { MessageAddressInput } from "@moltzap/client";
import type { startRegistry } from "@moltzap/registry/test";
import { FileSystem, HttpClient } from "@effect/platform";
import {
  NodeContext,
  NodeFileSystem,
  NodeHttpClient,
} from "@effect/platform-node";
import {
  Client,
  ProtocolError,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {
  managementReadConversationResultSchema,
  type managementRegisterRequestSchema,
  managementRegisterResultSchema,
  managementSearchConversationsResultSchema,
  managementStatusResultSchema,
} from "@moltzap/client/test";
import {
  AgentName,
  AgentSigningAuthority,
  Ed25519PublicKey,
  PrincipalId,
} from "@moltzap/identity";
import { OperationId } from "@moltzap/identity/registry";
import { WireVersions } from "@moltzap/identity/test";
import {
  Console,
  Data,
  Duration,
  Effect,
  Exit,
  Fiber,
  Option,
  Redacted,
  Ref,
  Schema,
  Scope,
} from "effect";
import { type ChildProcess, spawn } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type TestContext } from "vitest";

type ManagementRegisterRequest = typeof managementRegisterRequestSchema.Type;

type ManagementRegisterResult = typeof managementRegisterResultSchema.Type;

type ManagementStatusResult = typeof managementStatusResultSchema.Type;

type ManagementSearchConversationsResult =
  typeof managementSearchConversationsResultSchema.Type;

type ManagementReadConversationResult =
  typeof managementReadConversationResultSchema.Type;

/** Every child composition receives an explicit emitted version and acceptance sets. */
interface ProcessWireVersions {
  readonly emitted: string;
  readonly live: readonly string[];
  readonly history: readonly string[];
}

/** The mode of the firewall a daemon fixture installs; absent for `sharnessd` itself. */
export type FirewallMode = "guidance" | "enforcement";

/** One closed process-fixture failure with captured child output when available. */
export class ProcessTestError extends Data.TaggedError("ProcessTestError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** Captured output remains available after the child stops. */
export interface RunningProcess {
  readonly child: ChildProcess;
  readonly logs: () => string;
}

/** Shared Registry and Router coordinates for two endpoint daemons. */
export interface ProcessInfrastructure {
  readonly registryOrigin: URL;
  readonly routerOrigin: URL;
  readonly registrySignerPublicKeyJson: string;
  readonly temporaryDirectory: string;
  /**
   * Stops the Router and starts a fresh one on the same origin. The Router
   * keeps its state in memory, so the new process has a new
   * `RouterInstanceId` and no envelopes, as a redeployed Router does.
   */
  readonly restartRouter: Effect.Effect<void, ProcessTestError>;
}

/**
 * Exact reusable process inputs for one daemon identity and state directory.
 * A fixture with a `firewall` mode runs `firewall-daemon.ts`, which installs
 * that firewall; one without runs `sharnessd`.
 */
export interface DaemonProcessFixture {
  readonly agentName: AgentName;
  readonly endpoint: URL;
  readonly environment: Readonly<Record<string, string>>;
  readonly stateDirectory: string;
  readonly agentPrivateKeyFile: string;
  readonly firewall?: FirewallMode;
  readonly wireVersions?: ProcessWireVersions;
}

/** Private management calls used to bootstrap and inspect a real daemon. */
export interface DaemonManagementClient {
  readonly register: (
    input: ManagementRegisterRequest,
  ) => Effect.Effect<ManagementRegisterResult, ProcessTestError>;
  readonly status: () => Effect.Effect<
    ManagementStatusResult,
    ProcessTestError
  >;
  readonly searchConversations: () => Effect.Effect<
    ManagementSearchConversationsResult,
    ProcessTestError
  >;
  readonly readConversation: (
    address: MessageAddressInput,
  ) => Effect.Effect<ManagementReadConversationResult, ProcessTestError>;
  readonly callExpectingProtocolError: (
    name: string,
    toolArguments: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<DaemonProtocolError, ProcessTestError>;
}

/** Stable JSON-RPC error fields observed by the real MCP client. */
interface DaemonProtocolError {
  readonly code: number;
  readonly data?: unknown;
}

/** The Registry and Router executables one infrastructure runs. */
export interface NetworkBinaries {
  readonly registry: string;
  readonly router: string;
}

/** Exit code and captured output of a daemon that stopped before listening. */
export interface DaemonStartupFailure {
  readonly exitCode: number | null;
  readonly logs: string;
}

/** Resolve the fixture's tsx loader independently of a child process's working directory. */
const require = createRequire(import.meta.url);

/** Disposable children listen only on loopback. */
export const LOOPBACK_HOST = "127.0.0.1";

/** Concurrent registration keeps this many daemon identities active. */
export const CONCURRENT_DAEMONS = 16;
/** Bounded boots limit process startup pressure while ports wait to bind. */
export const DAEMON_BOOT_CONCURRENCY = 4;
/** Router admission allows concurrent management and protocol requests per daemon. */
const REQUESTS_PER_DAEMON = 4;
/** Each daemon can hold its active poll and a replacement poll. */
const HELD_POLLS_PER_DAEMON = 2;
const ADMISSION_CREDENTIAL = "client-process-admission";
const READY_STATUS = 204;

const SHUTDOWN_TIMEOUT = Duration.seconds(5);

/**
 * Daemon finalizers run in parallel within one shutdown timeout. Infrastructure
 * then stops PGlite, Registry and Router; sixty seconds allows interruption
 * and worker scheduling overhead.
 */
const TEARDOWN_TIMEOUT_MS = 60_000;

/** A live child must announce its listener within thirty seconds. */
const READINESS_TIMEOUT = Duration.seconds(30);

const POLL_ATTEMPT_TIMEOUT = Duration.seconds(1);

const POLL_INTERVAL = Duration.millis(25);

const MODERN_PROTOCOL_VERSION = "2026-07-28";

const WORKSPACE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);

/** Children use the current Node installation and system executables. */
const CHILD_PATH = `${dirname(process.execPath)}:/usr/bin:/bin`;

const PGLITE_BINARY = join(
  WORKSPACE_ROOT,
  "tests/integration/node_modules/.bin/pglite-server",
);

/** The Registry executable installs its internal resolution. */
export const REGISTRY_BINARY = join(
  WORKSPACE_ROOT,
  "packages/registry/bin/sharness-registry",
);

/** The Router executable runs the built package. */
export const ROUTER_BINARY = join(
  WORKSPACE_ROOT,
  "packages/router/bin/sharness-router",
);

/** The daemon executable runs the built Client. */
export const DAEMON_BINARY = join(
  WORKSPACE_ROOT,
  "packages/client/bin/sharnessd",
);

const FIREWALL_DAEMON = join(
  WORKSPACE_ROOT,
  "tests/integration/firewall-daemon.ts",
);

/** Fixture failures preserve causal errors for diagnostics. */
export const processTestError = (
  message: string,
  cause?: unknown,
): ProcessTestError => new ProcessTestError({ message, cause });

/** Release an ephemeral listener before starting a child on its port. */
export const reservePort = Effect.async<number, ProcessTestError>((resume) => {
  const server = createServer();
  const onError = (error: Error): void => {
    resume(Effect.fail(processTestError("could not reserve a port", error)));
  };
  server.once("error", onError);
  server.listen(0, LOOPBACK_HOST, () => {
    server.removeListener("error", onError);
    const address = server.address();
    if (address === null || typeof address === "string") {
      server.close();
      resume(
        Effect.fail(processTestError("reserved listener exposed no port")),
      );
      return;
    }
    server.close((error) => {
      resume(
        error === undefined
          ? Effect.succeed(address.port)
          : Effect.fail(
              processTestError("could not release reserved port", error),
            ),
      );
    });
  });
  return Effect.sync(() => {
    if (server.listening) {
      server.close();
    }
  });
});

/** Capture both output streams while excluding the parent environment. */
const startProcess = (
  executable: string,
  processArguments: readonly string[],
  environment: Readonly<Record<string, string>> = {},
  cwd = WORKSPACE_ROOT,
): RunningProcess => {
  const child = spawn(executable, processArguments, {
    cwd,
    env: { PATH: CHILD_PATH, ...environment },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    output += chunk;
  });
  child.stderr?.on("data", (chunk: string) => {
    output += chunk;
  });
  return { child, logs: () => output };
};

/** Whether `child` has exited on its own or by a signal. */
export const hasExited = (child: ChildProcess): boolean =>
  child.exitCode !== null || child.signalCode !== null;

/** Remove the exit listener when an enclosing scope interrupts the wait. */
const waitForExit = (running: RunningProcess): Effect.Effect<void> => {
  if (hasExited(running.child)) {
    return Effect.void;
  }
  return Effect.async<undefined>((resume) => {
    const onExit = (): void => {
      resume(Effect.succeed(undefined));
    };
    running.child.once("exit", onExit);
    return Effect.sync(() => {
      running.child.removeListener("exit", onExit);
    });
  });
};

/**
 * Stops one exact acquired child, escalating only after its shutdown grace.
 * A scope runs this release uninterruptibly, and a race does not finish until
 * its loser stops, so both sides are interruptible: otherwise every teardown
 * waits out the full grace for a child that has already exited.
 */
export const stopProcess = (running: RunningProcess): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (hasExited(running.child)) {
      return;
    }
    running.child.kill("SIGTERM");
    const stopped = yield* Effect.raceFirst(
      waitForExit(running).pipe(Effect.as(true), Effect.interruptible),
      Effect.sleep(SHUTDOWN_TIMEOUT).pipe(
        Effect.as(false),
        Effect.interruptible,
      ),
    );
    if (!stopped) {
      running.child.kill("SIGKILL");
      yield* waitForExit(running);
    }
  }).pipe(Effect.withSpan("stopProcess"));

/**
 * Starts a child that the trace's enclosing scope stops. A scope closed by
 * interruption, as a timed-out test's is, first prints the child's output, so
 * one run shows where a hang stood.
 */
export const managedProcess = (
  executable: string,
  processArguments: readonly string[],
  environment: Readonly<Record<string, string>> = {},
  cwd = WORKSPACE_ROOT,
) =>
  Effect.acquireRelease(
    Effect.sync(() =>
      startProcess(executable, processArguments, environment, cwd),
    ),
    (running, exit) =>
      Exit.isInterrupted(exit)
        ? Console.error(
            `${basename(executable)} (pid ${running.child.pid}) output when interrupted:\n${running.logs()}`,
          ).pipe(Effect.zipRight(stopProcess(running)))
        : stopProcess(running),
  );

/**
 * Whether the child printed its own listening line. A child prints it only
 * after binding, so another process holding a released reservation cannot
 * satisfy readiness the way it could answer a connect or health probe.
 */
const announced = (running: RunningProcess, line: string) =>
  Effect.sync(() => running.logs().includes(line));

/** PGlite announces its listener only after its WASM database accepts connections. */
const pgliteListening = (running: RunningProcess, port: number) =>
  announced(running, `PGLiteSocketServer listening on {"port":${port},`);

/** The daemon announces its MCP endpoint once its loopback listener is bound. */
const daemonListening = (running: RunningProcess, endpoint: URL) =>
  announced(running, `sharnessd listening on ${endpoint.href} (`);

/** Whether `origin` answers its health check as ready. */
const isHealthy = (origin: URL) =>
  HttpClient.get(new URL("/healthz", origin)).pipe(
    Effect.map((response) => response.status === READY_STATUS),
    Effect.timeout(POLL_ATTEMPT_TIMEOUT),
    Effect.orElseSucceed(() => false),
    Effect.scoped,
    Effect.provide(NodeHttpClient.layer),
  );

/** A Registry or Router is ready once it announced its own listener on `origin` and answers its health check as ready. */
export const serviceReady = (
  running: RunningProcess,
  service: "sharness-registry" | "sharness-router",
  origin: URL,
) =>
  announced(running, `${service} listening on ${origin.origin} (`).pipe(
    Effect.flatMap((listening) =>
      listening ? isHealthy(origin) : Effect.succeed(false),
    ),
  );

/**
 * Polls `probe` until it reads true, and fails with the child's output once
 * the child exits first or the readiness deadline expires.
 * @param running Child that must become ready.
 * @param probe One readiness check of the child.
 * @param phase What the child had yet to do, for the failure message.
 * @returns Completion once `probe` reads true.
 */
export const awaitReady = (
  running: RunningProcess,
  probe: Effect.Effect<boolean>,
  phase: string,
) =>
  Effect.gen(function* () {
    while (!hasExited(running.child)) {
      if ((yield* probe) && !hasExited(running.child)) {
        return;
      }
      yield* Effect.sleep(POLL_INTERVAL);
    }
    return yield* Effect.fail(
      processTestError(`process exited before ${phase}\n${running.logs()}`),
    );
  }).pipe(
    Effect.timeoutFail({
      duration: READINESS_TIMEOUT,
      onTimeout: () =>
        processTestError(
          `process timed out before ${phase}\n${running.logs()}`,
        ),
    }),
    Effect.withSpan("awaitReady"),
  );

/** Each fixture receives a fresh Ed25519 signing identity. */
export const makePrivateKeyPem = (): string => {
  const { privateKey } = generateKeyPairSync("ed25519");
  return privateKey.export({ format: "pem", type: "pkcs8" });
};

/** Import private key material only inside disposable process fixtures. */
export const makeSigningAuthority = (privateKeyPem?: string) =>
  AgentSigningAuthority.fromPkcs8(
    Redacted.make(privateKeyPem ?? makePrivateKeyPem()),
  );

const acquireTemporaryDirectory = FileSystem.FileSystem.pipe(
  Effect.flatMap((fs) =>
    fs.makeTempDirectoryScoped({ prefix: "sharness-client-process-" }),
  ),
  Effect.provide(NodeFileSystem.layer),
  Effect.mapError((cause) =>
    processTestError("could not create temporary directory", cause),
  ),
);

const writePrivateFile = (path: string, content: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.writeFileString(path, content, { mode: 0o600 })),
    Effect.provide(NodeFileSystem.layer),
    Effect.mapError((cause) =>
      processTestError(`could not write ${path}`, cause),
    ),
  );

const makeDirectory = (path: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.makeDirectory(path, { recursive: true })),
    Effect.provide(NodeFileSystem.layer),
    Effect.mapError((cause) =>
      processTestError(`could not create ${path}`, cause),
    ),
  );

const encodePublicKey = (
  publicKey: Ed25519PublicKey,
): Effect.Effect<string, ProcessTestError> =>
  Schema.encode(Ed25519PublicKey)(publicKey).pipe(
    Effect.map((encoded) => JSON.stringify(encoded)),
    Effect.mapError((cause) =>
      processTestError("could not encode Registry signer", cause),
    ),
  );

/** A PGlite Registry uses one SQL connection because its backend is one session. */
export const startPgliteRegistry = (input: {
  readonly postgresqlPort: number;
  readonly registryPort: number;
  readonly registryKeyPath: string;
  readonly admissionCredential: string;
  readonly command?: readonly [string, readonly string[]];
}) =>
  Effect.gen(function* () {
    const postgresql = yield* startPglite(input.postgresqlPort);
    const command: readonly [string, readonly string[]] = input.command ?? [
      REGISTRY_BINARY,
      [],
    ];
    const registry = yield* managedProcess(
      command[0],
      command[1],
      {
        SHARNESS_REGISTRY_HOST: LOOPBACK_HOST,
        SHARNESS_REGISTRY_PORT: String(input.registryPort),
        SHARNESS_REGISTRY_SQL_POOL_SIZE: "1",
        SHARNESS_REGISTRY_POSTGRESQL_URL: `postgresql://postgres:postgres@${LOOPBACK_HOST}:${input.postgresqlPort}/postgres`,
        SHARNESS_REGISTRY_ADMISSION_CREDENTIAL: input.admissionCredential,
        SHARNESS_REGISTRY_SIGNING_PRIVATE_KEY_PATH: input.registryKeyPath,
        SHARNESS_REGISTRY_LIST_PAGE_SIZE: "16",
      },
      join(WORKSPACE_ROOT, "packages/registry"),
    );
    yield* awaitReady(
      registry,
      serviceReady(
        registry,
        "sharness-registry",
        new URL(`http://${LOOPBACK_HOST}:${input.registryPort}`),
      ),
      "listening",
    ).pipe(
      Effect.mapError((error) =>
        processTestError(
          `${error.message}\nPGlite output:\n${postgresql.logs()}`,
          error,
        ),
      ),
    );
    return registry;
  }).pipe(Effect.withSpan("startPgliteRegistry"));

const prepareInfrastructure = Effect.gen(function* () {
  const configuredVersions = yield* Effect.serviceOption(WireVersions);
  const versions = yield* Option.match(configuredVersions, {
    onNone: () => Effect.succeed(Option.none<ProcessWireVersions>()),
    onSome: (sets) =>
      sets.emitted === undefined
        ? Effect.fail(
            processTestError(
              "injected WireVersions is missing its emitted version",
            ),
          )
        : Effect.succeed(Option.some({ ...sets, emitted: sets.emitted })),
  });
  const temporaryDirectory = yield* acquireTemporaryDirectory;
  const registryKeyPath = join(temporaryDirectory, "registry-key.pem");
  const registryPrivateKey = makePrivateKeyPem();
  yield* writePrivateFile(registryKeyPath, registryPrivateKey);
  const registryAuthority = yield* makeSigningAuthority(
    registryPrivateKey,
  ).pipe(
    Effect.mapError((cause) =>
      processTestError("could not load Registry signer", cause),
    ),
  );
  const registrySignerPublicKeyJson = yield* encodePublicKey(
    AgentSigningAuthority.publicKey(registryAuthority),
  );
  const [postgresqlPort, registryPort, routerPort] = yield* Effect.all(
    [reservePort, reservePort, reservePort] as const,
    { concurrency: 3 },
  );
  const registryOrigin = new URL(`http://${LOOPBACK_HOST}:${registryPort}`);
  const routerOrigin = new URL(`http://${LOOPBACK_HOST}:${routerPort}`);

  return {
    versions,
    temporaryDirectory,
    registryKeyPath,
    registrySignerPublicKeyJson,
    postgresqlPort,
    registryPort,
    routerPort,
    registryOrigin,
    routerOrigin,
  };
});

/**
 * Starts disposable PGlite, Registry, and Router processes from `binaries`,
 * such as a published release's executables. The Registry waits for PGlite
 * to listen; the Router reads the Registry only to serve a request, so it
 * starts alongside them. An injected `WireVersions` runs the workspace
 * Registry and Router under those sets instead.
 */
export const acquireProcessInfrastructureFrom = (
  binaries: NetworkBinaries,
): Effect.Effect<ProcessInfrastructure, ProcessTestError, Scope.Scope> =>
  Effect.gen(function* () {
    const prepared = yield* prepareInfrastructure;
    const {
      registryOrigin,
      routerOrigin,
      registrySignerPublicKeyJson,
      temporaryDirectory,
    } = prepared;
    const startRegistry = startNetworkRegistry(prepared, binaries);
    const scope = yield* Effect.scope;
    const startRouter = startNetworkRouter(prepared, binaries).pipe(
      Scope.extend(scope),
    );
    const [, firstRouter] = yield* Effect.all([startRegistry, startRouter], {
      concurrency: 2,
    });
    const router = yield* Ref.make(firstRouter);
    const restartRouter = Ref.get(router).pipe(
      Effect.flatMap(stopProcess),
      Effect.zipRight(startRouter),
      Effect.flatMap((restarted) => Ref.set(router, restarted)),
    );

    return {
      registryOrigin,
      routerOrigin,
      registrySignerPublicKeyJson,
      temporaryDirectory,
      restartRouter,
    };
  }).pipe(Effect.withSpan("acquireProcessInfrastructureFrom"));

/** Starts disposable PGlite, Registry, and Router processes from the workspace. */
export const acquireProcessInfrastructure = acquireProcessInfrastructureFrom({
  registry: REGISTRY_BINARY,
  router: ROUTER_BINARY,
});

/** Creates one independent daemon key, credential file, and durable state path. */
export const makeDaemonProcessFixture = (
  infrastructure: ProcessInfrastructure,
  name: string,
  firewall?: FirewallMode,
): Effect.Effect<DaemonProcessFixture, ProcessTestError> =>
  Effect.gen(function* () {
    const agentName = yield* Schema.decodeUnknown(AgentName)(name).pipe(
      Effect.mapError((cause) =>
        processTestError("invalid test agent name", cause),
      ),
    );
    const port = yield* reservePort;
    const directory = join(infrastructure.temporaryDirectory, name);
    const stateDirectory = join(directory, "state");
    const keyPath = join(directory, "agent-key.pem");
    const credentialPath = join(directory, "admission.txt");
    yield* makeDirectory(stateDirectory);
    yield* Effect.all(
      [
        writePrivateFile(keyPath, makePrivateKeyPem()),
        writePrivateFile(credentialPath, ADMISSION_CREDENTIAL),
      ] as const,
      { concurrency: 2, discard: true },
    );
    return {
      agentName,
      endpoint: new URL(`http://${LOOPBACK_HOST}:${port}/mcp`),
      stateDirectory,
      agentPrivateKeyFile: keyPath,
      environment: {
        SHARNESS_STATE_DIRECTORY: stateDirectory,
        SHARNESS_MCP_PORT: String(port),
        SHARNESS_REGISTRY_ORIGIN: infrastructure.registryOrigin.origin,
        SHARNESS_REGISTRY_SIGNER_PUBLIC_KEY:
          infrastructure.registrySignerPublicKeyJson,
        SHARNESS_ROUTER_ORIGIN: infrastructure.routerOrigin.origin,
        SHARNESS_AGENT_PRIVATE_KEY_FILE: keyPath,
        SHARNESS_ADMISSION_CREDENTIAL_FILE: credentialPath,
        ...(firewall === undefined
          ? {}
          : { SHARNESS_TEST_FIREWALL_MODE: firewall }),
      },
      ...(firewall === undefined ? {} : { firewall }),
    };
  }).pipe(Effect.withSpan("makeDaemonProcessFixture"));

/** The command that runs one fixture's daemon. */
const daemonCommand = (
  fixture: DaemonProcessFixture,
): readonly [string, readonly string[]] =>
  fixture.firewall === undefined
    ? [DAEMON_BINARY, []]
    : [process.execPath, ["--import", require.resolve("tsx"), FIREWALL_DAEMON]];

/** Starts one sharnessd and returns only after its guarded loopback port listens. */
export const acquireDaemonProcess = (
  fixture: DaemonProcessFixture,
  executable?: string,
): Effect.Effect<RunningProcess, ProcessTestError, Scope.Scope> =>
  Effect.gen(function* () {
    const baseCommand =
      executable === undefined
        ? daemonCommand(fixture)
        : ([executable, []] as const);
    const [binary, args] =
      fixture.wireVersions !== undefined
        ? launchCommand("Daemon", fixture.wireVersions)
        : baseCommand;
    const running = yield* managedProcess(
      binary,
      args,
      fixture.environment,
      join(WORKSPACE_ROOT, "packages/client"),
    );
    yield* awaitReady(
      running,
      daemonListening(running, fixture.endpoint),
      "listening",
    );
    return running;
  }).pipe(Effect.withSpan("acquireDaemonProcess"));

/** Reserve each port and boot its daemon in one bounded step; release children in parallel. */
export const acquireDaemonProcesses = (infrastructure: ProcessInfrastructure) =>
  Effect.forEach(
    [...Array(CONCURRENT_DAEMONS).keys()],
    (index) =>
      makeDaemonProcessFixture(
        infrastructure,
        `concurrent-agent-${index}`,
      ).pipe(Effect.tap(acquireDaemonProcess)),
    { concurrency: DAEMON_BOOT_CONCURRENCY },
  ).pipe(Effect.parallelFinalizers);

/**
 * Starts one sharnessd that must stop before it listens. A daemon that listens
 * instead fails the fixture.
 */
export const awaitDaemonStartupFailure = (
  fixture: DaemonProcessFixture,
  command?: {
    readonly executable: string;
    readonly args: readonly string[];
    readonly cwd?: string;
  },
): Effect.Effect<DaemonStartupFailure, ProcessTestError, Scope.Scope> =>
  Effect.gen(function* () {
    const [executable, processArguments] =
      command === undefined
        ? daemonCommand(fixture)
        : ([command.executable, command.args] as const);
    const running = yield* managedProcess(
      executable,
      processArguments,
      fixture.environment,
      command?.cwd,
    );
    const listened = yield* awaitReady(
      running,
      daemonListening(running, fixture.endpoint),
      "listening",
    ).pipe(
      Effect.as(true),
      Effect.catchAll((error) =>
        hasExited(running.child) ? Effect.succeed(false) : Effect.fail(error),
      ),
    );
    if (listened) {
      return yield* Effect.fail(
        processTestError(`daemon listened unexpectedly\n${running.logs()}`),
      );
    }
    return { exitCode: running.child.exitCode, logs: running.logs() };
  }).pipe(Effect.withSpan("awaitDaemonStartupFailure"));

const makeIdentifier = (prefix: "opn_" | "prn_"): string =>
  `${prefix}${randomBytes(16).toString("base64url")}`;

/** Creates exact one-shot bootstrap fields for a fixture's configured identity. */
export const makeRegistrationRequest = (
  fixture: DaemonProcessFixture,
): ManagementRegisterRequest => ({
  operationId: Schema.decodeUnknownSync(OperationId)(makeIdentifier("opn_")),
  principalId: Schema.decodeUnknownSync(PrincipalId)(makeIdentifier("prn_")),
  agentName: fixture.agentName,
});

const callAndDecode = <A, I>(input: {
  readonly client: Client;
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly schema: Schema.Schema<A, I>;
}): Effect.Effect<A, ProcessTestError> =>
  Effect.tryPromise({
    try: (signal) =>
      input.client.callTool(
        { name: input.name, arguments: input.arguments },
        { signal },
      ),
    catch: (cause) => processTestError(`${input.name} call failed`, cause),
  }).pipe(
    Effect.filterOrFail(
      (result) => result.isError !== true,
      () => processTestError(`${input.name} returned an MCP error`),
    ),
    Effect.flatMap((result) =>
      Schema.decodeUnknown(input.schema)(result.structuredContent).pipe(
        Effect.mapError((cause) =>
          processTestError(`${input.name} returned invalid content`, cause),
        ),
      ),
    ),
  );

const closeManagementClient = (client: Client): Effect.Effect<void> =>
  Effect.tryPromise({
    try: () => client.close(),
    catch: (cause) =>
      processTestError("could not close management client", cause),
  }).pipe(Effect.ignore);

const callExpectingProtocolError = (
  client: Client,
  name: string,
  toolArguments: Readonly<Record<string, unknown>>,
): Effect.Effect<DaemonProtocolError, ProcessTestError> =>
  Effect.tryPromise({
    try: (signal) =>
      client.callTool({ name, arguments: toolArguments }, { signal }),
    catch: (cause) => processTestError(`${name} call failed`, cause),
  }).pipe(
    Effect.matchEffect({
      onFailure: (error) =>
        ProtocolError.isInstance(error.cause)
          ? Effect.succeed({ code: error.cause.code, data: error.cause.data })
          : Effect.fail(error),
      onSuccess: () =>
        Effect.fail(processTestError(`${name} unexpectedly succeeded`)),
    }),
  );

/** Acquires a private management-only MCP session against one real daemon. */
export const acquireDaemonManagementClient = (
  endpoint: URL,
): Effect.Effect<DaemonManagementClient, ProcessTestError, Scope.Scope> =>
  Effect.gen(function* () {
    const client = new Client(
      { name: "sharness-process-acceptance", version: "1.0.0" },
      {
        capabilities: {},
        versionNegotiation: { mode: { pin: MODERN_PROTOCOL_VERSION } },
      },
    );
    yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: (signal) =>
          client.connect(new StreamableHTTPClientTransport(endpoint), {
            signal,
          }),
        catch: (cause) =>
          processTestError("could not connect management client", cause),
      }),
      () => closeManagementClient(client),
    );
    return managementOperations(client);
  }).pipe(Effect.withSpan("acquireDaemonManagementClient"));

/**
 * The vitest test function of a real-process trace that must assert. A test
 * that times out is failed without waiting for its body, and the worker can
 * exit before an interrupted trace's scope has stopped its children, which
 * then outlive the run. The trace therefore runs as a fiber that an
 * `onTestFinished` hook interrupts, waiting until its scope has stopped every
 * child.
 * @param trace A trace whose scope owns every process it starts.
 * @returns The test function, whose promise settles with the trace.
 */
export function processTrace<E>(
  trace: Effect.Effect<void, E, FileSystem.FileSystem | Scope.Scope>,
) {
  return (context: TestContext) => {
    expect.hasAssertions();
    const fiber = Effect.runFork(
      Effect.scoped(trace).pipe(Effect.provide(NodeContext.layer)),
    );
    context.onTestFinished(
      () => Effect.runPromise(Fiber.interrupt(fiber).pipe(Effect.asVoid)),
      TEARDOWN_TIMEOUT_MS,
    );
    return Effect.runPromise(Fiber.join(fiber));
  };
}

function startNetworkRegistry(
  input: Effect.Effect.Success<typeof prepareInfrastructure>,
  binaries: NetworkBinaries,
) {
  return Effect.gen(function* () {
    const { versions, postgresqlPort, registryPort, registryKeyPath } = input;

    const command: readonly [string, readonly string[]] = Option.isNone(
      versions,
    )
      ? [binaries.registry, []]
      : launchCommand("Registry", versions.value);
    yield* startPgliteRegistry({
      postgresqlPort,
      registryPort,
      registryKeyPath,
      admissionCredential: ADMISSION_CREDENTIAL,
      command,
    });
  });
}

function startNetworkRouter(
  input: Effect.Effect.Success<typeof prepareInfrastructure>,
  binaries: NetworkBinaries,
) {
  return Effect.gen(function* () {
    const {
      versions,
      routerPort,
      registryOrigin,
      registrySignerPublicKeyJson,
      routerOrigin,
    } = input;
    const routerCommand: readonly [string, readonly string[]] = Option.isNone(
      versions,
    )
      ? [binaries.router, []]
      : launchCommand("RouterServer", versions.value);
    return yield* managedProcess(
      routerCommand[0],
      routerCommand[1],
      {
        SHARNESS_ROUTER_HOST: LOOPBACK_HOST,
        SHARNESS_ROUTER_PORT: String(routerPort),
        SHARNESS_ROUTER_REGISTRY_ORIGIN: registryOrigin.origin,
        SHARNESS_ROUTER_REGISTRY_SIGNER_PUBLIC_KEY: registrySignerPublicKeyJson,
        SHARNESS_ROUTER_REQUEST_CONCURRENCY_LIMIT: String(
          CONCURRENT_DAEMONS * REQUESTS_PER_DAEMON,
        ),
        SHARNESS_ROUTER_HELD_POLL_CAPACITY: String(
          CONCURRENT_DAEMONS * HELD_POLLS_PER_DAEMON,
        ),
      },
      join(WORKSPACE_ROOT, "packages/client"),
    ).pipe(
      Effect.tap((router) =>
        awaitReady(
          router,
          serviceReady(router, "sharness-router", routerOrigin),
          "listening",
        ),
      ),
    );
  });
}

function managementOperations(client: Client): DaemonManagementClient {
  const management: DaemonManagementClient = {
    register: (request) =>
      callAndDecode({
        client,
        name: "register",
        arguments: { ...request },
        schema: managementRegisterResultSchema,
      }),
    status: () =>
      callAndDecode({
        client,
        name: "status",
        arguments: {},
        schema: managementStatusResultSchema,
      }),
    searchConversations: () =>
      callAndDecode({
        client,
        name: "search_conversations",
        arguments: {},
        schema: managementSearchConversationsResultSchema,
      }),
    readConversation: (address) =>
      callAndDecode({
        client,
        name: "read_conversation",
        arguments: { address },
        schema: managementReadConversationResultSchema,
      }),
    callExpectingProtocolError: (name, toolArguments) =>
      callExpectingProtocolError(client, name, toolArguments),
  };

  return management;
}

/** Child compositions receive wire sets through plain JavaScript under the test condition. */
function launchCommand(
  service: "Registry" | "RouterServer" | "Daemon",
  versions: ProcessWireVersions,
): readonly [string, readonly string[]] {
  const script =
    service === "Registry"
      ? `import { startRegistry } from "@moltzap/registry/test"; startRegistry(${JSON.stringify(versions satisfies Parameters<typeof startRegistry>[0])});`
      : serviceScript(service, versions);
  return [
    process.execPath,
    ["--conditions=sharness-test", "--input-type=module", "-e", script],
  ];
}

/** Router and daemon compositions share Identity's test wire policy. */
function serviceScript(
  service: "RouterServer" | "Daemon",
  versions: ProcessWireVersions,
): string {
  const module =
    service === "RouterServer"
      ? "@moltzap/router/server"
      : "@moltzap/client/service";
  return `import { NodeRuntime } from "@effect/platform-node";
import { WireVersions } from "@moltzap/identity/test";
import { ${service} } from "${module}";
import { ConfigProvider, Effect, Layer } from "effect";
Layer.launch(${service}.layer).pipe(Effect.provideService(WireVersions, ${JSON.stringify(versions)}), Effect.withConfigProvider(ConfigProvider.fromEnv()), NodeRuntime.runMain);`;
}

function startPglite(port: number) {
  return managedProcess(PGLITE_BINARY, [
    "--db=memory://",
    `--port=${port}`,
    `--host=${LOOPBACK_HOST}`,
    "--max-connections=20",
  ]).pipe(
    Effect.tap((running) =>
      awaitReady(running, pgliteListening(running, port), "listening"),
    ),
  );
}
