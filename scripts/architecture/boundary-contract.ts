/**
 * @file The final-package contract the architecture boundary check enforces.
 *
 * The table pins the directory and package names, public entrypoints,
 * binaries, manifest edges, TypeScript references, and required Nx targets
 * for all workspace products. It is a hand transcription of the current package
 * contract, written down rather than derived so drift fails whichever side
 * moves, but it is not self-certifying: re-verify it against
 * docs/spec/layer-interfaces.md whenever that contract changes.
 */

/** Directory name of one final product under `packages/`. */
export type PackageDir =
  | "client"
  | "identity"
  | "nanoclaw-channel"
  | "openclaw-channel"
  | "router"
  | "registry";

/** The `types` and `import` conditions one public subpath resolves to. */
export interface ExportTarget {
  readonly testOnly?: true;
  readonly internalOnly?: true;
  readonly types: string;
  readonly import: string;
}

/** What one final product must declare. */
interface PackageContract {
  readonly npmName: string;
  /** Published packages release from `publish.yml`; the rest stay private. */
  readonly published: boolean;
  /**
   * The only product packages this one may reach in manifests, TypeScript
   * project references, Knip ignores, source imports, and the resolved Nx
   * graph.
   */
  readonly deps: readonly PackageDir[];
  readonly exports: Readonly<Record<string, ExportTarget>>;
  readonly bin: Readonly<Record<string, string>>;
  /**
   * A minimum floor: additional operator targets are allowed, but deleting a
   * required verification or product entry target fails.
   */
  readonly targets: readonly string[];
}

/** The repository every published manifest links npm provenance to. */
export const REPOSITORY_URL =
  "git+https://github.com/social-harness/moltzap.git";

/** The `YYYY.MDD.N` calendar version shape of package releases. */
export const CALENDAR_VERSION = /^\d{4}\.\d{3,4}\.\d+$/;

const ROOT_EXPORT: ExportTarget = {
  types: "./dist/index.d.ts",
  import: "./dist/index.js",
};

const SERVICE_TARGETS = [
  "arch:check",
  "build",
  "lint",
  "test",
  "test:integration",
  "typecheck",
  "typecheck:tests",
];

/** The contract of every final product, keyed by its directory. */
export const FINAL_PACKAGES: Readonly<Record<PackageDir, PackageContract>> = {
  identity: {
    npmName: "@moltzap/identity",
    published: true,
    deps: [],
    exports: {
      ".": ROOT_EXPORT,
      "./registry": {
        types: "./dist/registry.d.ts",
        import: "./dist/registry.js",
      },
      "./internal": {
        internalOnly: true,
        types: "./dist/internal/index.d.ts",
        import: "./dist/internal/index.js",
      },
      "./test": {
        testOnly: true,
        types: "./dist/internal/test.d.ts",
        import: "./dist/internal/test.js",
      },
    },
    bin: {},
    targets: SERVICE_TARGETS.filter((target) => target !== "test:integration"),
  },
  registry: {
    npmName: "@moltzap/registry",
    published: false,
    deps: ["identity"],
    exports: {
      ".": ROOT_EXPORT,
      "./test": {
        testOnly: true,
        types: "./dist/test.d.ts",
        import: "./dist/test.js",
      },
    },
    bin: { "sharness-registry": "./bin/sharness-registry" },
    targets: SERVICE_TARGETS,
  },
  router: {
    npmName: "@moltzap/router",
    published: true,
    deps: ["identity"],
    exports: {
      ".": ROOT_EXPORT,
      "./server": {
        types: "./dist/server.d.ts",
        import: "./dist/server.js",
      },
    },
    bin: { "sharness-router": "./bin/sharness-router" },
    targets: SERVICE_TARGETS,
  },
  client: {
    npmName: "@moltzap/client",
    published: true,
    deps: ["identity", "router"],
    exports: {
      ".": ROOT_EXPORT,
      "./test": {
        testOnly: true,
        types: "./dist/test.d.ts",
        import: "./dist/test.js",
      },
      "./service": {
        types: "./dist/daemon/index.d.ts",
        import: "./dist/daemon/index.js",
      },
    },
    bin: {
      sharnessd: "./bin/sharnessd",
      "sharnessd-launcher": "./bin/sharnessd-launcher",
    },
    targets: [
      "arch:check",
      "build",
      "lint",
      "test",
      "test:integration",
      "test:pack",
      "typecheck:tests",
    ],
  },
  "openclaw-channel": {
    npmName: "@moltzap/openclaw-channel",
    published: true,
    deps: ["client"],
    exports: { ".": ROOT_EXPORT },
    bin: {},
    targets: [
      "arch:check",
      "build",
      "lint",
      "test",
      "test:pack",
      "typecheck:tests",
    ],
  },
  "nanoclaw-channel": {
    npmName: "@moltzap/nanoclaw-channel",
    published: false,
    deps: ["client"],
    exports: {
      ".": {
        types: "./dist/channels/sharness.d.ts",
        import: "./dist/channels/sharness.js",
      },
    },
    bin: {},
    targets: ["arch:check", "build", "lint", "test:pack", "typecheck:tests"],
  },
};

/** Every product directory, in the order the checks report them. */
export const FINAL_PACKAGE_DIRS: readonly PackageDir[] = [
  "identity",
  "registry",
  "router",
  "client",
  "openclaw-channel",
  "nanoclaw-channel",
];

/** Every product's npm name. */
export const FINAL_PACKAGE_NAMES: ReadonlySet<string> = new Set(
  FINAL_PACKAGE_DIRS.map((dir) => FINAL_PACKAGES[dir].npmName),
);

/**
 * The npm names a product may depend on.
 * @param dir Product directory.
 * @returns The npm names of its declared dependencies, in contract order.
 */
export function dependencyNames(dir: PackageDir): readonly string[] {
  return FINAL_PACKAGES[dir].deps.map(
    (dependency) => FINAL_PACKAGES[dependency].npmName,
  );
}

/** Test infrastructure stays outside the product dependency graph and release set. */
export const INTEGRATION_TESTS = {
  name: "@moltzap/integration-tests",
  root: "tests/integration",
  targets: [
    "test:integration",
    "test:mixed-release",
    "typecheck:tests",
    "lint",
  ],
  dependencies: [
    "identity",
    "registry",
    "router",
    "client",
    "openclaw-channel",
  ],
} as const;

/** Contract-only visibility metadata becomes the exact manifest condition object. */
export function manifestExportTarget({
  testOnly,
  internalOnly,
  ...target
}: ExportTarget): Readonly<Record<string, unknown>> {
  const condition = exportCondition({ testOnly, internalOnly, ...target });
  return condition === undefined ? target : { [condition]: target };
}

/** The internal module condition is shared by manifests and image resolution. */
export const INTERNAL_EXPORT_CONDITION = "sharness-internal";

/** Visibility metadata selects a named condition independently of object key order. */
export function exportCondition(
  target: ExportTarget,
): "sharness-internal" | "sharness-test" | undefined {
  if (target.internalOnly === true) {
    return INTERNAL_EXPORT_CONDITION;
  }
  return target.testOnly === true ? "sharness-test" : undefined;
}
