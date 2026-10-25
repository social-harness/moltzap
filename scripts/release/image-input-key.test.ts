#!/usr/bin/env node
/** @file Image key contracts run in process against committed temporary workspaces. */
import { Effect, Either } from "effect";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
// eslint-disable-next-line agent-code-guard/prefer-effect-platform -- Synchronous Git fixtures exercise the in-process release API.
import {
  chmodSync,
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  ImageInputError,
  imageInputs,
  runtimeVersionReads,
} from "./image-input-key.ts";

// @agent-code-guard/regression-only: Git fixtures pin image rebuild and refusal behavior through the release API.

const command = path.join(import.meta.dirname, "image-input-key.ts");
const lock = `lockfileVersion: '9.0'
importers:
  packages/router:
    dependencies:
      '@fixture/core':
        version: link:../client
      plain:
        version: 0.97.0(effect@3.22.1)
      alias:
        version: external@1.0.0(peer@2.0.0)
    devDependencies:
      unused:
        version: 1.0.0
  packages/registry:
    dependencies:
      '@fixture/core':
        version: link:../client
  packages/client:
    optionalDependencies:
      leaf:
        version: 1.0.0
packages:
  plain@0.97.0:
    resolution: {integrity: sha512-plain}
  effect@3.22.1:
    resolution: {integrity: sha512-effect}
  unused@1.0.0:
    resolution: {integrity: sha512-unused}
  dev-leaf@1.0.0:
    resolution: {integrity: sha512-dev-leaf}
  external@1.0.0:
    resolution: {integrity: sha512-external}
  leaf@1.0.0:
    resolution: {integrity: sha512-leaf}
  peer@2.0.0:
    resolution: {integrity: sha512-peer}
snapshots:
  plain@0.97.0(effect@3.22.1):
    dependencies:
      effect: 3.22.1
  effect@3.22.1: {}
  unused@1.0.0:
    dependencies:
      dev-leaf: 1.0.0
  dev-leaf@1.0.0: {}
  external@1.0.0(peer@2.0.0):
    dependencies:
      peer: 2.0.0
  peer@2.0.0: {}
  leaf@1.0.0: {}
`;

const dockerfile = `FROM node:24 AS build
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/router/ packages/router/
COPY packages/client/src/index.ts packages/client/src/index.ts
COPY packages/client/src/internal.ts packages/client/src/internal.ts
COPY scripts/build/ scripts/build/
RUN node scripts/build/image.ts
FROM node:24
COPY --from=build /app/dist /app
COPY images/router/base-digest /base-digest
`;

/** Every fixture has both service names and a differently named library with condition-only exports. */
function fixture(): string {
  const repo = mkdtempSync(path.join(tmpdir(), "image-inputs-"));
  const files = fixtureFiles();
  for (const service of ["router", "registry"]) {
    files[`packages/${service}/package.json`] = JSON.stringify({
      name: `@fixture/${service}`,
      version: "1",
      dependencies: { "@fixture/core": "workspace:*" },
    });
    files[`packages/${service}/src/index.test.ts`] =
      'import "@fixture/core/test";\n';
    files[`packages/${service}/src/index.ts`] =
      'import "@fixture/core";\nimport "@fixture/core/internal";\n';
  }
  for (const [file, text] of Object.entries(files)) {
    write(repo, file, text);
  }
  git(repo, ["init", "--quiet"]);
  commit(repo);
  return repo;
}

function write(repo: string, file: string, text: string): void {
  mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  writeFileSync(path.join(repo, file), text);
}

function commit(repo: string): void {
  git(repo, ["add", "."]);
  git(repo, [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "-m",
    "Record fixture",
  ]);
}

function git(repo: string, args: readonly string[]): void {
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- Fixtures exercise the installed Git's committed file semantics.
  const result = spawnSync("git", ["-c", "core.autocrlf=false", ...args], {
    cwd: repo,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
}

function key(repo: string): string {
  return Effect.runSync(imageInputs(repo)).router?.key ?? "";
}

/** Regular-file output also works where the sandbox denies subprocess pipe polling. */
function run(repo: string) {
  const out = path.join(repo, ".git", "key.stdout");
  const err = path.join(repo, ".git", "key.stderr");
  const stdout = openSync(out, "w");
  const stderr = openSync(err, "w");
  const result = spawnSync(process.execPath, [command], {
    cwd: repo,
    stdio: ["ignore", stdout, stderr],
    timeout: 30_000,
  });
  closeSync(stdout);
  closeSync(stderr);
  assert.ifError(result.error);
  return {
    status: result.status,
    stdout: readFileSync(out, "utf8"),
    stderr: readFileSync(err, "utf8"),
  };
}

const changes = [
  [
    "test-only sibling module",
    "packages/client/src/test.ts",
    "export const testOnly = 2;",
    false,
    false,
  ],
  [
    "root pnpm installation policy",
    "package.json",
    JSON.stringify({
      packageManager: "pnpm@10.6.2",
      pnpm: { onlyBuiltDependencies: ["native"] },
      scripts: { prepare: "node scripts/setup/install.ts" },
    }),
    true,
    true,
  ],
  ["npm configuration", ".npmrc", "strict-peer-dependencies=true", true, true],
  ["Docker ignore rules", ".dockerignore", "node_modules\n.tmp", true, true],
  ["Nx configuration", "nx.json", '{"parallel":2}', true, true],
  [
    "base TypeScript config",
    "tsconfig.base.json",
    '{"extends":"./config/base.json","compilerOptions":{}}',
    true,
    true,
  ],
  [
    "inherited TypeScript config",
    "config/base.json",
    '{"compilerOptions":{"strict":true}}',
    true,
    true,
  ],
  [
    "sibling TypeScript config",
    "packages/client/tsconfig.json",
    '{"extends":"../../tsconfig.base.json","compilerOptions":{"rootDir":"src","outDir":"dist","strict":true}}',
    true,
    true,
  ],
  ["Node toolchain", ".node-version", "24.19.0", true, true],
  [
    "build command file outside scripts/build",
    "tools/image-task.ts",
    "export const changed = true;",
    true,
    true,
  ],
  [
    "install lifecycle executable",
    "scripts/setup/install.ts",
    "export const changed = true;",
    true,
    true,
  ],
  [
    "daemon-only source",
    "packages/client/src/daemon/run.ts",
    "export const daemon = 2;",
    false,
    false,
  ],
  [
    "Router source",
    "packages/router/src/index.ts",
    'import "@fixture/core/internal"; export const router = 2;',
    true,
    false,
  ],
  [
    "Dockerfile",
    "images/router/Dockerfile",
    `${dockerfile}\nENV NEW=1\n`,
    true,
    false,
  ],
  ["base-image pin", "images/router/base-digest", "sha256:other", true, false],
  [
    "runtime external bump",
    "pnpm-lock.yaml",
    lock
      .replaceAll("  leaf@1.0.0:", "  leaf@1.0.1:")
      .replace("version: 1.0.0\npackages:", "version: 1.0.1\npackages:"),
    true,
    true,
  ],
  [
    "transitive runtime integrity",
    "pnpm-lock.yaml",
    lock.replace("sha512-peer", "sha512-new"),
    true,
    false,
  ],
  [
    "condition-only internal module",
    "packages/client/src/private.ts",
    "export const privateValue = 2;",
    true,
    true,
  ],
  [
    "default-condition module",
    "packages/client/src/index.ts",
    "export const publicValue = 2;",
    true,
    true,
  ],
  [
    "version-only manifest",
    "packages/router/package.json",
    JSON.stringify({
      name: "@fixture/router",
      version: "2",
      dependencies: { "@fixture/core": "workspace:*" },
    }),
    false,
    false,
  ],
  [
    "sibling version-only manifest",
    "packages/client/package.json",
    "",
    false,
    false,
  ],
  [
    "unrelated dev dependency",
    "pnpm-lock.yaml",
    lock
      .replaceAll("unused@1.0.0", "unused@2.0.0")
      .replaceAll("dev-leaf@1.0.0", "dev-leaf@2.0.0")
      .replaceAll(
        "version: 1.0.0\n  packages/registry",
        "version: 2.0.0\n  packages/registry",
      )
      .replace("dev-leaf: 1.0.0", "dev-leaf: 2.0.0"),
    false,
    false,
  ],
  [
    "build script",
    "scripts/build/image.ts",
    "export const build = 2;",
    true,
    true,
  ],
  [
    "pnpm release",
    "package.json",
    JSON.stringify({
      packageManager: "pnpm@10.6.3",
      pnpm: { onlyBuiltDependencies: [] },
      scripts: { prepare: "node scripts/setup/install.ts" },
    }),
    true,
    true,
  ],
] as const;

for (const [label, file, content, changesKey, registryChanges] of changes) {
  await test(`Router key ${changesKey ? "changes" : "stays equal"} for ${label}`, (t) => {
    const repo = fixture();
    t.after(() => {
      rmSync(repo, { recursive: true, force: true });
    });
    const beforeRegistry = Effect.runSync(imageInputs(repo)).registry?.key;
    const before = key(repo);
    const text =
      content ||
      readFileSync(path.join(repo, file), "utf8").replace(
        '"version":"1"',
        '"version":"2"',
      );
    write(repo, file, text);
    commit(repo);
    assert.equal(
      Effect.runSync(imageInputs(repo)).registry?.key === beforeRegistry,
      !registryChanges,
      `Registry key for ${label}`,
    );
    if (changesKey) {
      assert.notEqual(key(repo), before);
    } else {
      assert.equal(key(repo), before);
    }
  });
}

await test("uncommitted edits do not change a key, while committed executable mode does", (t) => {
  const repo = fixture();
  t.after(() => {
    rmSync(repo, { recursive: true, force: true });
  });
  const before = key(repo);
  write(repo, "packages/router/src/index.ts", "uncommitted");
  assert.equal(key(repo), before);
  git(repo, ["restore", "packages/router/src/index.ts"]);
  chmodSync(path.join(repo, "scripts/build/image.ts"), 0o755);
  commit(repo);
  assert.notEqual(key(repo), before);
});

await test("refuses an export whose source is absent", (t) => {
  const repo = fixture();
  t.after(() => {
    rmSync(repo, { recursive: true, force: true });
  });
  write(
    repo,
    "packages/client/package.json",
    JSON.stringify({
      name: "@fixture/core",
      exports: { ".": "./dist/absent.js" },
    }),
  );
  commit(repo);
  const result = run(repo);
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.match(
    result.stderr,
    /Missing workspace export target packages\/client\/dist\/absent.js/u,
  );
});

for (const [label, content, message] of [
  [
    "unknown lockfile version",
    lock.replace("9.0", "10.0"),
    /Unsupported pnpm-lock.yaml version/u,
  ],
  [
    "missing importer",
    lock.replace("packages/client:", "packages/absent:"),
    /no importer packages\/client/u,
  ],
  [
    "missing snapshot",
    lock.replace("  leaf@1.0.0: {}", "  absent@1.0.0: {}"),
    /no snapshot leaf@1.0.0/u,
  ],
  [
    "missing resolution",
    lock.replace(
      "  leaf@1.0.0:\n    resolution: {integrity: sha512-leaf}\n",
      "",
    ),
    /no package leaf@1.0.0/u,
  ],
] as const) {
  await test(`refuses ${label}`, (t) => {
    const repo = fixture();
    t.after(() => {
      rmSync(repo, { recursive: true, force: true });
    });
    write(repo, "pnpm-lock.yaml", content);
    commit(repo);
    const result = Effect.runSync(Effect.either(imageInputs(repo)));
    Either.match(result, {
      onLeft: (error) => {
        assert.match(error.message, message);
      },
      onRight: () => {
        assert.fail("Expected refusal");
      },
    });
  });
}

await test("CLI prints two successful image keys", (t) => {
  const repo = fixture();
  t.after(() => {
    rmSync(repo, { recursive: true, force: true });
  });
  const result = run(repo);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"registry":"sha256:[0-9a-f]{64}"/u);
  assert.match(result.stdout, /"router":"sha256:[0-9a-f]{64}"/u);
});

await test("checkout produces two well-formed keys in process", () => {
  const keys = Effect.runSync(
    imageInputs(path.resolve(import.meta.dirname, "../..")),
  );
  assert.equal(Object.keys(keys).length, 2);
  for (const input of Object.values(keys)) {
    assert.match(input.key, /^sha256:[0-9a-f]{64}$/u);
  }
});

await test("release-shaped metadata edits in own and sibling manifests preserve both keys", (t) => {
  const repo = fixture();
  t.after(() => {
    rmSync(repo, { recursive: true, force: true });
  });
  const before = Effect.runSync(imageInputs(repo));
  for (const service of ["router", "registry", "client"]) {
    const file = `packages/${service}/package.json`;
    const manifest: unknown = JSON.parse(
      readFileSync(path.join(repo, file), "utf8"),
    );
    assert.ok(typeof manifest === "object" && manifest !== null);
    write(
      repo,
      file,
      JSON.stringify({
        ...manifest,
        version: "2",
        sharnessContentHash: "sha256:new",
        sharnessHostCodeHash: "sha256:new",
        sharnessWireVersion: "new",
      }),
    );
  }
  commit(repo);
  assert.deepEqual(Effect.runSync(imageInputs(repo)), before);
});

await test("sibling manifest non-version fields bind both images", (t) => {
  const repo = fixture();
  t.after(() => {
    rmSync(repo, { recursive: true, force: true });
  });
  const before = Effect.runSync(imageInputs(repo));
  const file = "packages/client/package.json";
  write(
    repo,
    file,
    readFileSync(path.join(repo, file), "utf8").replace(
      '"version":"1"',
      '"version":"1","type":"module"',
    ),
  );
  commit(repo);
  const after = Effect.runSync(imageInputs(repo));
  assert.notEqual(after.router?.key, before.router?.key);
  assert.notEqual(after.registry?.key, before.registry?.key);
});

await test("runtime version gate names only reached modules consuming manifest versions", (t) => {
  const repo = fixture();
  t.after(() => {
    rmSync(repo, { recursive: true, force: true });
  });
  write(
    repo,
    "packages/router/src/version.ts",
    'import manifest from "../package.json" with { type: "json" }; console.log(manifest.version);',
  );
  write(
    repo,
    "packages/registry/src/version.ts",
    'import { version as release } from "../package.json"; console.log(release);',
  );
  write(
    repo,
    "packages/client/src/daemon/run.ts",
    'import manifest from "../../package.json"; console.log(manifest.version);',
  );
  write(
    repo,
    "packages/router/src/reexport.ts",
    'export { version as release } from "../package.json";',
  );
  write(
    repo,
    "packages/client/src/index.ts",
    'import manifest from "../package.json"; console.log(manifest.version);',
  );
  commit(repo);
  assert.deepEqual(Effect.runSync(runtimeVersionReads(repo)), [
    "packages/client/src/index.ts",
    "packages/registry/src/version.ts",
    "packages/router/src/reexport.ts",
    "packages/router/src/version.ts",
  ]);
  assert.match(key(repo), /^sha256:/u);
});

for (const [label, instruction] of [
  ["shell COPY", "COPY assets/ /assets"],
  ["JSON ADD", 'ADD ["assets/", "/config"]'],
  ["CRLF continuation", "COPY \\\r\n assets/ /assets"],
  ["spaced continuation", "COPY \\ \t\n assets/ /assets"],
  ["comment continuation", "COPY \\\n\n # ignored\n assets/ /assets"],
  ["heredoc RUN", "RUN <<EOF\nnode tools/heredoc-task.ts\nEOF"],
  ["entrypoint", 'ENTRYPOINT ["node", "assets/config"]'],
] as const) {
  await test(`${label} context inputs change the key`, (t) => {
    const repo = fixture();
    t.after(() => {
      rmSync(repo, { recursive: true, force: true });
    });
    write(repo, "images/router/Dockerfile", `${dockerfile}\n${instruction}\n`);
    commit(repo);
    const before = key(repo);
    write(
      repo,
      label === "heredoc RUN" ? "tools/heredoc-task.ts" : "assets/config",
      "changed",
    );
    commit(repo);
    assert.notEqual(key(repo), before);
  });
}

await test("refuses symlink image inputs", (t) => {
  const repo = fixture();
  t.after(() => {
    rmSync(repo, { recursive: true, force: true });
  });
  symlinkSync(
    "../../../../outside.ts",
    path.join(repo, "packages/router/src/link.ts"),
  );
  commit(repo);
  const result = Effect.runSync(Effect.either(imageInputs(repo)));
  Either.match(result, {
    onLeft: (error) => {
      assert.match(error.message, /symlink image input/u);
    },
    onRight: () => {
      assert.fail("Expected refusal");
    },
  });
});

function fixtureFiles(): Record<string, string> {
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

for (const [label, manifest, source, mutation] of [
  [
    "constant dynamic import",
    { exports: { "./internal": { "sharness-internal": "./dist/private.js" } } },
    "await import(`@fixture/core/internal`);",
    "packages/client/src/private.ts",
  ],
  [
    "active require conditional target",
    { exports: { ".": { require: "./dist/only-require.js" } } },
    'require("@fixture/core");',
    "packages/client/src/only-require.ts",
  ],
  [
    "active node conditional target",
    {
      exports: {
        ".": {
          node: "./dist/only-node.js",
          "module-sync": "./dist/only-sync.js",
          default: "./dist/only-default.js",
        },
      },
    },
    'import "@fixture/core";',
    "packages/client/src/only-node.ts",
  ],
  [
    "active module-sync conditional target",
    {
      exports: {
        ".": {
          node: "./dist/only-node.js",
          "module-sync": "./dist/only-sync.js",
          default: "./dist/only-default.js",
        },
      },
    },
    'import "@fixture/core";',
    "packages/client/src/only-sync.ts",
  ],
  [
    "active default conditional target",
    {
      exports: {
        ".": {
          node: "./dist/only-node.js",
          "module-sync": "./dist/only-sync.js",
          default: "./dist/only-default.js",
        },
      },
    },
    'import "@fixture/core";',
    "packages/client/src/only-default.ts",
  ],
  [
    "legacy main",
    { main: "./dist/private.js" },
    'import "@fixture/core";',
    "packages/client/src/private.ts",
  ],
  [
    "wildcard subpaths",
    { exports: { "./*": "./dist/*.js" } },
    'import "@fixture/core/private";',
    "packages/client/src/private.ts",
  ],
  [
    "package imports aliases",
    {
      exports: { ".": "./dist/index.js" },
      imports: { "#private": "./dist/private.js" },
    },
    'import "@fixture/core";',
    "packages/client/src/private.ts",
  ],
] as const) {
  await test(`${label} reach their runtime modules`, (t) => {
    const repo = fixture();
    t.after(() => {
      rmSync(repo, { recursive: true, force: true });
    });
    const file = "packages/client/package.json";
    const original: unknown = JSON.parse(
      readFileSync(path.join(repo, file), "utf8"),
    );
    assert.ok(typeof original === "object" && original !== null);
    write(
      repo,
      file,
      JSON.stringify({ ...original, exports: undefined, ...manifest }),
    );
    for (const service of ["router", "registry"]) {
      write(repo, `packages/${service}/src/index.ts`, source);
      write(repo, `packages/${service}/src/index.test.ts`, "export {};");
    }
    write(repo, "packages/client/src/internal.ts", "export {};");
    write(repo, "packages/client/src/index.ts", 'import "#private";');
    if (label !== "package imports aliases") {
      write(repo, "packages/client/src/index.ts", "export {};");
    }
    commit(repo);
    const before = key(repo);
    write(repo, mutation, "export const changed = true;");
    commit(repo);
    assert.notEqual(key(repo), before);
  });
}

for (const [label, content, message] of [
  [
    "file directory dependency",
    lock.replace(
      "version: external@1.0.0(peer@2.0.0)",
      "version: file:../../vendor",
    ),
    /Directory dependency/u,
  ],
  [
    "directory resolution",
    lock.replace(
      "resolution: {integrity: sha512-leaf}",
      "resolution: {type: directory, directory: vendor}",
    ),
    /Directory dependency/u,
  ],
] as const) {
  await test(`refuses ${label} in process`, (t) => {
    const repo = fixture();
    t.after(() => {
      rmSync(repo, { recursive: true, force: true });
    });
    write(repo, "pnpm-lock.yaml", content);
    commit(repo);
    Either.match(Effect.runSync(Effect.either(imageInputs(repo))), {
      onLeft: (error) => {
        assert.match(error.message, message);
      },
      onRight: () => {
        assert.fail("Expected refusal");
      },
    });
  });
}

await test("missing workspace subpaths and malformed manifests retain file-specific typed errors", (t) => {
  const repo = fixture();
  t.after(() => {
    rmSync(repo, { recursive: true, force: true });
  });
  write(
    repo,
    "packages/router/src/index.ts",
    'import "@fixture/core/missing";',
  );
  commit(repo);
  Either.match(Effect.runSync(Effect.either(imageInputs(repo))), {
    onLeft: (error) => {
      assert.match(
        error.message,
        /^Missing workspace export target packages\/client\/package.json \(@fixture\/core\/missing\)$/u,
      );
    },
    onRight: () => {
      assert.fail("Expected refusal");
    },
  });
  write(repo, "packages/router/package.json", "{broken");
  commit(repo);
  Either.match(Effect.runSync(Effect.either(imageInputs(repo))), {
    onLeft: (error) => {
      assert.match(
        error.message,
        /Invalid JSON in packages\/router\/package.json/u,
      );
      assert.ok(error.cause instanceof SyntaxError);
    },
    onRight: () => {
      assert.fail("Expected refusal");
    },
  });
});

await test("pnpm options and optional run still identify nested build executables", (t) => {
  const repo = fixture();
  t.after(() => {
    rmSync(repo, { recursive: true, force: true });
  });
  write(repo, "scripts/custom/task.ts", "export {};");
  write(
    repo,
    "package.json",
    JSON.stringify({
      packageManager: "pnpm@10.6.2",
      scripts: { custom: "node scripts/custom/task.ts" },
    }),
  );
  write(
    repo,
    "images/router/Dockerfile",
    `${dockerfile}\nRUN pnpm -w --silent --filter router -C . --workspace-root run --silent custom\n`,
  );
  commit(repo);
  const before = key(repo);
  write(repo, "scripts/custom/task.ts", "export const changed = true;");
  commit(repo);
  assert.notEqual(key(repo), before);
});

await test("in-tree symlink target content is keyed even outside the package", (t) => {
  const repo = fixture();
  t.after(() => {
    rmSync(repo, { recursive: true, force: true });
  });
  write(repo, "assets/linked", "initial");
  symlinkSync(
    "../../../assets/linked",
    path.join(repo, "packages/router/src/link"),
  );
  commit(repo);
  const before = key(repo);
  write(repo, "assets/linked", "changed");
  commit(repo);
  assert.notEqual(key(repo), before);
});

for (const route of ["relative import", "symlink module"] as const) {
  await test(`${route} outside the service keys transitive modules and version reads`, (t) => {
    const repo = fixture();
    t.after(() => {
      rmSync(repo, { recursive: true, force: true });
    });
    write(repo, "packages/shared/entry.ts", 'import "./leaf.js";');
    write(
      repo,
      "packages/shared/leaf.ts",
      "console.log(process.env.npm_package_version);",
    );
    if (route === "relative import") {
      write(
        repo,
        "packages/router/src/index.ts",
        'import "../../shared/entry.js";',
      );
    } else {
      symlinkSync(
        "../../shared/entry.ts",
        path.join(repo, "packages/router/src/link.ts"),
      );
    }
    commit(repo);
    const before = key(repo);
    assert.deepEqual(Effect.runSync(runtimeVersionReads(repo)), [
      "packages/shared/leaf.ts",
    ]);
    write(repo, "packages/shared/leaf.ts", "export const changed = true;");
    commit(repo);
    assert.notEqual(key(repo), before);
  });
}

for (const [label, header, bin] of [
  ["manifest bin", "", { tool: "bin/tool" }],
  ["Node shebang", "#!/usr/bin/env node\n", undefined],
] as const) {
  await test(`${label} without an extension traverses imports and consumes versions`, (t) => {
    const repo = fixture();
    t.after(() => {
      rmSync(repo, { recursive: true, force: true });
    });
    write(
      repo,
      "packages/router/package.json",
      JSON.stringify({ name: "@fixture/router", bin }),
    );
    write(
      repo,
      "packages/router/bin/tool",
      `${header}import "@fixture/core/service"; console.log(process.env.npm_package_version);`,
    );
    commit(repo);
    const before = key(repo);
    assert.deepEqual(Effect.runSync(runtimeVersionReads(repo)), [
      "packages/router/bin/tool",
    ]);
    write(
      repo,
      "packages/client/src/daemon/run.ts",
      "export const changed = true;",
    );
    commit(repo);
    assert.notEqual(key(repo), before);
  });
}

for (const [label, expression] of [
  ["fs string path", 'readFileSync("../package.json", "utf8")'],
  ["fs URL path", 'fs.readFile(new URL("../package.json", import.meta.url))'],
  ["npm version environment", "process.env.npm_package_version"],
  [
    "spaced npm version environment",
    "process.env /* version */ .npm_package_version",
  ],
] as const) {
  await test(`runtime version gate detects ${label}`, (t) => {
    const repo = fixture();
    t.after(() => {
      rmSync(repo, { recursive: true, force: true });
    });
    write(
      repo,
      "packages/router/src/version.ts",
      `console.log(${expression});`,
    );
    commit(repo);
    assert.deepEqual(Effect.runSync(runtimeVersionReads(repo)), [
      "packages/router/src/version.ts",
    ]);
  });
}

for (const [label, instruction, message] of [
  [
    "non-default Docker escape",
    "# escape=`\nCOPY assets/ /assets",
    /escape directive.*images\/router\/Dockerfile/u,
  ],
  [
    "default-source bind mount",
    "RUN --mount=type=bind,target=/context cat /context/assets/config",
    /bind mount.*images\/router\/Dockerfile/u,
  ],
  [
    "explicit-source bind mount",
    "RUN --mount=type=bind,source=assets,target=/context cat /context/config",
    /bind mount.*images\/router\/Dockerfile/u,
  ],
  [
    "malformed JSON ADD",
    'ADD ["assets/",]',
    /Invalid JSON in images\/router\/Dockerfile/u,
  ],
  [
    "missing context source",
    "COPY missing/ /assets",
    /missing.*images\/router\/Dockerfile/u,
  ],
] as const) {
  await test(`refuses ${label} with a file-specific typed error`, (t) => {
    const repo = fixture();
    t.after(() => {
      rmSync(repo, { recursive: true, force: true });
    });
    write(repo, "images/router/Dockerfile", `${instruction}\n${dockerfile}`);
    commit(repo);
    const result = Effect.runSync(Effect.either(imageInputs(repo)));
    Either.match(result, {
      onLeft: (error) => {
        assert.ok(error instanceof ImageInputError);
        assert.match(error.message, message);
      },
      onRight: () => {
        assert.fail("Expected refusal");
      },
    });
  });
}

for (const [label, file, content, message] of [
  [
    "a reached workspace importer outside accounted package roots",
    "pnpm-lock.yaml",
    lock
      .replaceAll("link:../client", "link:../../tests/library")
      .replace("packages/client:", "tests/library:"),
    /tests\/library\/package.json/u,
  ],
  [
    "an aliased workspace link that module resolution cannot account for",
    "pnpm-lock.yaml",
    lock.replaceAll("'@fixture/core':", "'@fixture/alias':"),
    /@fixture\/alias.*packages\/client\/package.json/u,
  ],
  [
    "a missing reached relative module with its repository path",
    "packages/router/src/index.ts",
    'import "../../shared/missing.js";',
    /packages\/shared\/missing.js/u,
  ],
] as const) {
  await test(`refuses ${label}`, (t) => {
    const repo = fixture();
    t.after(() => {
      rmSync(repo, { recursive: true, force: true });
    });
    write(repo, file, content);
    commit(repo);
    Either.match(Effect.runSync(Effect.either(imageInputs(repo))), {
      onLeft: (error) => {
        assert.ok(error instanceof ImageInputError);
        assert.match(error.message, message);
      },
      onRight: () => {
        assert.fail("Expected refusal");
      },
    });
  });
}
