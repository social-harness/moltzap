/** @file File inventory for the committed image-key workspaces. */
/** Committed build, runtime, and unreachable inputs for the image-key contracts. */
export function fixtureFiles(
  lock: string,
  dockerfile: string,
): Record<string, string> {
  return {
    "package.json": JSON.stringify({
      packageManager: "pnpm@10.6.2",
      pnpm: { onlyBuiltDependencies: [] },
      scripts: { prepare: "node scripts/setup/install.ts" },
    }),
    ".npmrc": "strict-peer-dependencies=false\n",
    ".dockerignore": "node_modules\n",
    ".node-version": "24.18.0\n",
    "nx.json": "{}",
    "tsconfig.base.json": JSON.stringify({ extends: "./config/base.json" }),
    "config/base.json": "{}",
    "scripts/setup/install.ts": "export {};",
    "tools/image-task.ts": "export {};",
    "tools/heredoc-task.ts": "export {};",
    "assets/config": "initial",
    "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
    "pnpm-lock.yaml": lock,
    "scripts/build/image.ts": "export {};\n",
    "images/router/Dockerfile": dockerfile,
    "images/router/base-digest": "sha256:base\n",
    "packages/client/package.json": clientManifest(),
    "packages/client/tsconfig.json": JSON.stringify({
      extends: "../../tsconfig.base.json",
      compilerOptions: { rootDir: "src", outDir: "dist" },
    }),
    "packages/client/src/index.ts": "export const publicValue = 1;\n",
    "packages/client/src/internal.ts":
      'export { privateValue } from "./private.js";\n',
    "packages/client/src/private.ts": "export const privateValue = 1;\n",
    "packages/client/src/only-require.ts": "export {};",
    "packages/client/src/only-node.ts": "export {};",
    "packages/client/src/only-sync.ts": "export {};",
    "packages/client/src/only-default.ts": "export {};",
    "packages/client/src/test.ts": "export const testOnly = 1;\n",
    "packages/client/src/daemon/run.ts": "export const daemon = 1;\n",
  };
}

function clientManifest(): string {
  return JSON.stringify({
    name: "@fixture/core",
    version: "1",
    scripts: { lint: "node src/daemon/run.ts" },
    nx: {
      targets: {
        build: { options: { cwd: ".", command: "node tools/image-task.ts" } },
      },
    },
    exports: {
      ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
      "./service": { import: "./dist/daemon/run.js" },
      "./test": { "sharness-test": { import: "./dist/test.js" } },
      "./internal": {
        "sharness-internal": {
          types: "./dist/internal.d.ts",
          import: "./dist/internal.js",
        },
      },
    },
  });
}
