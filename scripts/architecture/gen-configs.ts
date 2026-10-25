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
import { FINAL_PACKAGE_DIRS } from "./boundary-contract.ts";

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
        host: true,
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
    name: "identity",
    root: "identity",
    entrypoints: [
      {
        file: "agents.ts",
        host: true,
        reason: "Canonical agent, principal and immutable name schemas",
      },
      {
        file: "keys.ts",
        host: true,
        reason: "Exact Ed25519 public keys and opaque signing authority",
      },
      {
        file: "cards.ts",
        host: true,
        reason:
          "Immutable AgentCard representation, digest and pinned verification",
      },
      {
        file: "card-signing.ts",
        host: false,
        reason: "Registry card issuance with private signing authority",
      },
      {
        file: "wire-version.ts",
        host: true,
        reason: "Wire emission and live or retained compatibility policy",
      },
      {
        file: "signing/registered/index.ts",
        host: false,
        reason:
          "Registered-request authentication capability with opaque verification proofs",
      },
      {
        file: "index.ts",
        reason:
          "Identity request authentication and immutable Registry resolution",
      },
      {
        file: "signing/http-signature.ts",
        host: false,
        reason:
          "Bootstrap and registered HTTP signing and verification boundary",
      },
      {
        file: "signing/http-errors.ts",
        host: false,
        reason: "Closed authenticated HTTP framing and admission errors",
      },
      {
        file: "registry/index.ts",
        host: false,
        reason:
          "Registry class tag and HTTP client composition for immutable resolution",
      },
      {
        file: "bounded-cache.ts",
        host: true,
        reason:
          "Bounded immutable-key caches shared by identity implementations",
      },
      {
        file: "registry/contract.ts",
        host: false,
        reason:
          "Exact Registry routes, operation grammar and canonical wire codecs",
      },
    ],
    reason:
      "Identity, request authentication and immutable Registry resolution",
  },
  {
    name: "envelope",
    root: "communication/envelope",
    entrypoints: [
      {
        file: "signed-message.ts",
        host: true,
        reason:
          "Opaque attributed message representation, signing and verification",
      },
      {
        file: "sealed-body.ts",
        host: false,
        reason: "End-to-end sealing and opening of attributed message bodies",
      },
      {
        file: "wire-profile.ts",
        host: true,
        reason:
          "Attributed envelope representation parameters read by host-loaded SignedMessage schemas",
      },
    ],
    reason:
      "Opaque attributed and sealed message bodies below endpoint protocols",
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
    name: "router-api",
    root: "communication/router/api",
    host: false,
    entrypoints: [
      {
        file: "index.ts",
        reason: "Opaque Router operation schemas and client capability entry",
      },
      {
        file: "contract.ts",
        reason:
          "Exact Router routes, operation grammar, bounds and wire codecs",
      },
      {
        file: "client.ts",
        reason: "Router class tag and authenticated send or poll HTTP client",
      },
    ],
    reason:
      "Opaque Router values and HTTP client below endpoint protocol records",
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
      .filter((entry) => typeof entry !== "string" || entry !== "index.ts")
      .map((entry) =>
        typeof entry === "string"
          ? {
              file: `${root}/${entry}`,
              reason: "Named domain capability boundary",
            }
          : { file: `${root}/${entry.file}`, reason: entry.reason },
      ),
);

const clientCompositionRoots = [
  {
    path: "src/internal.ts",
    reason:
      "Condition-only identity verification, card signing, Registry and Router service contracts",
  },
  {
    path: "src/test.ts",
    reason:
      "Condition-only management schemas for cross-package process fixtures",
  },
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
          file: "internal.ts",
          reason:
            "Condition-only named service verification, signing and wire contracts",
        },
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
      publicTypePackages: [
        publicTypePackage.effect,
        publicTypePackage.platform,
        {
          package: "node",
          reason:
            "URL is the platform-standard endpoint locator required by the public acquisition contract",
        },
      ],
      allowedTestPublicSubpaths: [
        {
          subpath: "./test",
          reason:
            "Management schemas and wire overrides require the explicit sharness-test resolution condition",
        },
      ],
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

/** Product architecture configurations exclude the test infrastructure in `tests/integration`. */
const architectureConfigDefinitions: ReadonlyArray<{
  readonly packageRoot: string;
  readonly definition: PackageDefinition;
}> = [
  ...Object.entries(packageDefinitions).map(([packageName, definition]) => ({
    packageRoot: `packages/${packageName}`,
    definition,
  })),
  {
    packageRoot: "packages/registry",
    definition: {
      config: {
        packageRuntime: "node",
        publicTypePackages: [
          publicTypePackage.effect,
          publicTypePackage.platform,
          publicTypePackage.platformNode,
        ],
        allowedTestPublicSubpaths: [
          {
            subpath: "./test",
            reason:
              "Registry wire overrides require the explicit sharness-test resolution condition",
          },
        ],
        folderReadmeFileNames: ["README.md", "MODULE.md"],
        facadeFiles: [
          {
            file: "test.ts",
            reason:
              "Condition-only Registry process composition for compatibility tests",
          },
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
        allowedTestPublicSubpaths: [
          {
            subpath: "./test",
            reason:
              "Router wire overrides require the explicit sharness-test resolution condition",
          },
        ],
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
  const configured = new Set(
    architectureConfigDefinitions.map(({ packageRoot }) => packageRoot),
  );
  if (
    configured.size !== FINAL_PACKAGE_DIRS.length ||
    FINAL_PACKAGE_DIRS.some((dir) => !configured.has(`packages/${dir}`))
  ) {
    process.stderr.write(
      "Architecture configurations must cover FINAL_PACKAGES exactly\n",
    );
    process.exit(1);
  }

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
