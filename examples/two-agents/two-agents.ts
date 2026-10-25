/**
 * @file Starts a local Social Harness network from host executables and a private workspace Registry,
 * registers the agents `alice` and `bob`, sends one message from alice to bob,
 * and prints the message bob receives.
 *
 * The network is one in-memory PGlite database, one Registry, one Router, and
 * one `sharnessd` per agent, each on a free loopback port. Registration goes
 * through each daemon's MCP `register` tool; the message goes through the
 * `HarnessEndpoint` that `@moltzap/client` acquires from the same MCP URL.
 * Every process and the scratch directory are removed when the script ends.
 */
import {
  Command,
  type CommandExecutor,
  FetchHttpClient,
  FileSystem,
  HttpClient,
  type Error as PlatformError,
} from "@effect/platform";
import { NodeContext, NodeRuntime } from "@effect/platform-node";
import {
  Client,
  ProtocolError,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {
  acquireHarnessEndpoint,
  type InboundItem,
  renderContent,
  SendInput,
} from "@moltzap/client";
import {
  Config,
  type ConfigError,
  Console,
  Data,
  Duration,
  Effect,
  Fiber,
  Layer,
  Option,
  type ParseResult,
  Ref,
  Schema,
  type Scope,
  Stream,
} from "effect";
import { createPublicKey, generateKeyPairSync, randomBytes } from "node:crypto";
import { createConnection, createServer } from "node:net";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const HOST = "127.0.0.1";
const ADMISSION_CREDENTIAL = "two-agents-example";
const MCP_PROTOCOL_VERSION = "2026-07-28";
const BIN_DIRECTORY = fileURLToPath(
  new URL("node_modules/.bin/", import.meta.url),
);
const registryBinary = Config.string("SHARNESS_REGISTRY_BIN").pipe(
  Config.withDefault(
    fileURLToPath(
      new URL("../../packages/registry/bin/sharness-registry", import.meta.url),
    ),
  ),
);
const POLL_INTERVAL = Duration.millis(50);
const RUN_TIMEOUT = Duration.minutes(2);
const MESSAGE = "Hi Bob, this is Alice.";

/** The one field of a `register` result this example reads. */
const registerResult = Schema.Struct({ kind: Schema.String });

/** A step of the example that did not complete. */
class ExampleError extends Data.TaggedError("ExampleError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** A started child process and everything it has printed so far. */
interface Running {
  readonly name: string;
  readonly isRunning: Effect.Effect<boolean>;
  readonly output: Effect.Effect<string>;
}

/** One agent's daemon: its name and the MCP URL it serves. */
interface Agent {
  readonly name: string;
  readonly mcp: URL;
}

/** The Registry and Router settings every daemon shares. */
interface Network {
  readonly directory: string;
  readonly registryOrigin: string;
  readonly routerOrigin: string;
  readonly registrySigner: string;
}

/** Every way a setup step fails: a check, a file or process, or a decode. */
type StepError =
  | ExampleError
  | ConfigError.ConfigError
  | PlatformError.PlatformError
  | ParseResult.ParseError;

/** Services the example runs against. */
type Services =
  | CommandExecutor.CommandExecutor
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Scope.Scope;

const twoAgents = Effect.gen(function* () {
  const network = yield* startNetwork();
  const [alice, bob] = yield* Effect.all(
    [startAgent(network, "alice"), startAgent(network, "bob")],
    { concurrency: 2 },
  );
  yield* register(alice);
  yield* register(bob);
  yield* Console.log("registered agent:alice and agent:bob");

  const aliceEndpoint = yield* acquireHarnessEndpoint(alice.mcp);
  const bobEndpoint = yield* acquireHarnessEndpoint(bob.mcp);
  const firstDelivery = yield* Effect.forkScoped(
    Stream.runHead(bobEndpoint.messages),
  );

  yield* aliceEndpoint.send(
    yield* Schema.decodeUnknown(SendInput)({ to: "agent:bob", text: MESSAGE }),
  );
  yield* Console.log(`alice sent: ${MESSAGE}`);

  const delivery = yield* Fiber.join(firstDelivery).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => fail("bob's message stream ended before a delivery"),
        onSome: Effect.succeed,
      }),
    ),
  );
  yield* Console.log(`bob received: ${describe(delivery.item)}`);
  yield* delivery.acknowledge;
}).pipe(Effect.scoped, Effect.timeout(RUN_TIMEOUT));

NodeRuntime.runMain(
  twoAgents.pipe(
    Effect.provide(Layer.merge(NodeContext.layer, FetchHttpClient.layer)),
  ),
);

/**
 * Starts PGlite, the Registry, and the Router, and returns once the Registry
 * and the Router answer their health checks.
 */
function startNetwork(): Effect.Effect<Network, StepError, Services> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({
      prefix: "sharness-two-agents-",
    });
    const registryKey = join(directory, "registry-signing.pem");
    const registryPrivateKey = makePrivateKeyPem();
    yield* fs.writeFileString(registryKey, registryPrivateKey, { mode: 0o600 });
    const [databasePort, registryPort, routerPort] = yield* Effect.all([
      freePort(),
      freePort(),
      freePort(),
    ]);
    const registryOrigin = `http://${HOST}:${registryPort}`;
    const routerOrigin = `http://${HOST}:${routerPort}`;
    const registrySigner = publicJwk(registryPrivateKey);

    const database = yield* start("pglite-server", "pglite", [
      "--db=memory://",
      `--host=${HOST}`,
      `--port=${databasePort}`,
      "--max-connections=20",
    ]);
    yield* awaitReady(database, canConnect(databasePort));
    const registry = yield* start(yield* registryBinary, "registry", [], {
      SHARNESS_REGISTRY_HOST: HOST,
      SHARNESS_REGISTRY_PORT: String(registryPort),
      SHARNESS_REGISTRY_SQL_POOL_SIZE: "1",
      SHARNESS_REGISTRY_POSTGRESQL_URL: `postgresql://postgres:postgres@${HOST}:${databasePort}/postgres`,
      SHARNESS_REGISTRY_ADMISSION_CREDENTIAL: ADMISSION_CREDENTIAL,
      SHARNESS_REGISTRY_SIGNING_PRIVATE_KEY_PATH: registryKey,
    });
    const router = yield* start("sharness-router", "router", [], {
      SHARNESS_ROUTER_HOST: HOST,
      SHARNESS_ROUTER_PORT: String(routerPort),
      SHARNESS_ROUTER_REGISTRY_ORIGIN: registryOrigin,
      SHARNESS_ROUTER_REGISTRY_SIGNER_PUBLIC_KEY: registrySigner,
    });
    yield* awaitReady(registry, isHealthy(registryOrigin));
    yield* awaitReady(router, isHealthy(routerOrigin));
    yield* Console.log(`registry ${registryOrigin}, router ${routerOrigin}`);
    return { directory, registryOrigin, routerOrigin, registrySigner };
  });
}

/**
 * Starts one `sharnessd` with its own key, admission credential file, and state
 * directory, and returns once its MCP port accepts connections.
 */
function startAgent(
  network: Network,
  name: string,
): Effect.Effect<Agent, StepError, Services> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = join(network.directory, name);
    const stateDirectory = join(directory, "state");
    const keyFile = join(directory, "agent-key.pem");
    const admissionFile = join(directory, "admission.txt");
    yield* fs.makeDirectory(stateDirectory, { recursive: true });
    yield* fs.writeFileString(keyFile, makePrivateKeyPem(), { mode: 0o600 });
    yield* fs.writeFileString(admissionFile, ADMISSION_CREDENTIAL, {
      mode: 0o600,
    });
    const port = yield* freePort();
    const daemon = yield* start("sharnessd", name, [], {
      SHARNESS_MCP_PORT: String(port),
      SHARNESS_STATE_DIRECTORY: stateDirectory,
      SHARNESS_REGISTRY_ORIGIN: network.registryOrigin,
      SHARNESS_REGISTRY_SIGNER_PUBLIC_KEY: network.registrySigner,
      SHARNESS_ROUTER_ORIGIN: network.routerOrigin,
      SHARNESS_AGENT_PRIVATE_KEY_FILE: keyFile,
      SHARNESS_ADMISSION_CREDENTIAL_FILE: admissionFile,
    });
    yield* awaitReady(daemon, canConnect(port));
    const mcp = new URL(`http://${HOST}:${port}/mcp`);
    yield* Console.log(`${name}: sharnessd serving ${mcp.href}`);
    return { name, mcp };
  });
}

/**
 * Calls the daemon's `register` MCP tool, which binds the agent name to the
 * daemon's key in the Registry. The operation and principal identifiers are
 * fresh: `opn_` or `prn_` followed by 16 random bytes in base64url. A
 * registration the daemon refuses fails with the daemon's reason.
 */
function register(agent: Agent): Effect.Effect<void, StepError> {
  return Effect.scoped(
    Effect.gen(function* () {
      const client = yield* mcpClient(agent.mcp);
      const result = yield* Effect.tryPromise({
        try: (signal) =>
          client.callTool(
            {
              name: "register",
              arguments: {
                operationId: `opn_${randomBytes(16).toString("base64url")}`,
                principalId: `prn_${randomBytes(16).toString("base64url")}`,
                agentName: agent.name,
              },
            },
            { signal },
          ),
        catch: (cause) =>
          new ExampleError({
            message: `register ${agent.name} failed: ${
              ProtocolError.isInstance(cause)
                ? JSON.stringify(cause.data ?? cause.message)
                : String(cause)
            }`,
            cause,
          }),
      });
      if (result.isError === true) {
        const text = result.content
          .flatMap((part) => (part.type === "text" ? [part.text] : []))
          .join("\n");
        return yield* fail(`register ${agent.name} failed: ${text}`);
      }
      const { kind } = yield* Schema.decodeUnknown(registerResult)(
        result.structuredContent,
      );
      if (kind !== "registered") {
        return yield* fail(`register ${agent.name} returned ${kind}`);
      }
    }),
  );
}

/** Connects one MCP client to `url` for the enclosing scope. */
function mcpClient(url: URL): Effect.Effect<Client, ExampleError, Scope.Scope> {
  const client = new Client(
    { name: "sharness-two-agents-example", version: "1.0.0" },
    {
      capabilities: {},
      versionNegotiation: { mode: { pin: MCP_PROTOCOL_VERSION } },
    },
  );
  return Effect.acquireRelease(
    attempt(`connect to ${url.href}`, (signal) =>
      client.connect(new StreamableHTTPClientTransport(url), { signal }),
    ),
    () =>
      attempt("close the MCP client", () => client.close()).pipe(Effect.ignore),
  ).pipe(Effect.as(client));
}

/** One line describing an inbound item: the sender and the message text. */
function describe(item: InboundItem): string {
  return item.kind === "multicast"
    ? `from ${item.message.sender}: ${renderContent(item.message.content)}`
    : `a ${item.kind} item`;
}

/**
 * Starts the executable `executable` from `node_modules/.bin` for the
 * enclosing scope, which stops it when it closes. The process inherits this
 * process's environment plus `environment`.
 */
function start(
  executable: string,
  name: string,
  args: readonly string[],
  environment: Readonly<Record<string, string>> = {},
): Effect.Effect<Running, StepError, Services> {
  return Effect.gen(function* () {
    const child = yield* Command.make(
      isAbsolute(executable) ? executable : join(BIN_DIRECTORY, executable),
      ...args,
    ).pipe(Command.env(environment), Command.start);
    const output = yield* Ref.make("");
    yield* Stream.merge(child.stdout, child.stderr).pipe(
      Stream.decodeText(),
      Stream.runForEach((chunk) => Ref.update(output, (text) => text + chunk)),
      Effect.forkScoped,
    );
    return {
      name,
      isRunning: child.isRunning.pipe(Effect.orElseSucceed(() => false)),
      output: Ref.get(output),
    };
  });
}

/**
 * Polls `probe` until it succeeds, failing with the process output when the
 * process exits first.
 */
function awaitReady(
  running: Running,
  probe: Effect.Effect<boolean, never, HttpClient.HttpClient>,
): Effect.Effect<void, ExampleError, HttpClient.HttpClient> {
  return Effect.gen(function* () {
    while (yield* running.isRunning) {
      if (yield* probe) {
        return;
      }
      yield* Effect.sleep(POLL_INTERVAL);
    }
    const output = yield* running.output;
    return yield* fail(
      `${running.name} exited before it was ready:\n${output}`,
    );
  });
}

/** Whether a TCP connection to the loopback `port` succeeds. */
function canConnect(port: number): Effect.Effect<boolean> {
  return Effect.async<boolean>((resume) => {
    const socket = createConnection({ host: HOST, port });
    socket.once("connect", () => {
      socket.destroy();
      resume(Effect.succeed(true));
    });
    socket.once("error", () => {
      socket.destroy();
      resume(Effect.succeed(false));
    });
    return Effect.sync(() => {
      socket.destroy();
    });
  });
}

/** Whether `origin` answers `/healthz` with 204 No Content. */
function isHealthy(
  origin: string,
): Effect.Effect<boolean, never, HttpClient.HttpClient> {
  return HttpClient.get(new URL("/healthz", origin)).pipe(
    Effect.map((response) => response.status === 204),
    Effect.scoped,
    Effect.orElseSucceed(() => false),
  );
}

/** A loopback port no listener holds at the moment it is chosen. */
function freePort(): Effect.Effect<number, ExampleError> {
  return Effect.async<number, ExampleError>((resume) => {
    const server = createServer();
    server.once("error", (cause) => {
      resume(Effect.fail(new ExampleError({ message: "no free port", cause })));
    });
    server.listen(0, HOST, () => {
      const address = server.address();
      server.close(() => {
        resume(
          address === null || typeof address === "string"
            ? fail("listener reported no port")
            : Effect.succeed(address.port),
        );
      });
    });
  });
}

/** A fresh unencrypted Ed25519 private key in PKCS#8 PEM. */
function makePrivateKeyPem(): string {
  return generateKeyPairSync("ed25519").privateKey.export({
    format: "pem",
    type: "pkcs8",
  });
}

/**
 * The compact public JWK of `privateKeyPem`, which the Router and every
 * daemon pin as the Registry's signer.
 */
function publicJwk(privateKeyPem: string): string {
  const { crv, kty, x } = createPublicKey(privateKeyPem).export({
    format: "jwk",
  });
  return JSON.stringify({ crv, kty, x });
}

function attempt<A>(
  step: string,
  run: (signal: AbortSignal) => PromiseLike<A>,
): Effect.Effect<A, ExampleError> {
  return Effect.tryPromise({
    try: (signal) => run(signal),
    catch: (cause) => new ExampleError({ message: `could not ${step}`, cause }),
  });
}

function fail(message: string): Effect.Effect<never, ExampleError> {
  return Effect.fail(new ExampleError({ message }));
}
