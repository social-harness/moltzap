/**
 * @file Proves the packed `@moltzap/client` exposes exactly its public entry
 * points and executables, keeps its root entry inside the host import
 * allowlists, and imports cleanly from an isolated consumer.
 */
import { FileSystem } from "@effect/platform";
import { Effect, Schema } from "effect";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  FINAL_PACKAGES,
  manifestExportTarget,
} from "./architecture/boundary-contract.ts";
import { verifyHostImportGraph } from "./test/client-host-imports.ts";
import {
  type Archives,
  extractPackedArchive,
  type GateError,
  type GateServices,
  installPackedConsumer,
  type PackedManifest,
  PackGateError,
  packProductClosure,
  readConsumerPins,
  readText,
  requireCondition,
  runCommand,
  runGate,
} from "./test/packed-workspace.ts";

const workspaceRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/** A packed consumer composes English and code middleware without a live provider. */
const policyConsumerCheck = `
const { Effect, Layer, Schema } = await import("effect");
const decodeAuditLine = Schema.decodeUnknownSync(Schema.parseJson(service.FirewallAuditRecord));
const auditStart = decodeAuditLine(JSON.stringify({
  kind: "start", format: "org.social-harness/firewall-audit/v4", snapshotId: "a".repeat(64),
  startedAt: "2026-10-17T00:00:00.000Z",
}));
const auditComplete = decodeAuditLine(JSON.stringify({
  kind: "complete", format: "org.social-harness/firewall-audit/v4", snapshotId: auditStart.snapshotId,
  checkCount: 0, activationCount: 0, sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
}));
if (auditComplete.kind !== "complete" || auditComplete.snapshotId !== auditStart.snapshotId) {
  throw new Error("Client operator audit decoder lost snapshot identity");
}
const english = await Effect.runPromise(service.makeEnglishPolicy({
  id: "owner",
  rules: [{ id: "privacy", kind: "safety", text: "Do not disclose unrelated private appointments." }],
  provider: {
    decide: () => Effect.fail(new service.DecisionProviderError({
      reason: "transport",
    })),
  },
  settings: {
    minimumProbability: 0.5,
    maximumRequestBytes: 60000,
    timeoutMilliseconds: 1000,
  },
}));
const code = {
  id: "code", revision: "v1", rules: [{ id: "local", kind: "safety" }],
  check: () => Effect.succeed({ findings: [{ ruleId: "local", outcome: "pass" }], expectations: [] }),
};
const firewall = await Effect.runPromise(service.makeFirewall({
  incoming: [code], outgoing: [code, english],
  settings: { timeoutMilliseconds: 10000, middlewareTimeoutMilliseconds: 5000,
    maximumInputBytes: 60000, maximumResultBytes: 100000 },
}));
const message = {
    id: "draft",
    sender: "organizer",
    recipients: ["participant"],
    text: "Are you free Tuesday?",
};
const context = {
  agentId: "organizer", principal: "owner", participants: [],
  history: [],
  facts: [],
  gaps: [],
  authorization: { kind: "absent" },
};
const assessment = await Effect.runPromise(firewall.checkOutgoing(message, context));
if (assessment.judgment !== "hold" ||
    assessment.reason !== "check-unavailable") {
  throw new Error("Client policy assessment did not hold an unavailable check");
}
const incoming = { ...message, sender: "participant", recipients: ["organizer"] };
const received = await Effect.runPromise(firewall.checkIncoming(incoming, context));
if (received.judgment !== "allow") {
  throw new Error("Client code middleware could not admit an incoming message");
}
const invalidInstallation = service.Daemon.withFirewall({
  mode: "enforcement", incoming: [], outgoing: [], facts: [], codeDigest: "0".repeat(64),
  auditExport: "/operator/private/firewall-audit.ndjson",
  settings: { timeoutMilliseconds: 10000, middlewareTimeoutMilliseconds: 5000,
    maximumInputBytes: 60000, maximumResultBytes: 100000 },
});
const startupError = await Effect.runPromise(
  Effect.scoped(Layer.build(invalidInstallation)).pipe(Effect.flip),
);
if (!(startupError instanceof service.Daemon.StartupError) ||
    startupError.phase !== "configuration") {
  throw new Error("Invalid firewall installation did not stop daemon startup");
}
`;

runGate("sharness-client-pack-", (temporaryRoot) =>
  Effect.gen(function* () {
    const { archives, manifests } = yield* packProductClosure(
      workspaceRoot,
      "client",
      temporaryRoot,
    );
    const archive = archives["@moltzap/client"];
    const manifest = manifests["@moltzap/client"];
    const { effect: effectDependency } = yield* readConsumerPins(workspaceRoot);
    if (
      archive === undefined ||
      manifest === undefined ||
      manifest.dependencies?.effect === undefined
    ) {
      return yield* new PackGateError({
        message: "client package or Effect dependency is missing",
      });
    }
    const publicSpecifiers = yield* verifyPackedManifest(
      archive,
      manifest,
      temporaryRoot,
    );
    yield* verifyConsumerImports(
      archives,
      publicSpecifiers,
      temporaryRoot,
      effectDependency,
    );
    return "client package consumer check passed";
  }),
);

function verifyPackedManifest(
  archive: string,
  manifest: PackedManifest,
  temporaryRoot: string,
): Effect.Effect<readonly string[], GateError, GateServices> {
  return Effect.gen(function* () {
    const extractedPackage = yield* extractPackedArchive(
      archive,
      temporaryRoot,
    );
    yield* requireCondition(
      JSON.stringify(manifest.bin) ===
        JSON.stringify(FINAL_PACKAGES.client.bin),
      "packed client must expose exactly the sharnessd and sharnessd-launcher executables",
    );
    const exportEntries = Object.entries(manifest.exports ?? {});
    yield* requireCondition(
      isDeepStrictEqual(manifest.exports, packedExportContract()),
      `packed client must expose exactly these contract entrypoints: ${Object.keys(FINAL_PACKAGES.client.exports).join(", ")}`,
    );
    yield* verifyExportTargets(extractedPackage, manifest, exportEntries);
    yield* verifyLibraryContents(archive, manifest);
    yield* verifyHostImportGraph(extractedPackage, String(manifest.main));
    yield* Effect.forEach(
      Object.entries(FINAL_PACKAGES.client.bin),
      ([name, target]) =>
        verifyExecutable(join(extractedPackage, target), name),
      { concurrency: 1, discard: true },
    );
    return Object.entries(FINAL_PACKAGES.client.exports)
      .filter(([, target]) => !target.testOnly && !target.internalOnly)
      .map(([subpath]) =>
        subpath === "."
          ? manifest.name
          : `${manifest.name}/${subpath.slice(2)}`,
      );
  });
}

/** Private service code and SQL dependencies stay outside the installed library. */
function verifyLibraryContents(
  archive: string,
  manifest: PackedManifest,
): Effect.Effect<void, GateError, GateServices> {
  return Effect.gen(function* () {
    yield* requireCondition(
      !Object.keys(manifest.dependencies ?? {}).some((name) =>
        name.startsWith("@effect/sql"),
      ),
      "packed library must not depend on Registry SQL storage",
    );
    const listing = yield* runCommand("tar", ["-tzf", archive]);
    yield* requireCondition(
      !listing
        .split("\n")
        .some(
          (file) =>
            /(?:^|\/)(?:issuance|storage|server)\.(?:js|d\.ts)$/u.test(file) ||
            /\/(?:dist|identity\/registry|communication\/router)\/configuration\.(?:js|d\.ts)$/u.test(
              file,
            ),
        ),
      "packed library must not contain service issuance, storage or server configuration",
    );
  });
}

/** Contract metadata becomes condition-only manifest export objects. */
function packedExportContract() {
  return Object.fromEntries(
    Object.entries(FINAL_PACKAGES.client.exports).map(([subpath, target]) => [
      subpath,
      manifestExportTarget(target),
    ]),
  );
}

function collectExportTargets(value: unknown): readonly unknown[] {
  if (typeof value === "string") {
    return [value];
  }
  return value !== null && typeof value === "object"
    ? Object.values(value).flatMap((nested) => collectExportTargets(nested))
    : [];
}

function verifyExportTargets(
  extractedPackage: string,
  manifest: PackedManifest,
  exportEntries: ReadonlyArray<readonly [string, unknown]>,
): Effect.Effect<void, GateError, FileSystem.FileSystem> {
  const targets = new Set([
    manifest.main,
    manifest.types,
    ...exportEntries.flatMap(([, value]) => collectExportTargets(value)),
  ]);
  return Effect.forEach(
    targets,
    (target) =>
      typeof target === "string" && target.startsWith("./")
        ? readText(
            join(extractedPackage, target),
            `packed client is missing export target ${target}`,
          )
        : requireCondition(
            false,
            `packed client has an invalid export target: ${String(target)}`,
          ),
    { concurrency: 1, discard: true },
  );
}

function verifyExecutable(
  executablePath: string,
  name: string,
): Effect.Effect<void, GateError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const executable = yield* readText(
      executablePath,
      `packed ${name} executable is missing`,
    );
    yield* requireCondition(
      executable.startsWith("#!/usr/bin/env node\n"),
      `packed ${name} executable has no Node shebang`,
    );
    const info = yield* fs.stat(executablePath);
    yield* requireCondition(
      (info.mode & 0o111) !== 0,
      `packed ${name} executable is not executable`,
    );
  });
}

function verifyConsumerImports(
  archives: Archives,
  publicSpecifiers: readonly string[],
  temporaryRoot: string,
  effectDependency: string,
): Effect.Effect<void, GateError, GateServices> {
  return Effect.gen(function* () {
    const consumerRoot = yield* installPackedConsumer({
      temporaryRoot,
      workspaceRoot,
      name: "sharness-client-packed-consumer",
      archives,
      dependencies: { effect: effectDependency },
    });
    yield* verifyConsumerExecutables(consumerRoot, temporaryRoot);
    const checkPath = join(consumerRoot, "check.mjs");
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(
      checkPath,
      publicSpecifiers
        .map((specifier) => `await import(${JSON.stringify(specifier)});`)
        .join("\n") +
        `\nconst root = await import("@moltzap/client");\n` +
        `if (!("HistoryExportRecord" in root)) throw new Error("Client root does not export HistoryExportRecord");\n` +
        `\nconst service = await import("@moltzap/client/service");\n` +
        policyConsumerCheck,
    );
    yield* runCommand(
      process.execPath,
      [
        "--conditions=sharness-test",
        "--input-type=module",
        "-e",
        `const actual = Object.keys(await import("@moltzap/client/test")).sort();
const expected = ["AuthenticatedHttp", "HISTORY_WIRE_VERSIONS", "WireVersions", "managementReadConversationResultSchema", "managementRegisterRequestSchema", "managementRegisterResultSchema", "managementSearchConversationsResultSchema", "managementStatusResultSchema"].sort();
if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("Client test schemas differ: " + JSON.stringify(actual));`,
      ],
      { cwd: consumerRoot, env: { NODE_PATH: "" } },
    );
    yield* verifyInternalResolution(consumerRoot);
    yield* runCommand(process.execPath, [checkPath], {
      cwd: consumerRoot,
      env: { NODE_PATH: "" },
    });
  });
}

/**
 * Installed entrypoints load, and offline preparation reports `upgrade-off`
 * with an existing daemon path under the consumer root.
 */
function verifyConsumerExecutables(
  consumerRoot: string,
  temporaryRoot: string,
): Effect.Effect<void, GateError, GateServices> {
  return Effect.gen(function* () {
    yield* Effect.forEach(
      ["sharnessd", "sharnessd-launcher"],
      (name) =>
        runCommand(
          join(consumerRoot, "node_modules", ".bin", name),
          ["--help"],
          {
            cwd: consumerRoot,
            env: { NODE_PATH: "" },
          },
        ),
      { concurrency: 1, discard: true },
    );
    const output = yield* runCommand(
      "env",
      [
        "-u",
        "SHARNESS_LAUNCHER_SEED",
        "-u",
        "SHARNESS_LAUNCHER_VERSION",
        join(consumerRoot, "node_modules", ".bin", "sharnessd-launcher"),
        "prepare",
      ],
      {
        cwd: consumerRoot,
        env: {
          NODE_PATH: "",
          SHARNESS_LAUNCHER_DIRECTORY: join(temporaryRoot, "launcher"),
          SHARNESS_LAUNCHER_PACKAGE: "@moltzap/client",
          SHARNESS_LAUNCHER_UPGRADE: "off",
        },
      },
    );
    yield* verifyPreparedDaemon(output, consumerRoot);
  });
}

/** Requires the offline choice to keep `upgrade-off` and name an existing daemon under the consumer root. */
function verifyPreparedDaemon(
  output: string,
  consumerRoot: string,
): Effect.Effect<void, GateError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const choice = yield* Schema.decodeUnknown(
      Schema.parseJson(
        Schema.Struct({
          kept: Schema.Literal("upgrade-off"),
          daemon: Schema.NonEmptyString,
        }),
      ),
    )(output.trim());
    yield* requireCondition(
      isAbsolute(choice.daemon),
      `Prepared daemon path must be absolute: ${choice.daemon}`,
    );
    const fs = yield* FileSystem.FileSystem;
    const daemonPath = relative(
      yield* fs.realPath(consumerRoot),
      yield* fs.realPath(choice.daemon),
    );
    yield* requireCondition(
      daemonPath !== "" &&
        !isAbsolute(daemonPath) &&
        !daemonPath.split(sep).includes(".."),
      `Prepared daemon must be under the consumer root: ${choice.daemon}`,
    );
  });
}

/** Service capabilities resolve only under the private service condition. */
function verifyInternalResolution(consumerRoot: string) {
  return Effect.gen(function* () {
    yield* runCommand(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
try {
  await import("@moltzap/client/internal");
  throw new Error("internal entry resolved without its condition");
} catch (error) {
  if (error.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw error;
}
`,
      ],
      { cwd: consumerRoot, env: { NODE_PATH: "" } },
    );
    yield* runCommand(
      process.execPath,
      [
        "--conditions=sharness-internal",
        "--input-type=module",
        "-e",
        `
const internal = await import("@moltzap/client/internal");
for (const name of ["verifyBootstrapRequest", "agentCardSigning", "Registry", "Router"]) {
  if (!(name in internal)) throw new Error("missing internal capability " + name);
}
`,
      ],
      { cwd: consumerRoot, env: { NODE_PATH: "" } },
    );
  });
}
