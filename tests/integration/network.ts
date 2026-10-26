/**
 * @file Runs the own-network path the docs describe, end to end. The packed
 * Client and the `images/` helper install from tarballs and npm,
 * `images/compose.yaml` starts the images tagged `SHARNESS_NETWORK_VERSION`,
 * three `sharnessd` daemons start unregistered, and `images/mcp.ts` registers
 * them and sends a message. The gate passes when each step prints what the
 * docs say it prints and each refusal exits 1 with the reason the docs name.
 */
import { Command, type CommandExecutor, FileSystem } from "@effect/platform";
import {
  Config,
  Duration,
  Effect,
  Ref,
  Schedule,
  Schema,
  type Scope,
  Stream,
} from "effect";
import { createPublicKey, generateKeyPairSync, randomBytes } from "node:crypto";
import { createConnection, createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type GateError,
  type GateServices,
  installPackedConsumer,
  PackGateError,
  packProductClosure,
  readJsonFile,
  requireCondition,
  runGate,
} from "../../scripts/test/packed-workspace.js";

const workspaceRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const imagesRoot = join(workspaceRoot, "images");
const HOST = "127.0.0.1";
const MESSAGE = "Hi Bob, this is Alice.";

/** How long the path may take once the images are present. */
const GATE_DEADLINE = Duration.minutes(6);

/** How often bob's inbox is read before the message must have arrived. */
const DELIVERY_ATTEMPTS = 30;

const helperManifest = Schema.Struct({
  dependencies: Schema.Record({ key: Schema.String, value: Schema.String }),
});

/** What a finished command printed and how it exited. */
interface Finished {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/** The settings every daemon on the network shares. */
interface Network {
  readonly registryOrigin: string;
  readonly routerOrigin: string;
  readonly registrySigner: string;
  readonly admissionCredential: string;
}

/** One daemon the helper talks to: its working directory and MCP URL. */
interface Daemon {
  readonly name: string;
  readonly directory: string;
  readonly mcpUrl: string;
}

runGate("sharness-network-", (temporaryRoot) =>
  Effect.gen(function* () {
    const version = yield* Config.string("SHARNESS_NETWORK_VERSION").pipe(
      Effect.mapError(
        () =>
          new PackGateError({
            message:
              "set SHARNESS_NETWORK_VERSION to the tag of the Registry and Router images to run",
          }),
      ),
    );
    const { archives } = yield* packProductClosure(
      workspaceRoot,
      "client",
      temporaryRoot,
    );
    const manifest = yield* readJsonFile(
      join(imagesRoot, "package.json"),
      helperManifest,
    );
    const consumerRoot = yield* installPackedConsumer({
      temporaryRoot,
      workspaceRoot,
      name: "sharness-network",
      archives,
      dependencies: manifest.dependencies,
    });
    const fs = yield* FileSystem.FileSystem;
    yield* fs.copyFile(
      join(imagesRoot, "compose.yaml"),
      join(consumerRoot, "compose.yaml"),
    );
    yield* fs.copyFile(
      join(imagesRoot, "mcp.ts"),
      join(consumerRoot, "mcp.ts"),
    );
    return yield* Effect.scoped(ownNetworkPath(consumerRoot, version)).pipe(
      Effect.timeoutFail({
        duration: GATE_DEADLINE,
        onTimeout: () =>
          new PackGateError({
            message: `the own-network path did not finish within ${Duration.format(GATE_DEADLINE)}`,
          }),
      }),
    );
  }),
);

/**
 * Starts the network and three daemons in `consumerRoot`, then registers and
 * messages through the helper as the docs do.
 * @param consumerRoot Directory holding the installed packages and copied files.
 * @param version Image tag the Compose file runs.
 * @returns The line the gate prints when it passes.
 */
function ownNetworkPath(
  consumerRoot: string,
  version: string,
): Effect.Effect<string, GateError, GateServices | Scope.Scope> {
  return Effect.gen(function* () {
    const network = yield* startNetwork(consumerRoot, version);
    const alice = yield* startDaemon(consumerRoot, network, "alice");
    const bob = yield* startDaemon(consumerRoot, network, "bob");
    const carol = yield* startDaemon(consumerRoot, network, "carol");

    yield* expectOutput(alice, ["register", "alice"], "registered agent:alice");
    yield* expectOutput(
      alice,
      ["register", "alice"],
      "already active: agent:alice",
    );
    yield* expectOutput(bob, ["register", "bob"], "registered agent:bob");
    yield* expectRefusal(carol, ["register", "alice"], "name_taken");
    yield* expectOutput(alice, ["call", "status", "{}"], '"kind": "active"');

    const message = JSON.stringify({ to: "agent:bob", text: MESSAGE });
    yield* expectOutput(alice, ["call", "send_message", message], "{");
    yield* expectOutput(bob, ["call", "read_inbox", "{}"], MESSAGE).pipe(
      Effect.retry(
        Schedule.spaced(Duration.seconds(1)).pipe(
          Schedule.intersect(Schedule.recurs(DELIVERY_ATTEMPTS)),
        ),
      ),
    );
    const unknown = JSON.stringify({ to: "agent:nobody", text: MESSAGE });
    yield* expectRefusal(
      alice,
      ["call", "send_message", unknown],
      "send_message failed",
    );
    return "own-network path passed";
  });
}

/**
 * Writes the keys and settings the network page writes, then starts Compose
 * with `--detach --wait` for the enclosing scope.
 * @param consumerRoot Directory holding `compose.yaml`.
 * @param version Image tag the Compose file runs.
 * @returns The origins and secrets daemons join the network with.
 */
function startNetwork(
  consumerRoot: string,
  version: string,
): Effect.Effect<Network, GateError, GateServices | Scope.Scope> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const keyDirectory = join(consumerRoot, "keys");
    yield* fs.makeDirectory(keyDirectory);
    const registryKey = makePrivateKeyPem();
    yield* fs.writeFileString(
      join(keyDirectory, "registry-signing.pem"),
      registryKey,
      { mode: 0o600 },
    );
    const [registryPort, routerPort] = yield* Effect.all([
      freePort(),
      freePort(),
    ]);
    const network: Network = {
      registryOrigin: `http://${HOST}:${registryPort}`,
      routerOrigin: `http://${HOST}:${routerPort}`,
      registrySigner: publicJwk(registryKey),
      admissionCredential: randomBytes(32).toString("base64url"),
    };
    const environment = {
      SHARNESS_NETWORK_VERSION: version,
      SHARNESS_NETWORK_ADMISSION_CREDENTIAL: network.admissionCredential,
      SHARNESS_NETWORK_REGISTRY_SIGNER: network.registrySigner,
      SHARNESS_NETWORK_KEY_DIRECTORY: keyDirectory,
      SHARNESS_NETWORK_UID: String(process.getuid?.() ?? 1000),
      SHARNESS_NETWORK_GID: String(process.getgid?.() ?? 1000),
      SHARNESS_NETWORK_REGISTRY_PORT: String(registryPort),
      SHARNESS_NETWORK_ROUTER_PORT: String(routerPort),
    };
    const project = `sharness-network-${randomBytes(8).toString("hex")}`;
    const compose = (...args: readonly string[]) =>
      finish(
        Command.make(
          "docker",
          "compose",
          "--file",
          join(consumerRoot, "compose.yaml"),
          "--project-name",
          project,
          ...args,
        ).pipe(Command.env(environment)),
      );
    yield* Effect.addFinalizer(() =>
      compose("down", "--volumes", "--remove-orphans").pipe(Effect.ignore),
    );
    const up = yield* compose("up", "--detach", "--wait");
    if (up.exitCode !== 0) {
      const logs = yield* compose("logs");
      return yield* Effect.fail(
        new PackGateError({
          message: `docker compose up --detach --wait exited with ${up.exitCode}:\n${up.stdout}${up.stderr}\n${logs.stdout}${logs.stderr}`,
        }),
      );
    }
    return network;
  });
}

/**
 * Starts one unregistered `sharnessd` from the installed Client, with the six
 * settings and the admission credential file the daemon page sets, for the
 * enclosing scope. Returns once its MCP port accepts connections, and fails
 * with the daemon's output when it exits first.
 * @param consumerRoot Directory holding the installed packages.
 * @param network Settings the daemon joins with.
 * @param name Agent name, also the daemon's directory name.
 * @returns Where the helper reaches the daemon.
 */
function startDaemon(
  consumerRoot: string,
  network: Network,
  name: string,
): Effect.Effect<Daemon, GateError, GateServices | Scope.Scope> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = join(consumerRoot, "agents", name);
    yield* fs.makeDirectory(join(directory, "state"), { recursive: true });
    yield* fs.writeFileString(
      join(directory, "agent-key.pem"),
      makePrivateKeyPem(),
      { mode: 0o600 },
    );
    yield* fs.writeFileString(
      join(directory, "admission-credential"),
      network.admissionCredential,
      { mode: 0o600 },
    );
    const port = yield* freePort();
    const child = yield* Command.make(
      join(consumerRoot, "node_modules", ".bin", "sharnessd"),
    ).pipe(
      Command.env({
        SHARNESS_MCP_PORT: String(port),
        SHARNESS_STATE_DIRECTORY: join(directory, "state"),
        SHARNESS_REGISTRY_ORIGIN: network.registryOrigin,
        SHARNESS_REGISTRY_SIGNER_PUBLIC_KEY: network.registrySigner,
        SHARNESS_ROUTER_ORIGIN: network.routerOrigin,
        SHARNESS_AGENT_PRIVATE_KEY_FILE: join(directory, "agent-key.pem"),
        SHARNESS_ADMISSION_CREDENTIAL_FILE: join(
          directory,
          "admission-credential",
        ),
      }),
      Command.start,
    );
    const output = yield* Ref.make("");
    yield* Stream.merge(child.stdout, child.stderr).pipe(
      Stream.decodeText(),
      Stream.runForEach((chunk) => Ref.update(output, (all) => all + chunk)),
      Effect.forkScoped,
    );
    while (yield* child.isRunning.pipe(Effect.orElseSucceed(() => false))) {
      if (yield* canConnect(port)) {
        return { name, directory, mcpUrl: `http://${HOST}:${port}/mcp` };
      }
      yield* Effect.sleep(Duration.millis(100));
    }
    return yield* Effect.fail(
      new PackGateError({
        message: `sharnessd for ${name} exited before it served port ${port}:\n${yield* Ref.get(output)}`,
      }),
    );
  });
}

/**
 * Runs the helper for `daemon` and requires exit 0 with `expected` in its
 * standard output.
 */
function expectOutput(
  daemon: Daemon,
  args: readonly string[],
  expected: string,
): Effect.Effect<void, GateError, CommandExecutor.CommandExecutor> {
  return helper(daemon, args).pipe(
    Effect.flatMap(({ stdout, stderr, exitCode }) =>
      requireCondition(
        exitCode === 0 && stdout.includes(expected),
        `node mcp.ts ${args.join(" ")} for ${daemon.name}: expected exit 0 printing ${JSON.stringify(expected)}, got exit ${exitCode}:\n${stdout}${stderr}`,
      ),
    ),
  );
}

/**
 * Runs the helper for `daemon` and requires exit 1 with `reason` and the
 * docs link every failure ends with in its standard error.
 */
function expectRefusal(
  daemon: Daemon,
  args: readonly string[],
  reason: string,
): Effect.Effect<void, GateError, CommandExecutor.CommandExecutor> {
  return helper(daemon, args).pipe(
    Effect.flatMap(({ stdout, stderr, exitCode }) =>
      requireCondition(
        exitCode === 1 && stderr.includes(reason) && stderr.includes("Docs: "),
        `node mcp.ts ${args.join(" ")} for ${daemon.name}: expected exit 1 naming ${JSON.stringify(reason)} and a Docs link, got exit ${exitCode}:\n${stdout}${stderr}`,
      ),
    ),
  );
}

/** Runs `node mcp.ts` in the daemon's directory against its MCP URL. */
function helper(
  daemon: Daemon,
  args: readonly string[],
): Effect.Effect<Finished, GateError, CommandExecutor.CommandExecutor> {
  return finish(
    Command.make(
      process.execPath,
      join(dirname(dirname(daemon.directory)), "mcp.ts"),
      ...args,
    ).pipe(
      Command.workingDirectory(daemon.directory),
      Command.env({ SHARNESS_MCP_URL: daemon.mcpUrl, NODE_PATH: "" }),
    ),
  );
}

/** Runs `command` to completion and reports its output and exit code. */
function finish(
  command: Command.Command,
): Effect.Effect<Finished, GateError, CommandExecutor.CommandExecutor> {
  return Effect.scoped(
    Effect.gen(function* () {
      const child = yield* Command.start(command);
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [decode(child.stdout), decode(child.stderr), child.exitCode],
        { concurrency: 3 },
      );
      return { stdout, stderr, exitCode };
    }),
  );
}

function decode<E>(
  stream: Stream.Stream<Uint8Array, E>,
): Effect.Effect<string, E> {
  return stream.pipe(
    Stream.decodeText(),
    Stream.runFold("", (all, chunk) => all + chunk),
  );
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

/** A loopback port no listener holds at the moment it is chosen. */
function freePort(): Effect.Effect<number, PackGateError> {
  return Effect.async<number, PackGateError>((resume) => {
    const server = createServer();
    server.once("error", () => {
      resume(Effect.fail(new PackGateError({ message: "no free port" })));
    });
    server.listen(0, HOST, () => {
      const address = server.address();
      server.close(() => {
        resume(
          address === null || typeof address === "string"
            ? Effect.fail(
                new PackGateError({ message: "listener reported no port" }),
              )
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

/** The compact public JWK the Router and every daemon pin as the signer. */
function publicJwk(privateKeyPem: string): string {
  const { crv, kty, x } = createPublicKey(privateKeyPem).export({
    format: "jwk",
  });
  return JSON.stringify({ crv, kty, x });
}
