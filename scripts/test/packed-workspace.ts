/**
 * @file Packs workspace packages the way a release does and proves the packed
 * closure installs into an isolated consumer.
 *
 * `pnpm pack` rewrites every `workspace:*` dependency to the sibling's manifest
 * version, so a consumer installing from npm resolves exactly the version the
 * same release publishes. Each package gate packs its closure through here,
 * checks the rewritten pins, installs the tarballs into a private consumer
 * project, and then runs only its package-specific assertions.
 */
import {
  Command,
  type CommandExecutor,
  FileSystem,
  type Error as PlatformError,
} from "@effect/platform";
import { NodeContext, NodeRuntime } from "@effect/platform-node";
import { Cause, Data, Effect, type ParseResult, Schema, Stream } from "effect";
import { join, relative, resolve } from "node:path";
import { parse } from "yaml";
import { WIRE_VERSION } from "../../packages/client/src/identity/wire-version.ts";
import {
  FINAL_PACKAGES,
  type PackageDir,
} from "../architecture/boundary-contract.ts";
import { recordPackedWireVersion } from "../release/content-hash.ts";

/** Services every pack gate step runs against. */
export type GateServices =
  | CommandExecutor.CommandExecutor
  | FileSystem.FileSystem;

/** A pack gate check that did not hold. */
export class PackGateError extends Data.TaggedError("PackGateError")<{
  readonly message: string;
}> {}

/** Every way a gate step fails: a check, a file or process, or a decode. */
export type GateError =
  | PackGateError
  | PlatformError.PlatformError
  | ParseResult.ParseError;

/**
 * The packed `package.json` fields the shared checks read. `private` stays
 * unknown because a published manifest must omit it entirely, and `bin`
 * targets stay unknown so a non-string target fails its own check.
 */
const packedManifest = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  private: Schema.optional(Schema.Unknown),
  bin: Schema.optional(
    Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  ),
  dependencies: Schema.optional(
    Schema.Record({ key: Schema.String, value: Schema.String }),
  ),
  exports: Schema.optional(
    Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  ),
  main: Schema.optional(Schema.Unknown),
  types: Schema.optional(Schema.Unknown),
});

/** A manifest as `pnpm pack` wrote it into the tarball. */
export type PackedManifest = typeof packedManifest.Type;

const sourceManifest = Schema.Struct({ version: Schema.String });

/**
 * Options for {@link runCommand}. `env` entries override the parent
 * environment; an empty `NODE_PATH` adds no search paths, which is how a
 * consumer check drops the parent's.
 */
interface RunOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
}

/** Package names mapped to the tarball each one packed into. */
export type Archives = Readonly<Record<string, string>>;

/** Description of the consumer project {@link installPackedConsumer} builds. */
interface ConsumerInput {
  /** Scratch directory owned by the caller. */
  readonly temporaryRoot: string;
  /** Source workspace the install must not reach. */
  readonly workspaceRoot: string;
  readonly name: string;
  readonly archives: Archives;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
}

/**
 * Fail with `detail` unless the checked fact holds.
 * @param holds Checked fact.
 * @param detail Failure message.
 */
export function requireCondition(
  holds: boolean,
  detail: string,
): Effect.Effect<void, PackGateError> {
  return Effect.succeed(holds).pipe(
    Effect.filterOrFail(
      (fact) => fact,
      () => new PackGateError({ message: detail }),
    ),
    Effect.asVoid,
  );
}

/**
 * Run one command to completion and return its standard output, failing when
 * it exits non-zero. The failure carries both output streams, because tools
 * such as `tsc` print their diagnostics on standard output.
 * @param command Executable name or path.
 * @param args Arguments passed verbatim.
 * @param options Working directory and environment overrides.
 */
export function runCommand(
  command: string,
  args: readonly string[],
  options: RunOptions = {},
): Effect.Effect<string, GateError, CommandExecutor.CommandExecutor> {
  return runProcess(command, args, options).pipe(
    Effect.tap(({ stdout, stderr, exitCode }) =>
      requireCondition(
        exitCode === 0,
        `${[command, ...args].join(" ")} exited with ${exitCode}:\n${stdout}${stderr}`,
      ),
    ),
    Effect.map(({ stdout }) => stdout),
    Effect.withSpan("packedWorkspace.runCommand"),
  );
}

/** What a finished process printed and how it exited. */
export interface Finished {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/**
 * Run one command to completion and report both output streams and its exit
 * code, for a check that expects a particular failure.
 * @param command Executable name or path.
 * @param args Arguments passed verbatim.
 * @param options Working directory and environment overrides.
 */
export function runProcess(
  command: string,
  args: readonly string[],
  options: RunOptions = {},
): Effect.Effect<Finished, GateError, CommandExecutor.CommandExecutor> {
  return Effect.scoped(
    Effect.gen(function* () {
      const child = yield* Command.start(configure(command, args, options));
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [collect(child.stdout), collect(child.stderr), child.exitCode],
        { concurrency: 3 },
      );
      return { stdout, stderr, exitCode };
    }),
  ).pipe(Effect.withSpan("packedWorkspace.runProcess"));
}

/**
 * Read and decode one JSON file.
 * @param path File to read.
 * @param schema Shape the parsed JSON must have.
 */
export function readJsonFile<A, I>(
  path: string,
  schema: Schema.Schema<A, I>,
): Effect.Effect<A, GateError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(path);
    return yield* Schema.decodeUnknown(Schema.parseJson(schema))(text);
  }).pipe(Effect.withSpan("packedWorkspace.readJsonFile"));
}

/**
 * Read one text file, failing with `missing` when the file system refuses.
 * @param path File to read.
 * @param missing Failure message when the file is absent or unreadable.
 */
export function readText(
  path: string,
  missing: string,
): Effect.Effect<string, GateError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.readFileString(path);
  }).pipe(
    Effect.catchTag("SystemError", () =>
      Effect.fail(new PackGateError({ message: missing })),
    ),
    Effect.withSpan("packedWorkspace.readText"),
  );
}

/**
 * Run a pack gate as the process entry point: provide the Node services and a
 * scratch directory that is removed with everything under it when the gate
 * ends on any path, print the line the gate returns when it passes, and exit
 * non-zero with the failure, or the defect's cause, when it does not.
 * @param prefix Scratch directory name prefix.
 * @param gate The gate program, given the scratch directory; it returns the
 * success line to print.
 */
export function runGate(
  prefix: string,
  gate: (
    temporaryRoot: string,
  ) => Effect.Effect<string, GateError, GateServices>,
): void {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return yield* gate(yield* fs.makeTempDirectoryScoped({ prefix }));
    }),
  ).pipe(
    Effect.flatMap((line) =>
      Effect.sync(() => process.stdout.write(`${line}\n`)),
    ),
    Effect.tapErrorCause((cause) =>
      Effect.sync(() =>
        process.stderr.write(
          `${Cause.isFailType(cause) ? cause.error.message : Cause.pretty(cause)}\n`,
        ),
      ),
    ),
    Effect.withSpan("packedWorkspace.runGate"),
  );
  NodeRuntime.runMain(program.pipe(Effect.provide(NodeContext.layer)), {
    disableErrorReporting: true,
  });
}

/**
 * Derive the packed closure and publishability from the source contract,
 * independently of the tarballs being verified.
 * @param workspaceRoot Source workspace root.
 * @param entry Product whose transitive closure is packed.
 * @param temporaryRoot Scratch directory owned by the caller.
 * @returns Package name to tarball path and packed manifest.
 */
export function packProductClosure(
  workspaceRoot: string,
  entry: PackageDir,
  temporaryRoot: string,
) {
  const closure = new Set<PackageDir>();
  function visit(dir: PackageDir): void {
    if (closure.has(dir)) {
      return;
    }
    closure.add(dir);
    for (const dependency of FINAL_PACKAGES[dir].deps) {
      visit(dependency);
    }
  }
  visit(entry);
  return packWorkspaceClosure(
    Object.fromEntries(
      [...closure].map((dir) => [
        FINAL_PACKAGES[dir].npmName,
        join(workspaceRoot, "packages", dir),
      ]),
    ),
    temporaryRoot,
    new Set(
      [...closure]
        .filter((dir) => FINAL_PACKAGES[dir].published)
        .map((dir) => FINAL_PACKAGES[dir].npmName),
    ),
  );
}

/**
 * Consumer installs use the workspace's Effect override and its TypeScript and
 * OpenClaw catalog entries, including npm aliases, so they exercise the
 * versions the workspace builds.
 * @param workspaceRoot Source workspace root.
 * @returns Dependency specifiers for the isolated consumer.
 */
export function readConsumerPins(workspaceRoot: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(
      join(workspaceRoot, "pnpm-workspace.yaml"),
    );
    const value = yield* Effect.try({
      try: (): unknown => parse(text),
      catch: (cause) => new PackGateError({ message: String(cause) }),
    });
    const workspace = yield* Schema.decodeUnknown(
      Schema.Struct({
        catalog: Schema.Struct({
          openclaw: Schema.String,
          typescript: Schema.String,
        }),
        overrides: Schema.Struct({ effect: Schema.String }),
      }),
    )(value);
    return {
      effect: workspace.overrides.effect,
      openclaw: workspace.catalog.openclaw,
      typescript: workspace.catalog.typescript,
    };
  }).pipe(Effect.withSpan("packedWorkspace.readConsumerPins"));
}

/**
 * Invoke the installed compiler through its declared executable; catalog aliases
 * may expose a versioned command name.
 * @param consumerRoot Isolated consumer with TypeScript installed.
 */
export function checkConsumerTypes(consumerRoot: string) {
  return Effect.gen(function* () {
    const compilerRoot = join(consumerRoot, "node_modules", "typescript");
    const compiler = yield* readJsonFile(
      join(compilerRoot, "package.json"),
      Schema.Struct({
        bin: Schema.Record({ key: Schema.String, value: Schema.String }),
      }),
    );
    const target = Object.entries(compiler.bin).find(([name]) =>
      /^tsc\d*$/u.test(name),
    )?.[1];
    if (target === undefined) {
      return yield* new PackGateError({
        message: "TypeScript declares no compiler executable",
      });
    }
    yield* runCommand(
      process.execPath,
      [
        join(compilerRoot, target),
        "--project",
        join(consumerRoot, "tsconfig.json"),
      ],
      { cwd: consumerRoot },
    );
  }).pipe(Effect.withSpan("packedWorkspace.checkConsumerTypes"));
}

/**
 * Extract one tarball under `temporaryRoot/extracted` and return the package
 * directory inside it.
 * @param archive Tarball path.
 * @param temporaryRoot Scratch directory owned by the caller.
 * @returns The extracted `package/` directory.
 */
export function extractPackedArchive(
  archive: string,
  temporaryRoot: string,
): Effect.Effect<string, GateError, GateServices> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const extractedRoot = join(temporaryRoot, "extracted");
    yield* fs.makeDirectory(extractedRoot);
    yield* runCommand("tar", ["-xzf", archive, "-C", extractedRoot]);
    return join(extractedRoot, "package");
  }).pipe(Effect.withSpan("packedWorkspace.extractPackedArchive"));
}

/**
 * Create a consumer project under `temporaryRoot/consumer` that depends on
 * the packed tarballs plus `dependencies`, install it with the tarballs
 * overriding every workspace name, and prove each declared package resolved
 * inside that project rather than back into the workspace.
 * @param input Consumer description.
 * @returns The consumer directory.
 */
export function installPackedConsumer(
  input: ConsumerInput,
): Effect.Effect<string, GateError, GateServices> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const consumerRoot = join(input.temporaryRoot, "consumer");
    yield* fs.makeDirectory(consumerRoot);
    yield* writeConsumerProject(consumerRoot, input);
    yield* runCommand(
      "pnpm",
      [
        "install",
        "--no-frozen-lockfile",
        "--ignore-scripts",
        "--prefer-offline",
      ],
      { cwd: consumerRoot },
    );
    yield* verifyIsolatedInstall(
      consumerRoot,
      [
        ...Object.keys(input.archives),
        ...Object.keys(input.dependencies ?? {}),
        ...Object.keys(input.devDependencies ?? {}),
      ],
      input.workspaceRoot,
    );
    return consumerRoot;
  }).pipe(Effect.withSpan("packedWorkspace.installPackedConsumer"));
}

/**
 * Pack every package in `packageRoots` under `temporaryRoot/tarballs` and
 * prove the packed manifests form an installable closure: each keeps its
 * source name and version, carries the publishability the caller declares,
 * ships the Apache `LICENSE` and `NOTICE` files, ships every executable its
 * `bin` map names, and pins every packed sibling to that sibling's exact
 * packed version.
 *
 * `publishable` is passed in rather than read off the packed manifest,
 * because a manifest compared against itself cannot fail. The boundary check
 * enforces the same rule on the source manifests; this one enforces it on
 * what `pnpm pack` actually produced, and those are different artifacts.
 * @param packageRoots Package name to source root.
 * @param temporaryRoot Scratch directory owned by the caller.
 * @param publishable Names that must pack publishable; every other name in
 * `packageRoots` must pack private.
 * @returns Package name to tarball path and to packed manifest.
 */
export function packWorkspaceClosure(
  packageRoots: Readonly<Record<string, string>>,
  temporaryRoot: string,
  publishable: ReadonlySet<string>,
): Effect.Effect<
  {
    readonly archives: Archives;
    readonly manifests: Readonly<Record<string, PackedManifest>>;
  },
  GateError,
  GateServices
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const destination = join(temporaryRoot, "tarballs");
    yield* fs.makeDirectory(destination);
    const packed = yield* Effect.forEach(
      Object.entries(packageRoots),
      ([name, root]) => packOne(name, root, destination),
      { concurrency: 4 },
    );
    const manifests = Object.fromEntries(
      packed.map(({ name, manifest }) => [name, manifest]),
    );
    yield* Effect.forEach(
      packed,
      (entry) => verifyPacked(entry, manifests, publishable),
      { concurrency: 1, discard: true },
    );
    return {
      archives: Object.fromEntries(
        packed.map(({ name, archive }) => [name, archive]),
      ),
      manifests,
    };
  }).pipe(Effect.withSpan("packedWorkspace.packWorkspaceClosure"));
}

interface PackedEntry {
  readonly name: string;
  readonly archive: string;
  readonly manifest: PackedManifest;
  readonly files: ReadonlySet<string>;
  readonly sourceVersion: string;
}

function configure(
  command: string,
  args: readonly string[],
  options: RunOptions,
): Command.Command {
  const base = Command.make(command, ...args).pipe(
    Command.env(options.env ?? {}),
  );
  return options.cwd === undefined
    ? base
    : Command.workingDirectory(base, options.cwd);
}

function collect<E>(
  stream: Stream.Stream<Uint8Array, E>,
): Effect.Effect<string, E> {
  return stream.pipe(Stream.decodeText(), Stream.mkString);
}

function packOne(
  name: string,
  root: string,
  destination: string,
): Effect.Effect<PackedEntry, GateError, GateServices> {
  return Effect.gen(function* () {
    const archive = yield* packWorkspacePackage(root, destination);
    if (name === "@moltzap/client") {
      const failure = yield* Effect.try({
        try: () => recordPackedWireVersion(archive, WIRE_VERSION),
        catch: (cause) => new PackGateError({ message: String(cause) }),
      });
      if (failure !== undefined) {
        return yield* new PackGateError({ message: failure.message });
      }
    }
    const [manifest, files, source] = yield* Effect.all(
      [
        readPackedManifest(archive),
        listPackedFiles(archive),
        readJsonFile(join(root, "package.json"), sourceManifest),
      ],
      { concurrency: 3 },
    );
    return { name, archive, manifest, files, sourceVersion: source.version };
  });
}

function packWorkspacePackage(
  packageRoot: string,
  destination: string,
): Effect.Effect<string, GateError, CommandExecutor.CommandExecutor> {
  return Effect.gen(function* () {
    const stdout = yield* runCommand(
      "pnpm",
      ["pack", "--pack-destination", destination],
      { cwd: packageRoot },
    );
    const printed = nonEmptyLines(stdout).at(-1);
    if (printed === undefined) {
      return yield* new PackGateError({
        message: "pnpm pack returned no archive",
      });
    }
    return resolve(packageRoot, printed);
  });
}

function readPackedManifest(
  archive: string,
): Effect.Effect<PackedManifest, GateError, CommandExecutor.CommandExecutor> {
  return runCommand("tar", ["-xOf", archive, "package/package.json"]).pipe(
    Effect.flatMap((text) =>
      Schema.decodeUnknown(Schema.parseJson(packedManifest))(text),
    ),
  );
}

function listPackedFiles(
  archive: string,
): Effect.Effect<
  ReadonlySet<string>,
  GateError,
  CommandExecutor.CommandExecutor
> {
  return runCommand("tar", ["-tzf", archive]).pipe(
    Effect.map((stdout) => new Set(nonEmptyLines(stdout))),
  );
}

function nonEmptyLines(text: string): readonly string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function verifyPacked(
  entry: PackedEntry,
  manifests: Readonly<Record<string, PackedManifest>>,
  publishable: ReadonlySet<string>,
): Effect.Effect<void, PackGateError> {
  const { name, manifest, files } = entry;
  return Effect.all(
    [
      requireCondition(
        manifest.name === name && manifest.version === entry.sourceVersion,
        `packed ${name} manifest identity drifted`,
      ),
      verifyPublishability(name, manifest, publishable),
      ...["LICENSE", "NOTICE"].map((notice) =>
        requireCondition(
          files.has(`package/${notice}`),
          `packed ${name} does not ship ${notice}`,
        ),
      ),
      ...Object.entries(manifest.bin ?? {}).map(([executable, target]) =>
        requireCondition(
          typeof target === "string" &&
            files.has(`package/${target.replace(/^\.\//u, "")}`),
          `packed ${name} does not ship its ${executable} executable at ${String(target)}`,
        ),
      ),
      verifySiblingPins(name, manifest, manifests),
    ],
    { concurrency: 1, discard: true },
  );
}

function verifyPublishability(
  name: string,
  manifest: PackedManifest,
  publishable: ReadonlySet<string>,
): Effect.Effect<void, PackGateError> {
  return publishable.has(name)
    ? requireCondition(
        manifest.private === undefined,
        `packed ${name} carries a private flag and cannot be published`,
      )
    : requireCondition(
        manifest.private === true,
        `packed ${name} must stay private; it is not in the published set`,
      );
}

function verifySiblingPins(
  name: string,
  manifest: PackedManifest,
  manifests: Readonly<Record<string, PackedManifest>>,
): Effect.Effect<void, PackGateError> {
  return Effect.forEach(
    Object.entries(manifest.dependencies ?? {}).filter(
      ([dependency]) => dependency in manifests,
    ),
    ([dependency, pinned]) =>
      requireCondition(
        pinned === manifests[dependency]?.version,
        `packed ${name} does not pin ${dependency} to its packed version`,
      ),
    { concurrency: 1, discard: true },
  );
}

function writeConsumerProject(
  consumerRoot: string,
  input: ConsumerInput,
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem> {
  const devDependencies = input.devDependencies ?? {};
  const localPackages = Object.fromEntries(
    Object.entries(input.archives).map(([packageName, archive]) => [
      packageName,
      `file:${relative(consumerRoot, archive)}`,
    ]),
  );
  const manifest = {
    name: input.name,
    version: "0.0.0",
    private: true,
    type: "module",
    dependencies: { ...localPackages, ...input.dependencies },
    ...(Object.keys(devDependencies).length === 0 ? {} : { devDependencies }),
  };
  const workspace = [
    'packages: ["."]',
    "overrides:",
    ...Object.entries(localPackages).map(
      ([packageName, specifier]) =>
        `  ${JSON.stringify(packageName)}: ${JSON.stringify(specifier)}`,
    ),
    "",
  ].join("\n");
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(
      join(consumerRoot, "package.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    yield* fs.writeFileString(
      join(consumerRoot, "pnpm-workspace.yaml"),
      workspace,
    );
  });
}

function verifyIsolatedInstall(
  consumerRoot: string,
  packageNames: readonly string[],
  workspaceRoot: string,
): Effect.Effect<void, GateError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const installedRoot = yield* fs.realPath(consumerRoot);
    const lockfile = yield* fs.readFileString(
      join(consumerRoot, "pnpm-lock.yaml"),
    );
    yield* requireCondition(
      !lockfile.includes(workspaceRoot) &&
        !lockfile.includes("workspace:") &&
        !lockfile.includes("link:"),
      "packed consumer lockfile escaped to a workspace or linked dependency",
    );
    yield* Effect.forEach(
      packageNames,
      (packageName) =>
        fs
          .realPath(
            join(consumerRoot, "node_modules", ...packageName.split("/")),
          )
          .pipe(
            Effect.flatMap((installed) =>
              requireCondition(
                installed.startsWith(`${installedRoot}/`),
                `packed consumer resolved ${packageName} outside its isolated install`,
              ),
            ),
          ),
      { concurrency: 8, discard: true },
    );
  });
}
