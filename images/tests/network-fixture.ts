/**
 * @file A disposable Social Harness network for the agent image integration tests:
 * a local PGlite server, Registry and Router with registered local daemon
 * child processes on loopback ports: `sharnessd`
 * from this workspace, or another daemon program a
 * test names, such as an image's own. `close` stops every process and
 * removes every file the network made.
 */
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {
  acquireHarnessEndpoint,
  type HarnessEndpoint,
  type InboundItem,
  SendInput,
  type SendResult,
} from "@moltzap/social-harness";
import { Chunk, Effect, Exit, Option, Schema, Scope, Stream } from "effect";
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { findPackageJSON } from "node:module";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { freePort, isRecord, member } from "./test-support.ts";
const PROTOCOL_VERSION = "2026-07-28";
const docker = promisify(execFile);

const LOOPBACK_HOST = "127.0.0.1";
/**
 * How long a child process has to listen or report healthy. A daemon listens
 * in seconds on an idle host and takes several times longer while other
 * builds share the machine.
 */
const STARTUP_TIMEOUT_MILLIS = 60_000;
const SHUTDOWN_TIMEOUT_MILLIS = 5_000;
const POLL_INTERVAL_MILLIS = 25;
/** How long a delivery the test awaits may take to arrive. */
const DELIVERY_TIMEOUT_MILLIS = 60_000;
const CHILD_PATH = `${dirname(process.execPath)}:/usr/bin:/bin`;

/** A running network and the way to add endpoints to it. */
export interface Network {
  readonly registryOrigin: URL;
  readonly routerOrigin: URL;
  /** Suspend the disposable Router during delivery-pending cases. */
  readonly holdRouter: () => () => undefined;
  /** Starts and registers one `sharnessd` named `name`, with its harness endpoint. */
  readonly endpoint: (name: string) => Promise<Endpoint>;
  /**
   * Starts and registers one daemon named `name` and leaves its MCP endpoint
   * to the test, as an agent's runtime would hold it.
   */
  readonly daemon: (name: string, options?: DaemonOptions) => Promise<Daemon>;
  /** Stops every process, the endpoints' included, and removes the files. */
  readonly close: () => Promise<undefined>;
}

/** One registered `sharnessd` and its harness endpoint. */
export interface Endpoint {
  /** The endpoint's agent address, `agent:&lt;name>`. */
  readonly address: string;
  /** The daemon's loopback MCP URL. */
  readonly mcp: URL;
  /**
   * Sends through the daemon's harness endpoint, after decoding the input
   * as `HarnessEndpoint.send` takes it.
   */
  readonly send: (input: unknown) => Promise<SendResult>;
  /** Awaits the next `count` inbound items, acknowledging each. */
  readonly next: (count: number) => Promise<readonly InboundItem[]>;
  /** The content of each record of the conversation at `address`, oldest first. */
  readonly history: (address: string) => Promise<readonly unknown[]>;
}

/** How `Network.daemon` starts its daemon. */
interface DaemonOptions {
  /** The daemon program, run under this Node; `sharnessd` when absent. */
  readonly program?: string;
  /** Variables the program reads beside the daemon contract's own. */
  readonly environment?: Readonly<Record<string, string>>;
}

/** One registered daemon whose process the test stops and restarts. */
interface Daemon {
  /** The daemon's agent address, `agent:&lt;name>`. */
  readonly address: string;
  /** The daemon's loopback MCP URL, which a restart keeps. */
  readonly mcp: URL;
  /** The endpoint state directory, which a restart keeps. */
  readonly stateDirectory: string;
  /** Sends SIGTERM and resolves with the exit code once the process exits. */
  readonly stop: () => Promise<number | null>;
  /** Starts the program again on the same key, state and port, and registers it. */
  readonly restart: () => Promise<undefined>;
  /** Everything the current process has written to stdout and stderr. */
  readonly logs: () => string;
}

/** A child process and everything it has written to stdout and stderr. */
interface RunningProcess {
  stop?: () => Promise<undefined>;
  stopped?: boolean;
  readonly child: ChildProcess;
  readonly logs: () => string;
}

/** Public coordinates and bootstrap credential of the disposable network. */
interface NetworkAuthority {
  readonly registryOrigin: string;
  readonly routerOrigin: string;
  readonly registrySignerPublicKeyJson: string;
  readonly admissionCredential: string;
}

/** What every endpoint of one network shares. */
interface NetworkState {
  readonly directory: string;
  readonly authority: NetworkAuthority;
  readonly running: RunningProcess[];
  readonly volumes: string[];
  readonly scope: Scope.CloseableScope;
}

/**
 * Starts a PGlite server, a Registry and a Router, in that order, each
 * healthy before the next starts. A failure stops whatever started.
 * @returns The running network.
 */
export async function startNetwork(): Promise<Network> {
  const directory = await mkdtemp(join(tmpdir(), "agent-image-network-"));
  const running: RunningProcess[] = [];
  const volumes: string[] = [];
  const scope = Effect.runSync(Scope.make());
  const close = () => closeNetwork(directory, scope, running, volumes);
  try {
    const { registryOrigin, routerOrigin, authority } =
      await startInfrastructure(directory, running);
    const state: NetworkState = {
      directory,
      authority,
      running,
      volumes,
      scope,
    };
    return {
      registryOrigin,
      routerOrigin,
      holdRouter: () => {
        const router = running[2];
        if (router === undefined) {
          throw new Error("Router is not running");
        }
        router.child.kill("SIGSTOP");
        return () => {
          router.child.kill("SIGCONT");
          return undefined;
        };
      },
      endpoint: (name) => startEndpoint(state, name),
      daemon: (name, options) => startRegisteredDaemon(state, name, options),
      close,
    };
  } catch (cause) {
    await close();
    throw cause;
  }
}

/** Cleanup continues after failures so one exited daemon cannot strand its peers or volumes. */
async function closeNetwork(
  directory: string,
  scope: Scope.CloseableScope,
  running: RunningProcess[],
  volumes: string[],
): Promise<undefined> {
  const failures: unknown[] = [];
  await collectCleanupFailure(failures, () =>
    Effect.runPromise(Scope.close(scope, Exit.void)),
  );
  for (const each of running.toReversed()) {
    await collectCleanupFailure(failures, () => stopProcess(each));
  }
  for (const volume of volumes) {
    await collectCleanupFailure(failures, () =>
      docker("docker", ["volume", "rm", volume]),
    );
  }
  await collectCleanupFailure(failures, () =>
    rm(directory, { recursive: true, force: true }),
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, failures.map(String).join("\n"));
  }
  return undefined;
}

/** Keeps teardown errors until every resource has had its cleanup attempted. */
async function collectCleanupFailure(
  failures: unknown[],
  cleanup: () => Promise<unknown>,
): Promise<undefined> {
  try {
    await cleanup();
  } catch (cause) {
    failures.push(cause);
  }
}

/** Each started service is recorded before readiness so cleanup includes failed boots. */
async function startInfrastructure(
  directory: string,
  running: RunningProcess[],
) {
  const postgresqlPort = await freePort();
  const registryPort = await freePort();
  const routerPort = await freePort();
  const registryOrigin = new URL(
    `http://${LOOPBACK_HOST}:${String(registryPort)}`,
  );
  const routerOrigin = new URL(`http://${LOOPBACK_HOST}:${String(routerPort)}`);
  const { authority, keyFile } = await networkAuthority(
    directory,
    registryOrigin,
    routerOrigin,
  );
  const database = startProgram(
    join(import.meta.dirname, "node_modules/.bin/pglite-server"),
    [
      "--db=memory://",
      `--port=${String(postgresqlPort)}`,
      `--host=${LOOPBACK_HOST}`,
      "--max-connections=20",
    ],
    {},
  );
  running.push(database);
  await awaitListening(database, postgresqlPort);
  const registry = startRegistry(
    authority,
    registryPort,
    postgresqlPort,
    keyFile,
  );
  running.push(registry);
  await awaitListening(registry, registryPort);
  const router = startRouter(authority, routerPort);
  running.push(router);
  await awaitListening(router, routerPort);
  return { registryOrigin, routerOrigin, authority };
}

/** The daemon consumes compact Registry JWK JSON with lexicographically ordered keys. */
async function networkAuthority(
  directory: string,
  registryOrigin: URL,
  routerOrigin: URL,
) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const keyFile = join(directory, "registry.pem");
  await writeFile(
    keyFile,
    privateKey.export({ format: "pem", type: "pkcs8" }),
    { mode: 0o600 },
  );
  const authority: NetworkAuthority = {
    registryOrigin: registryOrigin.origin,
    routerOrigin: routerOrigin.origin,
    registrySignerPublicKeyJson: JSON.stringify({
      crv: "Ed25519",
      kty: "OKP",
      x: publicKey.export({ format: "jwk" }).x,
    }),
    admissionCredential: randomBytes(32).toString("base64url"),
  };
  return { authority, keyFile };
}

/** Router capacity admits the concurrent cohort's active sends and held polls. */
function startRouter(
  authority: NetworkAuthority,
  routerPort: number,
): RunningProcess {
  return startScript(
    packageFile("@moltzap/router", "bin/sharness-router"),
    [],
    {
      SHARNESS_ROUTER_HOST: LOOPBACK_HOST,
      SHARNESS_ROUTER_PORT: String(routerPort),
      SHARNESS_ROUTER_REGISTRY_ORIGIN: authority.registryOrigin,
      SHARNESS_ROUTER_REGISTRY_SIGNER_PUBLIC_KEY:
        authority.registrySignerPublicKeyJson,
      SHARNESS_ROUTER_REQUEST_CONCURRENCY_LIMIT: "128",
      SHARNESS_ROUTER_HELD_POLL_CAPACITY: "64",
    },
  );
}

/** A single PostgreSQL connection matches PGlite's serialized transaction execution. */
function startRegistry(
  authority: NetworkAuthority,
  registryPort: number,
  postgresqlPort: number,
  keyFile: string,
): RunningProcess {
  return startScript(
    packageFile("@moltzap/registry", "bin/sharness-registry"),
    [],
    {
      SHARNESS_REGISTRY_HOST: LOOPBACK_HOST,
      SHARNESS_REGISTRY_PORT: String(registryPort),
      SHARNESS_REGISTRY_SQL_POOL_SIZE: "1",
      SHARNESS_REGISTRY_POSTGRESQL_URL: `postgresql://postgres:postgres@${LOOPBACK_HOST}:${String(postgresqlPort)}/postgres`,
      SHARNESS_REGISTRY_ADMISSION_CREDENTIAL: authority.admissionCredential,
      SHARNESS_REGISTRY_SIGNING_PRIVATE_KEY_PATH: keyFile,
      SHARNESS_REGISTRY_LIST_PAGE_SIZE: "16",
    },
  );
}

/**
 * Starts one `sharnessd`, registers it as `agent:&lt;name>`, and acquires its
 * harness endpoint in the network's scope.
 * @param state The running network.
 * @param name The agent name.
 * @returns The registered endpoint.
 */
async function startEndpoint(
  state: NetworkState,
  name: string,
): Promise<Endpoint> {
  const daemon = await startRegisteredDaemon(state, name);
  const harness = await Effect.runPromise(
    Scope.extend(acquireHarnessEndpoint(daemon.mcp), state.scope),
  );
  return {
    address: daemon.address,
    mcp: daemon.mcp,
    send: (input) =>
      Effect.runPromise(
        Effect.flatMap(Schema.decodeUnknown(SendInput)(input), (decoded) =>
          harness.send(decoded),
        ),
      ),
    next: (count) => nextItems(harness, count),
    history: (address) => conversationContents(daemon.mcp, address),
  };
}

/**
 * Writes one daemon's key, admission credential and state directory, starts
 * its program on a free loopback port and registers it as `agent:&lt;name>`.
 * A restart runs the program again on the same files and port and repeats
 * the registration with the same operation, which an active daemon accepts
 * as already done.
 * @param state The running network.
 * @param name The agent name.
 * @param options The daemon program and its extra variables.
 * @returns Its address, MCP URL and state directory, and its stop and restart.
 */
async function startRegisteredDaemon(
  state: NetworkState,
  name: string,
  options: DaemonOptions = {},
): Promise<Daemon> {
  const files = await daemonFiles(join(state.directory, name), state.authority);
  const port = await freePort();
  const stateVolume =
    process.env.DAEMON_INTEGRATION_IMAGE !== undefined &&
    options.program === undefined
      ? await createDaemonVolume(state)
      : undefined;
  const mcp = new URL(`http://${LOOPBACK_HOST}:${String(port)}/mcp`);
  const registration = {
    SHARNESS_MCP_URL: mcp.href,
    SHARNESS_REGISTRATION_OPERATION_ID: identifier("opn_"),
    SHARNESS_REGISTRATION_PRINCIPAL_ID: identifier("prn_"),
    SHARNESS_REGISTRATION_AGENT_NAME: name,
  };
  const start = async (): Promise<RunningProcess> => {
    const started = await startDaemon(files, state.authority, {
      ...options,
      environment: { ...options.environment, ...registration },
      port,
      name,
      ...(stateVolume === undefined ? {} : { stateVolume }),
    });
    state.running.push(started);
    return started;
  };
  let current = await start();
  return {
    address: `agent:${name}`,
    mcp,
    stateDirectory:
      stateVolume === undefined
        ? files.stateDirectory
        : "/home/node/sharness-state",
    stop: async () => {
      await stopProcess(current);
      return current.child.exitCode;
    },
    restart: async () => {
      current = await start();
      return undefined;
    },
    logs: () => current.logs(),
  };
}

/** Docker initializes the home volume with the image user's ownership, independent of host IDs. */
async function createDaemonVolume(state: NetworkState): Promise<string> {
  const volume = `sharness-daemon-state-${randomBytes(16).toString("hex")}`;
  await docker("docker", ["volume", "create", volume]);
  state.volumes.push(volume);
  return volume;
}

/** One daemon's private files and state directory. */
interface DaemonFiles {
  readonly stateDirectory: string;
  readonly keyFile: string;
  readonly credentialFile: string;
}

/**
 * Writes one endpoint's key, admission credential and private state
 * directory under `directory`.
 * @param directory The endpoint's own directory.
 * @param authority The network the daemon joins.
 * @returns Where the files are.
 */
async function daemonFiles(
  directory: string,
  authority: NetworkAuthority,
): Promise<DaemonFiles> {
  const stateDirectory = join(directory, "state");
  const keyFile = join(directory, "agent-private-key.pem");
  const credentialFile = join(directory, "admission-credential");
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  await writeFile(
    keyFile,
    generateKeyPairSync("ed25519").privateKey.export({
      format: "pem",
      type: "pkcs8",
    }),
    { mode: 0o600 },
  );
  await writeFile(credentialFile, authority.admissionCredential, {
    mode: 0o600,
  });
  return { stateDirectory, keyFile, credentialFile };
}

/** Where one daemon process listens and what it runs. */
interface DaemonLaunch extends DaemonOptions {
  readonly port: number;
  readonly stateVolume?: string;
  /** The agent name, used only for the error message. */
  readonly name: string;
}

/**
 * Starts the daemon program on its port with the daemon contract's variables
 * and the test's own, and awaits its listener.
 * @param files The daemon's key, credential and state directory.
 * @param authority The network the daemon joins.
 * @param launch The port, the program and its extra variables.
 * @returns The listening process.
 */
async function startDaemon(
  files: DaemonFiles,
  authority: NetworkAuthority,
  launch: DaemonLaunch,
): Promise<RunningProcess> {
  const environment = {
    ...launch.environment,
    SHARNESS_STATE_DIRECTORY: files.stateDirectory,
    SHARNESS_MCP_PORT: String(launch.port),
    SHARNESS_REGISTRY_ORIGIN: authority.registryOrigin,
    SHARNESS_REGISTRY_SIGNER_PUBLIC_KEY: authority.registrySignerPublicKeyJson,
    SHARNESS_ROUTER_ORIGIN: authority.routerOrigin,
    SHARNESS_AGENT_PRIVATE_KEY_FILE: files.keyFile,
    SHARNESS_ADMISSION_CREDENTIAL_FILE: files.credentialFile,
  };
  const image = process.env.DAEMON_INTEGRATION_IMAGE;
  const daemon =
    image !== undefined && launch.program === undefined
      ? await startDaemonContainer(files, launch, environment, image)
      : startScript(
          launch.program ??
            packageFile("@moltzap/social-harness", "bin/sharnessd"),
          [],
          environment,
        );
  try {
    await awaitListening(daemon, launch.port);
  } catch (cause) {
    const failure = new Error(
      `daemon ${launch.name} did not start: ${String(cause)}`,
      {
        cause,
      },
    );
    try {
      await stopProcess(daemon);
    } catch (cleanup) {
      throw new AggregateError([failure, cleanup], failure.message);
    }
    throw failure;
  }
  return daemon;
}

/** Docker prepares volumes before the daemon readiness deadline starts; the host joins its network. */
async function startDaemonContainer(
  files: DaemonFiles,
  launch: DaemonLaunch,
  environment: Readonly<Record<string, string>>,
  image: string,
): Promise<RunningProcess> {
  const directory = dirname(files.stateDirectory);
  await chmod(dirname(directory), 0o755);
  await chmod(directory, 0o755);
  await chmod(files.keyFile, 0o644);
  await chmod(files.credentialFile, 0o644);
  const container = `sharness-daemon-${String(launch.port)}`;
  const args = [
    "create",
    "--network=host",
    "--name",
    container,
    "--volume",
    `${directory}:${directory}:ro`,
    "--mount",
    `type=volume,src=${launch.stateVolume ?? ""},dst=/home/node`,
    "--env",
    "SHARNESS_LAUNCHER_UPGRADE=off",
    ...Object.entries(environment).flatMap(([name, value]) => [
      "--env",
      `${name}=${value}`,
    ]),
    "--env",
    "SHARNESS_STATE_DIRECTORY=/home/node/sharness-state",
    image,
  ];
  await docker("docker", args);
  const daemon = startProgram("docker", ["start", "--attach", container], {});
  daemon.stop = () => stopDaemonContainer(daemon, container);
  return daemon;
}

/** Retains logs until exit reporting and removes only this daemon's container and volumes. */
async function stopDaemonContainer(
  daemon: RunningProcess,
  container: string,
): Promise<undefined> {
  const state = await dockerIfPresent(
    ["container", "inspect", "--format", "{{.State.Running}}", container],
    container,
  );
  let unexpected = state?.trim() !== "true";
  try {
    if (!unexpected) {
      unexpected =
        (await dockerIfPresent(
          ["stop", "--timeout", "5", container],
          container,
        )) === undefined;
    }
    if (!hasExited(daemon.child)) {
      await once(daemon.child, "exit");
    }
  } finally {
    await dockerIfPresent(["rm", "--force", "--volumes", container], container);
  }
  if (unexpected) {
    throw processExitError(daemon, `daemon ${container} was stopped`);
  }
  return undefined;
}

/** Missing containers are already cleaned up; other Docker failures remain visible. */
async function dockerIfPresent(
  args: string[],
  container: string,
): Promise<string | undefined> {
  try {
    const { stdout } = await docker("docker", args);
    return stdout;
  } catch (cause) {
    if (
      !isRecord(cause) ||
      typeof cause.stderr !== "string" ||
      !cause.stderr.includes(`No such container: ${container}`)
    ) {
      throw cause;
    }
    return undefined;
  }
}

/**
 * Awaits the next `count` items the harness endpoint delivers, acknowledging
 * each once all have arrived and before the subscription closes, since a
 * closed subscription's receipts are stale.
 * @param harness The endpoint.
 * @param count How many items to await.
 * @returns The items, in delivery order.
 */
async function nextItems(
  harness: HarnessEndpoint,
  count: number,
): Promise<readonly InboundItem[]> {
  const deliveries = await Effect.runPromise(
    harness.messages.pipe(
      Stream.grouped(count),
      Stream.tap((batch) =>
        Effect.all(
          Chunk.map(batch, ({ acknowledge }) => acknowledge),
          { discard: true },
        ),
      ),
      Stream.runHead,
      Effect.map(
        Option.match({ onNone: () => [], onSome: Chunk.toReadonlyArray }),
      ),
      Effect.timeoutFail({
        duration: DELIVERY_TIMEOUT_MILLIS,
        onTimeout: () =>
          new Error(`timed out awaiting ${String(count)} deliveries`),
      }),
    ),
  );
  return deliveries.map(({ item }) => item);
}

/**
 * Reads the conversation at `address` through the daemon's management
 * `read_conversation` tool.
 * @param mcp The daemon's MCP URL.
 * @param address The peer or group whose conversation is read.
 * @returns Each record's post content.
 */
async function conversationContents(
  mcp: URL,
  address: string,
): Promise<readonly unknown[]> {
  const client = new Client(
    { name: "agent-image-integration", version: "1" },
    { versionNegotiation: { mode: { pin: PROTOCOL_VERSION } } },
  );
  await client.connect(new StreamableHTTPClientTransport(mcp));
  try {
    const result = await client.callTool({
      name: "read_conversation",
      arguments: { address },
    });
    const records = member(result.structuredContent, "records");
    if (result.isError === true || !Array.isArray(records)) {
      throw new Error(`read_conversation ${address} failed`);
    }
    return records.map((record: unknown) => postContent(record, address));
  } finally {
    await client.close().catch(() => undefined);
  }
}

/**
 * The post content of one conversation record, failing on a record that
 * carries none.
 * @param record One decoded record.
 * @param address The conversation, for the failure.
 * @returns The content, as the daemon stored it.
 */
function postContent(record: unknown, address: string): unknown {
  const content = member(record, "recordCore", "action", "postIntent");
  if (!isRecord(content) || !Object.hasOwn(content, "content")) {
    throw new Error(
      `read_conversation ${address} returned a record with no post content: ${JSON.stringify(record)}`,
    );
  }
  return content.content;
}

/**
 * Starts `script` under this Node with only `environment` and `PATH`.
 * @param script The entry script.
 * @param args Its arguments.
 * @param environment Its environment.
 * @returns The started process.
 */
function startScript(
  script: string,
  args: readonly string[],
  environment: Readonly<Record<string, string>>,
): RunningProcess {
  return startProgram(process.execPath, [script, ...args], environment);
}

/** Captures a child executable's output while keeping the parent environment private. */
function startProgram(
  program: string,
  args: readonly string[],
  environment: Readonly<Record<string, string>>,
): RunningProcess {
  const child = spawn(program, args, {
    env: { PATH: CHILD_PATH, ...environment },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const append = (chunk: string): void => {
    output += chunk;
  };
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", append);
  }
  return { child, logs: () => output };
}

/**
 * Stops `running` with SIGTERM, then SIGKILL once its grace has passed.
 * @param running The started child and its logs.
 */
async function stopProcess(running: RunningProcess): Promise<undefined> {
  if (running.stopped === true) {
    return;
  }
  running.stopped = true;
  if (running.stop !== undefined) {
    await running.stop();
    return;
  }
  const { child } = running;
  if (hasExited(child)) {
    return;
  }
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const timer = setTimeout(() => {
    child.kill("SIGKILL");
  }, SHUTDOWN_TIMEOUT_MILLIS);
  await exited;
  clearTimeout(timer);
}

/**
 * Resolves once the process accepts a connection on `port`.
 * @param running The process.
 * @param port The loopback port it listens on.
 */
function awaitListening(
  running: RunningProcess,
  port: number,
): Promise<undefined> {
  return awaitReady(running, () => canConnect(port), "listening");
}

/**
 * Polls until `check` is true, failing if `running` exits or the startup
 * timeout passes first.
 * @param running The process being started.
 * @param check The readiness probe.
 * @param what What readiness means, for the error message.
 */
async function awaitReady(
  running: RunningProcess,
  check: () => Promise<boolean>,
  what: string,
): Promise<undefined> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MILLIS;
  while (Date.now() < deadline) {
    if (hasExited(running.child)) {
      throw processExitError(running, what);
    }
    if (await check()) {
      return;
    }
    await delay(POLL_INTERVAL_MILLIS);
  }
  throw new Error(`process did not report ${what} in time\n${running.logs()}`);
}

/** Keeps the exit outcome and the most recent diagnostics together in test failures. */
function processExitError(running: RunningProcess, what: string): Error {
  return new Error(
    `process exited with status ${String(running.child.exitCode)} (signal ${String(running.child.signalCode)}) before ${what}\n${running.logs().split("\n").slice(-50).join("\n")}`,
  );
}

/**
 * Whether the process has exited or been killed.
 * @param child The process.
 * @returns The finding.
 */
function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

/**
 * Whether the loopback `port` accepts a connection.
 * @param port A loopback port.
 * @returns The finding.
 */
function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: LOOPBACK_HOST, port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

/**
 * The absolute path of a file inside an installed package.
 * @param specifier An installed package.
 * @param relative A path inside it.
 * @returns The path's absolute location.
 */
function packageFile(specifier: string, relative: string): string {
  const manifest = findPackageJSON(specifier, import.meta.url);
  if (manifest === undefined) {
    throw new Error(`${specifier} is not installed`);
  }
  return join(dirname(manifest), relative);
}

/**
 * A fresh one-shot operation or principal id.
 * @param prefix The identifier kind.
 * @returns The prefix followed by 16 random bytes in base64url.
 */
function identifier(prefix: "opn_" | "prn_"): string {
  return `${prefix}${randomBytes(16).toString("base64url")}`;
}
