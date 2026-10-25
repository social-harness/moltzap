#!/usr/bin/env node
/** @file Image key contract tests run the command against committed temporary workspaces. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

// @agent-code-guard/regression-only: Git fixtures pin image rebuild and refusal behavior through command output.

const command = path.join(import.meta.dirname, "image-input-key.ts");
const lock = `lockfileVersion: '9.0'
importers:
  packages/router:
    dependencies:
      '@fixture/core':
        version: link:../client
      alias:
        version: npm:external@1.0.0(peer@2.0.0)
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
  external@1.0.0:
    resolution: {integrity: sha512-external}
  leaf@1.0.0:
    resolution: {integrity: sha512-leaf}
  peer@2.0.0:
    resolution: {integrity: sha512-peer}
snapshots:
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
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ packageManager: "pnpm@10.6.2" }),
    "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
    "pnpm-lock.yaml": lock,
    "scripts/build/image.ts": "export {};\n",
    "images/router/Dockerfile": dockerfile,
    "images/router/base-digest": "sha256:base\n",
    "packages/client/package.json": JSON.stringify({
      name: "@fixture/core",
      version: "1",
      scripts: { lint: "node src/daemon/run.ts" },
      exports: {
        ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
        "./internal": {
          "sharness-internal": {
            types: "./dist/internal.d.ts",
            import: "./dist/internal.js",
          },
        },
      },
    }),
    "packages/client/tsconfig.json": JSON.stringify({
      compilerOptions: { rootDir: "src", outDir: "dist" },
    }),
    "packages/client/src/index.ts": "export const publicValue = 1;\n",
    "packages/client/src/internal.ts":
      'export { privateValue } from "./private.js";\n',
    "packages/client/src/private.ts": "export const privateValue = 1;\n",
    "packages/client/src/daemon/run.ts": "export const daemon = 1;\n",
  };
  for (const service of ["router", "registry"]) {
    files[`packages/${service}/package.json`] = JSON.stringify({
      name: `@fixture/${service}`,
      version: "1",
      dependencies: { "@fixture/core": "workspace:*" },
    });
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
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

function key(repo: string): string {
  const result = run(repo);
  assert.equal(result.status, 0, result.stderr);
  const value: unknown = JSON.parse(result.stdout);
  assert.ok(typeof value === "object" && value !== null && "router" in value);
  assert.match(String(value.router), /^sha256:[0-9a-f]{64}$/u);
  return String(value.router);
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
    "daemon-only source",
    "packages/client/src/daemon/run.ts",
    "export const daemon = 2;",
    false,
  ],
  [
    "Router source",
    "packages/router/src/index.ts",
    'import "@fixture/core/internal"; export const router = 2;',
    true,
  ],
  [
    "Dockerfile",
    "images/router/Dockerfile",
    `${dockerfile}\nENV NEW=1\n`,
    true,
  ],
  ["base-image pin", "images/router/base-digest", "sha256:other", true],
  [
    "runtime external bump",
    "pnpm-lock.yaml",
    lock
      .replaceAll("leaf@1.0.0", "leaf@1.0.1")
      .replace("version: 1.0.0\npackages:", "version: 1.0.1\npackages:"),
    true,
  ],
  [
    "transitive runtime integrity",
    "pnpm-lock.yaml",
    lock.replace("sha512-peer", "sha512-new"),
    true,
  ],
  [
    "condition-only internal module",
    "packages/client/src/private.ts",
    "export const privateValue = 2;",
    true,
  ],
  [
    "default-condition module",
    "packages/client/src/index.ts",
    "export const publicValue = 2;",
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
  ],
  ["sibling version-only manifest", "packages/client/package.json", "", false],
  [
    "unrelated dev dependency",
    "pnpm-lock.yaml",
    lock.replace(
      "unused:\n        version: 1.0.0",
      "unused:\n        version: 2.0.0",
    ),
    false,
  ],
  ["build script", "scripts/build/image.ts", "export const build = 2;", true],
  [
    "pnpm release",
    "package.json",
    JSON.stringify({ packageManager: "pnpm@10.6.3" }),
    true,
  ],
] as const;

for (const [label, file, content, changesKey] of changes) {
  await test(`Router key ${changesKey ? "changes" : "stays equal"} for ${label}`, (t) => {
    const repo = fixture();
    t.after(() => {
      rmSync(repo, { recursive: true, force: true });
    });
    const before = key(repo);
    const text =
      content ||
      readFileSync(path.join(repo, file), "utf8").replace(
        '"version":"1"',
        '"version":"2"',
      );
    write(repo, file, text);
    commit(repo);
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

await test("invoked root scripts and nested script flags change the key", (t) => {
  const repo = fixture();
  t.after(() => {
    rmSync(repo, { recursive: true, force: true });
  });
  write(
    repo,
    "images/router/Dockerfile",
    dockerfile.replace(
      "RUN node scripts/build/image.ts",
      "RUN pnpm run build:image",
    ),
  );
  const manifest = {
    packageManager: "pnpm@10.6.2",
    scripts: {
      "build:image": "pnpm compile:image",
      "compile:image": "node scripts/build/image.ts",
    },
  };
  write(repo, "package.json", JSON.stringify(manifest));
  commit(repo);
  const before = key(repo);
  write(
    repo,
    "package.json",
    JSON.stringify({
      ...manifest,
      scripts: {
        ...manifest.scripts,
        "compile:image": "node scripts/build/image.ts --new-mode",
      },
    }),
  );
  commit(repo);
  assert.notEqual(key(repo), before);
});

await test("root script flags invoked by a package build target change the key", (t) => {
  const repo = fixture();
  t.after(() => {
    rmSync(repo, { recursive: true, force: true });
  });
  const rootManifest = {
    packageManager: "pnpm@10.6.2",
    scripts: { "compile:image": "node scripts/build/image.ts" },
  };
  write(repo, "package.json", JSON.stringify(rootManifest));
  const clientFile = "packages/client/package.json";
  const parsed: unknown = JSON.parse(
    readFileSync(path.join(repo, clientFile), "utf8"),
  );
  assert.ok(typeof parsed === "object" && parsed !== null);
  write(
    repo,
    clientFile,
    JSON.stringify({
      ...parsed,
      nx: {
        targets: {
          build: { options: { cwd: ".", command: "pnpm compile:image" } },
        },
      },
    }),
  );
  commit(repo);
  const before = key(repo);
  write(
    repo,
    "package.json",
    JSON.stringify({
      ...rootManifest,
      scripts: { "compile:image": "node scripts/build/image.ts --new-mode" },
    }),
  );
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
  assert.match(result.stderr, /Missing workspace export target/u);
});

function copyFiles(repo: string, source: string): string[] {
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- COPY coverage enumerates Git's committed fixture files.
  const listing = spawnSync("git", ["ls-files", "--", source], {
    cwd: repo,
    encoding: "utf8",
  });
  assert.equal(listing.status, 0);
  const files = listing.stdout.trim().split("\n");
  assert.ok(files[0], `missing COPY source ${source}`);
  return files;
}

function changedInput(file: string, original: string): string {
  if (file === "package.json") {
    return original.replace("10.6.2", "10.6.3");
  }
  if (file === "pnpm-lock.yaml") {
    return original.replace("sha512-leaf", "sha512-changed");
  }
  if (file.endsWith("package.json")) {
    return original.replace(
      '"version":"1"',
      '"version":"1","description":"changed"',
    );
  }
  return `${original}\n`;
}

await test("every Dockerfile COPY source is covered by the key", (t) => {
  const repo = fixture();
  t.after(() => {
    rmSync(repo, { recursive: true, force: true });
  });
  const before = key(repo);
  const copies = dockerfile
    .split("\n")
    .filter((line) => line.startsWith("COPY ") && !line.includes("--from="));
  for (const copy of copies) {
    const sources = copy.split(/\s+/u).slice(1, -1);
    for (const source of sources) {
      const files = copyFiles(repo, source);
      for (const file of files) {
        const original = readFileSync(path.join(repo, file), "utf8");
        const changed = changedInput(file, original);
        write(repo, file, changed);
        commit(repo);
        assert.notEqual(key(repo), before, `key misses COPY source ${file}`);
        write(repo, file, original);
        commit(repo);
      }
    }
  }
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
  await test(`refuses ${label} without printing partial keys`, (t) => {
    const repo = fixture();
    t.after(() => {
      rmSync(repo, { recursive: true, force: true });
    });
    write(repo, "pnpm-lock.yaml", content);
    commit(repo);
    const result = run(repo);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, message);
  });
}
