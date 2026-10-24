/**
 * @file Generates package-local architecture analyzer configurations.
 *
 * Every package's `safer-architecture.config.json` is written from the
 * definitions here. Generation fails, writing nothing, when any path an
 * allowance claims does not exist: the analyzer never complains about an
 * allowance whose target is gone, so a renamed or deleted path would keep
 * passing while guarding nothing.
 */
import { existsSync, writeFileSync } from "node:fs";

interface Allowance {
  readonly package: string;
  readonly reason: string;
}

interface TestSubpath {
  readonly subpath: string;
  readonly reason: string;
}

interface FacadeFile {
  /** Admits this file for loading by the packed root. */
  readonly host?: boolean;
  readonly file: string;
  readonly reason: string;
}

interface ClientDomain {
  /** Admits the whole domain folder for loading by the packed root. */
  readonly host?: boolean;
  readonly name: string;
  /** Domain folder relative to `src/`. */
  readonly root: string;
  /** A bare string is the domain's index; an object is a facade with its reason. */
  readonly entrypoints: ReadonlyArray<string | FacadeFile>;
  readonly reason: string;
}

/** The analyzer configuration keys this generator writes, in emitted order. */
interface ArchitectureConfig {
  readonly isolatedFolders?: ReadonlyArray<{
    readonly folder: string;
    readonly reason: string;
  }>;
  readonly packageRuntime?: string;
  readonly minExportedSiblingModules?: number;
  readonly maxPublicExports?: number;
  readonly minPublicFacadeModules?: number;
  readonly maxFolderCycles?: number;
  readonly publicTypePackages?: readonly Allowance[];
  readonly allowedTestPublicSubpaths?: readonly TestSubpath[];
  readonly folderReadmeFileNames?: readonly string[];
  readonly folderChildCountOverrides?: ReadonlyArray<{
    readonly folder: string;
    readonly maxChildren: number;
    readonly reason: string;
  }>;
  readonly facadeFiles?: readonly FacadeFile[];
  readonly compositionRoots?: ReadonlyArray<{
    readonly path: string;
    readonly reason: string;
  }>;
  readonly domains?: ReadonlyArray<{
    readonly name: string;
    readonly roots: readonly string[];
    readonly entrypoints: readonly string[];
    readonly reason: string;
  }>;
  readonly layers?: ReadonlyArray<{
    readonly name: string;
    readonly folders: readonly string[];
    readonly reason: string;
  }>;
}

/**
 * A package either spells out its whole config or wraps the shared
 * allowances; `beforeShared` and `afterShared` keys land on either side of
 * them, which fixes the emitted key order.
 */
interface PackageDefinition {
  readonly config?: ArchitectureConfig;
  readonly beforeShared?: ArchitectureConfig;
  readonly afterShared?: ArchitectureConfig;
}

const publicTypePackage = {
  effect: {
    package: "effect",
    reason:
      "Foundational Effect runtime; intentionally part of the public contract",
  },
  platform: {
    package: "@effect/platform",
    reason: "Effect platform abstractions used at boundaries",
  },
  platformNode: {
    package: "@effect/platform-node",
    reason: "Effect Node integration used at boundaries",
  },
  rpc: {
    package: "@effect/rpc",
    reason:
      "RPC descriptors are the public contract; Rpc/RpcGroup types cross the boundary by design",
  },
  client: {
    package: "@moltzap/client",
    reason: "Intra-monorepo client SDK; channels depend on its public surface",
  },
};

const publicTypePackages: readonly Allowance[] =
  Object.values(publicTypePackage);

const allowedTestPublicSubpaths: readonly TestSubpath[] = [
  {
    subpath: "./test-utils",
    reason: "Test helpers exposed for cross-package integration testing",
  },
  {
    subpath: "./test",
    reason: "Test harness API for downstream packages",
  },
  {
    subpath: "./test-support",
    reason: "Channel test support exposed for integration tests",
  },
];

const sharedConfig: ArchitectureConfig = {
  publicTypePackages,
  allowedTestPublicSubpaths,
};

/**
 * The client's domains, lowest layer first. A domain may import only the
 * entrypoints of domains listed before it; the generator derives both the
 * CUPID domains and the layer order from this one list.
 */
const clientDomains: readonly ClientDomain[] = [
  {
    name: "encoding",
    root: "encoding",
    entrypoints: [
      {
        file: "exact.ts",
        host: true,
        reason: "Closed struct decoding shared by host-loaded value schemas",
      },
      {
        file: "canonical-json.ts",
        reason: "Canonical JSON encoding of signed and stored values",
      },
      {
        file: "identifier.ts",
        host: true,
        reason: "Canonical identifiers and ordering used by host-loaded values",
      },
    ],
    reason: "Leaf codecs depending only on Effect and canonicalize",
  },
  {
    name: "release",
    host: true,
    root: "release",
    entrypoints: ["index.ts"],
    reason:
      "Client package release metadata used by MCP peers, policy provenance and telemetry",
  },
  {
    name: "firewall-outcome",
    host: true,
    root: "firewall/outcome",
    entrypoints: ["index.ts"],
    reason:
      "Closed refusal and guidance schemas hosts and communication decode without loading policy evaluation or provider clients",
  },

  {
    name: "firewall-evaluator",
    root: "firewall/evaluator",
    entrypoints: ["index.ts"],
    reason:
      "Isolated code and English evaluation depends on encoding, runtime-safe outcomes and packages",
  },
  {
    name: "records",
    root: "communication/records",
    entrypoints: [
      "index.ts",
      {
        file: "values.ts",
        host: true,
        reason:
          "Addresses, post ids, content, and member limits hosts decode without loading signing, verification, or the Router client",
      },
    ],
    reason:
      "Canonical protocol encoding, verification, and the message values every layer encodes",
  },
  {
    name: "store",
    root: "communication/store",
    entrypoints: [
      "index.ts",
      {
        file: "types.ts",
        host: true,
        reason:
          "Store value schemas hosts read without loading the SQLite store",
      },
    ],
    reason:
      "The one SQLite replica: certified history, outbox, deliveries, and the host inbox and send records as opaque bytes",
  },
  {
    name: "router",
    root: "communication/router",
    entrypoints: ["index.ts"],
    reason: "The Router attach, poll, send, and outage worker",
  },
  {
    name: "conversations",
    root: "communication/conversations",
    entrypoints: [
      "index.ts",
      {
        file: "address.ts",
        reason:
          "Registry resolution of a validated address, read without loading the engine",
      },
      {
        file: "errors.ts",
        host: true,
        reason:
          "Closed send, listen, and acknowledgment errors, read without loading the engine",
      },
      {
        file: "message.ts",
        host: true,
        reason: "Inbound message schemas, read without loading the engine",
      },
    ],
    reason: "Addressed send, GENESIS and POST certification, and recovery",
  },
  {
    name: "collectives",
    root: "communication/collectives",
    entrypoints: [
      "index.ts",
      {
        file: "forms.ts",
        host: true,
        reason:
          "Send forms and collective errors, read without loading the operation layer",
      },
      {
        file: "inbound.ts",
        host: true,
        reason:
          "Inbound item schemas, read without loading the operation layer",
      },
      {
        file: "message-text.ts",
        host: true,
        reason:
          "The message-text parser native hosts call, without loading the operation layer",
      },
      {
        file: "render.ts",
        host: true,
        reason:
          "Complete message rendering shared by hosts and policy evidence without loading collective operations",
      },
    ],
    reason: "Gather and all_gather carried in posts",
  },
  {
    name: "harness-protocol",
    root: "harness/protocol",
    entrypoints: [
      "index.ts",
      {
        file: "operations.ts",
        host: true,
        reason:
          "Harness operation values and decoders shared by the host and daemon",
      },
      {
        file: "names.ts",
        host: true,
        reason: "Tool and event names shared by the host and daemon",
      },
    ],
    reason: "The loopback MCP tools, events and results both peers speak",
  },
  {
    name: "harness-endpoint",
    host: true,
    root: "harness/endpoint",
    entrypoints: ["index.ts"],
    reason: "The HarnessEndpoint library an agent host loads",
  },
  {
    name: "firewall",
    root: "firewall",
    entrypoints: ["index.ts"],
    reason:
      "Personal firewall evaluation, rules, policy, admission and audit above communication collectives",
  },
  {
    name: "harness-inbox",
    root: "harness/inbox",
    entrypoints: [
      "index.ts",
      {
        file: "history-export.ts",
        host: true,
        reason:
          "History export values hosts decode without loading inbox state or SQLite",
      },
    ],
    reason: "The classified host inbox, delivery pass and history export",
  },
  {
    name: "harness-mcp",
    root: "harness/mcp",
    entrypoints: ["index.ts"],
    reason:
      "The daemon's loopback MCP server, authentication and event delivery",
  },
  {
    name: "daemon",
    root: "daemon",
    entrypoints: ["index.ts"],
    reason:
      "The always-on process: configuration, registration, supervision, and wiring",
  },
  {
    name: "daemon/launcher",
    root: "daemon/launcher",
    entrypoints: ["index.ts"],
    reason:
      "The daemon launcher: chooses, verifies and installs the release each start runs, then starts its sharnessd as a child process",
  },
];

/**
 * A domain's non-index entrypoints are deliberate boundaries, so declaring
 * one with its reason also declares it a facade.
 */
const clientEntrypointFacades: readonly FacadeFile[] = clientDomains.flatMap(
  ({ root, entrypoints }) =>
    entrypoints
      .filter((entry) => typeof entry !== "string")
      .map(({ file, reason }) => ({ file: `${root}/${file}`, reason })),
);

const clientCompositionRoots = [
  {
    path: "src/index.ts",
    host: true,
    reason:
      "Package facade: re-exports the adapter-facing values each domain owns",
  },
  {
    path: "src/environment.ts",
    host: true,
    reason:
      "Host configuration check for retired environment names re-exported by the package facade",
  },
  {
    path: "src/index.types-check.ts",
    reason: "Type canary for the package facade's public types",
  },
  {
    path: "package.json",
    host: true,
    reason: "Package metadata whose version the loopback MCP peers report",
  },
] as const;

/**
 * Reviewed host paths, independent of the modules a root happens to reach.
 * Whole domains require host approval; other domains admit only flagged values.
 */
export const clientHostModules: ReadonlySet<string> = new Set(
  [
    ...clientCompositionRoots
      .filter((entry) => "host" in entry && entry.host)
      .map(({ path }) => path),
    ...clientDomains.flatMap(({ root, host, entrypoints }) =>
      host
        ? [`src/${root}/`]
        : entrypoints.flatMap((entry) =>
            typeof entry !== "string" && entry.host
              ? [`src/${root}/${entry.file}`]
              : [],
          ),
    ),
  ].map((path) => path.replace(/^src\//u, "dist/").replace(/\.ts$/u, ".js")),
);

const packageDefinitions: Readonly<Record<string, PackageDefinition>> = {
  client: {
    beforeShared: {
      isolatedFolders: [
        {
          folder: "src/daemon/launcher",
          reason:
            "The launcher selects and starts an installed daemon without importing other Client source",
        },
      ],
      maxFolderCycles: 1,
      folderReadmeFileNames: ["README.md", "../README.md"],
      facadeFiles: [
        ...clientEntrypointFacades,
        {
          file: "communication/records/schemas.ts",
          reason:
            "Closed Client wire grammar shared by encoding and verification within the records domain",
        },
        {
          file: "communication/store/database/values.ts",
          reason:
            "Closed store errors and row-value checks shared by database implementation modules",
        },
        {
          file: "daemon/bootstrap.ts",
          reason:
            "Loaded daemon configuration and closed bootstrap failures shared by daemon composition modules",
        },
      ],
      compositionRoots: clientCompositionRoots.map(({ path, reason }) => ({
        path,
        reason,
      })),
      domains: clientDomains.map(({ name, root, entrypoints, reason }) => ({
        name,
        roots: [`src/${root}`],
        entrypoints: entrypoints.map(
          (entry) => `src/${root}/${entrypointFile(entry)}`,
        ),
        reason,
      })),
      layers: [...clientDomains].reverse().map(({ name, root, reason }) => ({
        name,
        folders: [root],
        reason,
      })),
    },
    afterShared: {
      publicTypePackages: [publicTypePackage.effect],
      allowedTestPublicSubpaths: [],
    },
  },
  "nanoclaw-channel": {
    afterShared: {
      publicTypePackages: [publicTypePackage.effect, publicTypePackage.client],
      allowedTestPublicSubpaths: [],
    },
  },
  "openclaw-channel": {
    beforeShared: {
      packageRuntime: "node",
    },
    afterShared: {
      publicTypePackages,
    },
  },
};

const workspaceRoot = new URL("../../", import.meta.url);

const architectureConfigDefinitions: ReadonlyArray<{
  readonly packageRoot: string;
  readonly definition: PackageDefinition;
}> = [
  {
    packageRoot: "plugins/grokbot",
    definition: {
      config: {
        packageRuntime: "node",
        publicTypePackages: [
          publicTypePackage.effect,
          publicTypePackage.platform,
          publicTypePackage.client,
        ],
        allowedTestPublicSubpaths: [],
      },
    },
  },
  ...Object.entries(packageDefinitions).map(([packageName, definition]) => ({
    packageRoot: `packages/${packageName}`,
    definition,
  })),
  {
    packageRoot: "packages/identity",
    definition: {
      config: {
        packageRuntime: "node",
        minExportedSiblingModules: 12,
        maxPublicExports: 40,
        minPublicFacadeModules: 13,
        publicTypePackages: [
          publicTypePackage.effect,
          publicTypePackage.platform,
        ],
        allowedTestPublicSubpaths: [
          {
            subpath: "./test",
            reason:
              "Adjacent-release overrides require the explicit sharness-test resolution condition and are forbidden in production source",
          },
        ],
        folderReadmeFileNames: ["README.md", "MODULE.md"],
        folderChildCountOverrides: [
          {
            folder: ".",
            maxChildren: 12,
            reason:
              "The identity package keeps its closed identifier, key, signed-artifact, request-authentication, and Registry capability boundaries as peer deep modules",
          },
        ],
        facadeFiles: [
          {
            file: "agent-card.ts",
            reason:
              "Immutable Registry attestation boundary for verification and digest operations",
          },
          {
            file: "agent-key.ts",
            reason:
              "Domain entrypoint for Ed25519 public keys, signing authority, and the single-signature General JWS representation shared by AgentCard and SignedMessage",
          },
          {
            file: "http-signature.ts",
            reason:
              "Standards adapter boundary for the closed Social Harness HTTP signature profiles",
          },
          {
            file: "registry.ts",
            reason:
              "Public deep Registry capability and infrastructure-failure boundary",
          },
          {
            file: "registry/client.ts",
            reason:
              "Private HTTP adapter hidden behind the public Registry capability",
          },
          {
            file: "registry/contract.ts",
            reason:
              "Closed Registry request, result, operation value, representation, route, and client-failure contract",
          },
          {
            file: "signed-message.ts",
            reason:
              "Domain entrypoint for the root-exported SignedMessage: signing, verification, the verified trust state, and the recipient order and bounds a sealed body inherits",
          },
        ],
      },
    },
  },
  {
    packageRoot: "packages/registry",
    definition: {
      config: {
        packageRuntime: "node",
        publicTypePackages: [
          publicTypePackage.effect,
          publicTypePackage.platform,
        ],
        allowedTestPublicSubpaths: [],
        folderReadmeFileNames: ["README.md", "MODULE.md"],
        facadeFiles: [
          {
            file: "rpc.ts",
            reason:
              "Correlated in-process RPC boundary between HTTP admission and storage operations",
          },
          {
            file: "server.ts",
            reason:
              "Private Registry process composition used by the operator executable and process fixtures",
          },
          {
            file: "storage.ts",
            reason:
              "Durable Registry storage capability and PostgreSQL implementation boundary",
          },
          {
            file: "migrations/0001_registry.ts",
            reason:
              "Ordered PostgreSQL schema migration seam owned by Registry storage",
          },
        ],
      },
    },
  },
  {
    packageRoot: "packages/router",
    definition: {
      config: {
        packageRuntime: "node",
        publicTypePackages: [
          publicTypePackage.effect,
          publicTypePackage.platform,
        ],
        allowedTestPublicSubpaths: [],
        folderReadmeFileNames: ["README.md", "MODULE.md"],
        folderChildCountOverrides: [
          {
            folder: "router",
            maxChildren: 9,
            reason:
              "The Router implementation keeps contract, RPC, HTTP, send, poll, feed, cursor, waiters, and process as the cohesive boundaries of one independently runnable service",
          },
        ],
        facadeFiles: [
          {
            file: "router/feed.ts",
            reason:
              "Sole state boundary for ordering, retention, and retry identity",
          },
          {
            file: "router/contract.ts",
            reason:
              "Closed Router request, result, operation value, representation, route, limit, and client-failure contract",
          },
          {
            file: "router/poll.ts",
            reason:
              "Authenticated poll behavior boundary over cursor and feed capabilities",
          },
          {
            file: "router/poll-cursor.ts",
            reason:
              "Authenticated continuation boundary for caller-bound cursor state and process-scoped cursor material",
          },
          {
            file: "router/rpc.ts",
            reason:
              "Private correlated dispatch boundary between authenticated HTTP requests and send or poll operations",
          },
          {
            file: "router/send.ts",
            reason:
              "Authenticated send behavior boundary over identity proof and feed capabilities",
          },
        ],
      },
    },
  },
];

if (import.meta.main) {
  const resolved = architectureConfigDefinitions.map(
    ({ packageRoot, definition }) => ({
      packageRoot,
      config: definition.config ?? {
        ...definition.beforeShared,
        ...sharedConfig,
        ...definition.afterShared,
      },
    }),
  );

  const danglingClaims = resolved.flatMap(({ packageRoot, config }) =>
    pathClaims(config)
      .map((claim) => `${packageRoot}/${claim}`)
      .filter((claim) => !existsSync(new URL(claim, workspaceRoot))),
  );

  if (danglingClaims.length > 0) {
    process.stderr.write(
      `${[
        "Architecture config names paths that do not exist:",
        ...danglingClaims.map((claim) => `  ${claim}`),
        "",
        "Every facadeFiles.file, folderChildCountOverrides.folder,",
        "layers[].folders, compositionRoots.path, and domains root or",
        "entrypoint must name a real path. Fix the entry in",
        "scripts/architecture/gen-configs.ts or restore the path it claims.",
      ].join("\n")}\n`,
    );
    process.exit(1);
  }

  for (const { packageRoot, config } of resolved) {
    writeFileSync(
      new URL(`${packageRoot}/safer-architecture.config.json`, workspaceRoot),
      `${JSON.stringify(config, null, 2)}\n`,
    );
  }
}

function entrypointFile(entry: string | FacadeFile): string {
  return typeof entry === "string" ? entry : entry.file;
}

/** Every path the config claims, resolved the way the analyzer resolves it. */
function pathClaims(config: ArchitectureConfig): readonly string[] {
  return [
    ...(config.isolatedFolders ?? []).map((entry) => entry.folder),
    ...(config.facadeFiles ?? []).map((entry) => facadePath(entry.file)),
    ...(config.folderChildCountOverrides ?? []).map((entry) =>
      folderPath(entry.folder),
    ),
    ...(config.layers ?? []).flatMap((layer) =>
      layer.folders.map((folder) => folderPath(folder)),
    ),
    ...(config.compositionRoots ?? []).map((entry) => entry.path),
    ...(config.domains ?? []).flatMap((domain) => [
      ...domain.roots,
      ...domain.entrypoints,
    ]),
  ];
}

/** A facade file is package-root relative and gains an implicit `src/`. */
function facadePath(file: string): string {
  const trimmed = file.replace(/^\.\//u, "");
  return trimmed.startsWith("src/") ? trimmed : `src/${trimmed}`;
}

/** A folder key is relative to `src/`, with `.` naming `src/` itself. */
function folderPath(folder: string): string {
  return folder === "." ? "src" : `src/${folder}`;
}
