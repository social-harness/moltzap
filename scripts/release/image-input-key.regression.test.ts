/** @file Adversarial image input contracts against committed Git fixtures. */
import { Effect, Either } from "effect";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
// eslint-disable-next-line agent-code-guard/prefer-effect-platform -- Synchronous Git fixtures exercise committed input behavior.
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { hostCodeHashOfPackage } from "./host-code-hash.ts";
import {
  commit,
  dockerfile,
  fixture,
  git,
  key,
  lock,
  write,
} from "./image-input-key.fixture.ts";
import {
  ImageInputError,
  imageInputs,
  runtimeVersionReads,
} from "./image-input-key.ts";

// @agent-code-guard/regression-only: Adversarial fixtures verify input sensitivity and typed refusal through the release API.

for (const [label, instruction] of [
  ["unpinned FROM", "FROM node:24-slim"],
  ["unpinned COPY image", "COPY --from=node:24 /bin/node /node"],
  [
    "unpinned mount image",
    "RUN --mount=type=bind,from=node:24,target=/node true",
  ],
  ["unpinned syntax frontend", "# syntax=docker/dockerfile:1"],
  ["undeclared COPY stage", "COPY --from=missing /app /app"],
  [
    "undeclared mount stage",
    "RUN --mount=type=bind,from=missing,target=/app true",
  ],
  ["later COPY stage", "COPY --from=build /app /app"],
  ["unscoped install", "RUN pnpm install --frozen-lockfile"],
  ["unscoped deploy", "RUN pnpm deploy /out"],
  [
    "install without dependency scope",
    "RUN pnpm install --filter @fixture/router",
  ],
  ["other service install", "RUN pnpm install --filter @fixture/registry..."],
  ["filtered package script", "RUN pnpm --filter @fixture/router run build"],
  ["directory package script", "RUN pnpm -C packages/router run build"],
  ["scope after run", "RUN pnpm run --filter @fixture/router build"],
  [
    "scoped script with unrelated install word",
    "RUN pnpm --filter @fixture/router run compile && echo install",
  ],
] as const) {
  await test(`refuses ${label}`, (t) => {
    const repo = fixture();
    t.after(() => {
      rmSync(repo, { recursive: true, force: true });
    });
    write(repo, "images/router/Dockerfile", `${instruction}\n${dockerfile}`);
    commit(repo);
    const error = refused(repo);
    assert.ok(error instanceof ImageInputError);
    assert.match(error.message, /images\/router\/Dockerfile|package.json/u);
  });
}

await test("COPY service directories never turn release prose or comments into commands", (t) => {
  const repo = fixture();
  t.after(() => {
    rmSync(repo, { recursive: true, force: true });
  });
  write(repo, "packages/router/README.md", "docs/guide.md");
  write(repo, "docs/guide.md", "CHANGELOG.md examples/two-agents/package.json");
  write(repo, "CHANGELOG.md", "old");
  write(
    repo,
    "examples/two-agents/package.json",
    '{"dependencies":{"@fixture/router":"1"}}',
  );
  write(
    repo,
    "images/router/Dockerfile",
    `${dockerfile}\nRUN true # CHANGELOG.md\n`,
  );
  commit(repo);
  const before = Effect.runSync(imageInputs(repo));
  write(repo, "CHANGELOG.md", "release");
  write(repo, "docs/guide.md", "release docs");
  write(
    repo,
    "examples/two-agents/package.json",
    '{"dependencies":{"@fixture/router":"2"}}',
  );
  commit(repo);
  assert.deepEqual(Effect.runSync(imageInputs(repo)), before);
});

await test("a full-line comment continuation cannot hide COPY", (t) => {
  const repo = fixture();
  t.after(() => {
    rmSync(repo, { recursive: true, force: true });
  });
  write(
    repo,
    "images/router/Dockerfile",
    `${dockerfile}\n# comment \\\nCOPY assets/ /assets\n`,
  );
  commit(repo);
  const before = key(repo);
  write(repo, "assets/config", "changed");
  commit(repo);
  assert.notEqual(key(repo), before);
});

await test("direct importer mappings bind versions even when both snapshots remain reachable", (t) => {
  const repo = fixture();
  t.after(() => {
    rmSync(repo, { recursive: true, force: true });
  });
  const base = lock.replace(
    "      alias:",
    "      second:\n        version: leaf@1.0.0\n      keeper:\n        version: external@1.0.0(peer@2.0.0)\n      alias:",
  );
  write(repo, "pnpm-lock.yaml", base);
  commit(repo);
  const before = key(repo);
  write(
    repo,
    "pnpm-lock.yaml",
    base.replace("version: external@1.0.0(peer@2.0.0)", "version: leaf@1.0.0"),
  );
  commit(repo);
  assert.notEqual(key(repo), before);
});

for (const [label, file, initial, changed] of [
  [
    "lock settings",
    "pnpm-lock.yaml",
    `settings: {autoInstallPeers: true}\n${lock}`,
    `settings: {autoInstallPeers: false}\n${lock}`,
  ],
  [
    "pnpmfile checksum",
    "pnpm-lock.yaml",
    `pnpmfileChecksum: first\n${lock}`,
    `pnpmfileChecksum: second\n${lock}`,
  ],
  [
    "pnpm hook",
    ".pnpmfile.cjs",
    "module.exports = {};",
    "module.exports = {hooks: {}};",
  ],
] as const) {
  await test(`${label} changes both keys`, (t) => {
    const repo = fixture();
    t.after(() => {
      rmSync(repo, { recursive: true, force: true });
    });
    write(repo, file, initial);
    commit(repo);
    const before = Effect.runSync(imageInputs(repo));
    write(repo, file, changed);
    commit(repo);
    const after = Effect.runSync(imageInputs(repo));
    assert.notEqual(after.router?.key, before.router?.key);
    assert.notEqual(after.registry?.key, before.registry?.key);
  });
}

for (const root of ["packages/router", "packages/client"] as const) {
  await test(`${root} build tools bind their locked versions`, (t) => {
    const repo = fixture();
    t.after(() => {
      rmSync(repo, { recursive: true, force: true });
    });
    const file = `${root}/package.json`;
    const manifest: unknown = JSON.parse(
      readFileSync(path.join(repo, file), "utf8"),
    );
    assert.ok(typeof manifest === "object" && manifest !== null);
    write(
      repo,
      file,
      JSON.stringify({ ...manifest, devDependencies: { unused: "catalog:" } }),
    );
    const base =
      root === "packages/client"
        ? lock.replace(
            "  packages/client:",
            "  packages/client:\n    devDependencies:\n      unused:\n        version: 1.0.0",
          )
        : lock;
    write(repo, "pnpm-lock.yaml", base);
    commit(repo);
    const before = key(repo);
    write(
      repo,
      "pnpm-lock.yaml",
      base
        .replaceAll("unused@1.0.0", "unused@2.0.0")
        .replaceAll(
          "      unused:\n        version: 1.0.0",
          "      unused:\n        version: 2.0.0",
        ),
    );
    commit(repo);
    assert.notEqual(key(repo), before);
  });
}

for (const [label, root, scripts, nx] of [
  [
    "service lifecycle",
    "packages/router",
    { postinstall: "node ../../tools/extra.ts" },
    {},
  ],
  [
    "sibling lifecycle",
    "packages/client",
    { prepare: "node ../../tools/extra.ts" },
    {},
  ],
  [
    "package build cwd",
    "packages/client",
    { build: "node ../../tools/extra.ts" },
    { targets: { build: { options: { cwd: "tools" } } } },
  ],
  [
    "object Nx command",
    "packages/client",
    {},
    {
      targets: {
        build: {
          options: { cwd: ".", commands: [{ command: "node tools/extra.ts" }] },
        },
      },
    },
  ],
] as const) {
  await test(`${label} discovers its executable`, (t) => {
    const repo = fixture();
    t.after(() => {
      rmSync(repo, { recursive: true, force: true });
    });
    const file = `${root}/package.json`;
    const manifest: unknown = JSON.parse(
      readFileSync(path.join(repo, file), "utf8"),
    );
    assert.ok(typeof manifest === "object" && manifest !== null);
    write(repo, file, JSON.stringify({ ...manifest, scripts, nx }));
    write(repo, "tools/extra.ts", 'import "./leaf.js";');
    write(repo, "tools/leaf.ts", "export const value = 1;");
    commit(repo);
    const before = key(repo);
    write(repo, "tools/leaf.ts", "export const value = 2;");
    commit(repo);
    assert.notEqual(key(repo), before);
  });
}

await test("project.json build commands discover their executable", (t) => {
  const repo = fixture();
  t.after(() => {
    rmSync(repo, { recursive: true, force: true });
  });
  write(
    repo,
    "packages/client/project.json",
    JSON.stringify({
      targets: {
        build: {
          executor: "nx:run-commands",
          options: { cwd: ".", command: "node tools/extra.ts" },
        },
      },
    }),
  );
  write(repo, "tools/extra.ts", "export const value = 1;");
  commit(repo);
  const before = key(repo);
  write(repo, "tools/extra.ts", "export const value = 2;");
  commit(repo);
  assert.notEqual(key(repo), before);
});

for (const [label, file, content] of [
  [
    "Nx executor",
    "packages/client/project.json",
    JSON.stringify({ targets: { build: { executor: "@nx/js:tsc" } } }),
  ],
  [
    "Nx configurations",
    "packages/client/package.json",
    JSON.stringify({
      name: "@fixture/core",
      exports: {
        ".": "./dist/index.js",
        "./internal": "./dist/internal.js",
        "./test": { "sharness-test": "./dist/index.js" },
      },
      nx: { targets: { build: { configurations: { production: {} } } } },
    }),
  ],
  [
    "missing relative config",
    "packages/client/tsconfig.json",
    '{"extends":"./missing"}',
  ],
  [
    "missing package config",
    "packages/client/tsconfig.json",
    '{"extends":"@unkeyed/preset/tsconfig.json"}',
  ],
] as const) {
  await test(`refuses ${label} with its file`, (t) => {
    const repo = fixture();
    t.after(() => {
      rmSync(repo, { recursive: true, force: true });
    });
    write(repo, file, content);
    commit(repo);
    const error = refused(repo);
    assert.ok(error instanceof ImageInputError);
    assert.ok(error.message.includes(file));
  });
}

await test("JSONC extensionless inheritance and references bind compiler inputs", (t) => {
  const repo = fixture();
  t.after(() => {
    rmSync(repo, { recursive: true, force: true });
  });
  write(
    repo,
    "packages/client/tsconfig.json",
    '{// inherited layout\n"extends":"./layout", "references":[{"path":"../../config/ref"}],}',
  );
  write(
    repo,
    "packages/client/layout.json",
    '{"compilerOptions":{"outDir":"dist","rootDir":"src",},}',
  );
  write(repo, "config/ref/tsconfig.json", "{}");
  commit(repo);
  const before = key(repo);
  write(
    repo,
    "config/ref/tsconfig.json",
    '{"compilerOptions":{"strict":true}}',
  );
  commit(repo);
  assert.notEqual(key(repo), before);
});

for (const [label, expression] of [
  [
    "joined manifest path",
    'readFileSync(path.join(import.meta.dirname, "..", "package.json"))',
  ],
  ["bracket npm version", 'process.env["npm_package_version"]'],
  [
    "destructured npm version",
    "(() => { const {npm_package_version: version} = process.env; return version; })()",
  ],
  [
    "default manifest re-export",
    '(() => {})(); export {default} from "../package.json"',
  ],
  [
    "wire version",
    '(() => { const manifest = require("../package.json"); return manifest.sharnessWireVersion; })()',
  ],
] as const) {
  await test(`runtime version gate detects ${label}`, (t) => {
    const repo = fixture();
    t.after(() => {
      rmSync(repo, { recursive: true, force: true });
    });
    write(repo, "packages/router/src/version.ts", `${expression};`);
    commit(repo);
    assert.deepEqual(Effect.runSync(runtimeVersionReads(repo)), [
      "packages/router/src/version.ts",
    ]);
  });
}

await test("runtime version gate excludes tests and modules reached only by tests", (t) => {
  const repo = fixture();
  t.after(() => {
    rmSync(repo, { recursive: true, force: true });
  });
  write(
    repo,
    "packages/router/src/version.test.ts",
    'console.log(process.env.npm_package_version); import "@fixture/core/service";',
  );
  write(
    repo,
    "packages/client/src/daemon/run.ts",
    "console.log(process.env.npm_package_version);",
  );
  write(
    repo,
    "packages/router/package.json",
    JSON.stringify({
      name: "@fixture/router",
      exports: { "./test": { "sharness-test": "./dist/testing-entry.js" } },
    }),
  );
  write(
    repo,
    "packages/router/src/testing-entry.ts",
    "console.log(process.env.npm_package_version);",
  );
  commit(repo);
  assert.deepEqual(Effect.runSync(runtimeVersionReads(repo)), []);
});

await test("refuses a submodule beneath service inputs", (t) => {
  const repo = fixture();
  t.after(() => {
    rmSync(repo, { recursive: true, force: true });
  });
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- Git creates a committed gitlink fixture.
  const head = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repo,
    encoding: "utf8",
  }).stdout.trim();
  git(repo, [
    "update-index",
    "--add",
    "--cacheinfo",
    `160000,${head},packages/router/vendor`,
  ]);
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
    "gitlink",
  ]);
  const error = refused(repo);
  assert.ok(error instanceof ImageInputError);
  assert.match(error.message, /gitlink.*packages\/router\/vendor/u);
});

await test("inherited nondefault compiler directories resolve emitted exports", (t) => {
  const repo = fixture();
  t.after(() => {
    rmSync(repo, { recursive: true, force: true });
  });
  write(repo, "packages/client/tsconfig.json", '{"extends":"./layout"}');
  write(
    repo,
    "packages/client/layout.json",
    '{"compilerOptions":{"outDir":"lib","rootDir":"source"}}',
  );
  write(
    repo,
    "packages/client/package.json",
    '{"name":"@fixture/core","exports":{".":"./lib/index.js","./internal":"./lib/index.js","./test":{"sharness-test":"./lib/index.js"}}}',
  );
  write(repo, "packages/client/source/index.ts", "export const value = 1;");
  commit(repo);
  const before = key(repo);
  write(repo, "packages/client/source/index.ts", "export const value = 2;");
  commit(repo);
  assert.notEqual(key(repo), before);
});

for (const [label, instruction] of [
  ["current named stage", "COPY --from=build /app /app"],
  ["current numeric stage", "RUN --mount=type=bind,from=0,target=/app true"],
] as const) {
  await test(`refuses ${label} as an earlier stage`, (t) => {
    const repo = fixture();
    t.after(() => {
      rmSync(repo, { recursive: true, force: true });
    });
    write(
      repo,
      "images/router/Dockerfile",
      `FROM node@sha256:${"a".repeat(64)} AS build\n${instruction}`,
    );
    commit(repo);
    const error = refused(repo);
    assert.match(error.message, /earlier stage.*images\/router\/Dockerfile/u);
  });
}

for (const [label, script] of [
  ["shell install", "pnpm install"],
  ["nested scoped run", "pnpm --filter @fixture/router run compile"],
] as const) {
  await test(`refuses ${label} named by executable text`, (t) => {
    const repo = fixture();
    t.after(() => {
      rmSync(repo, { recursive: true, force: true });
    });
    write(
      repo,
      "images/router/Dockerfile",
      `${dockerfile}\nRUN sh tools/install.sh`,
    );
    write(repo, "tools/install.sh", script);
    commit(repo);
    const error = refused(repo);
    assert.match(error.message, /tools\/install.sh/u);
  });
}

await test("shell inline comments cannot name release inputs", (t) => {
  const repo = fixture();
  t.after(() => {
    rmSync(repo, { recursive: true, force: true });
  });
  write(
    repo,
    "images/router/Dockerfile",
    `${dockerfile}\nRUN sh tools/build.sh`,
  );
  write(repo, "tools/build.sh", "true;# CHANGELOG.md\n");
  write(repo, "CHANGELOG.md", "first");
  commit(repo);
  const before = key(repo);
  write(repo, "CHANGELOG.md", "release");
  commit(repo);
  assert.equal(key(repo), before);
});

await test("refuses non-UTF-8 committed paths", (t) => {
  const repo = fixture();
  t.after(() => {
    rmSync(repo, { recursive: true, force: true });
  });
  writeFileSync(
    Buffer.concat([
      Buffer.from(`${repo}/packages/router/`),
      Buffer.from([255]),
    ]),
    "invalid",
  );
  commit(repo);
  const error = refused(repo);
  assert.ok(error instanceof ImageInputError);
  assert.match(error.message, /Non-UTF-8/u);
});

await test("host hash ignores untracked workspace directories", (t) => {
  const repo = fixture();
  t.after(() => {
    rmSync(repo, { recursive: true, force: true });
  });
  write(repo, "packages/untracked/package.json", "invalid JSON");
  assert.doesNotThrow(() => hostCodeHashOfPackage(repo, "router"));
});

await test("host hash refuses duplicate tracked workspace names", (t) => {
  const repo = fixture();
  t.after(() => {
    rmSync(repo, { recursive: true, force: true });
  });
  write(repo, "packages/duplicate/package.json", '{"name":"@fixture/router"}');
  commit(repo);
  assert.throws(
    () => hostCodeHashOfPackage(repo, "router"),
    /Duplicate workspace package name @fixture\/router/u,
  );
});

function refused(repo: string): ImageInputError {
  return Either.match(Effect.runSync(Effect.either(imageInputs(repo))), {
    onLeft: (error) => error,
    onRight: () => assert.fail("Expected a typed refusal"),
  });
}

await test("shell executables retain the caller working directory", (t) => {
  const repo = fixture();
  t.after(() => {
    rmSync(repo, { recursive: true, force: true });
  });
  write(
    repo,
    "images/router/Dockerfile",
    `${dockerfile}\nRUN sh tools/build.sh`,
  );
  write(repo, "tools/build.sh", "node tools/extra.ts");
  write(repo, "tools/extra.ts", 'import "./leaf.js";');
  write(repo, "tools/leaf.ts", "export const value = 1;");
  commit(repo);
  const before = key(repo);
  write(repo, "tools/leaf.ts", "export const value = 2;");
  commit(repo);
  assert.notEqual(key(repo), before);
});

await test("runtime version gate retains entries shared by active and test exports", (t) => {
  const repo = fixture();
  t.after(() => {
    rmSync(repo, { recursive: true, force: true });
  });
  write(
    repo,
    "packages/router/package.json",
    JSON.stringify({
      name: "@fixture/router",
      exports: {
        ".": {
          import: "./dist/shared-entry.js",
          "sharness-test": "./dist/shared-entry.js",
        },
      },
    }),
  );
  write(
    repo,
    "packages/router/src/shared-entry.ts",
    "console.log(process.env.npm_package_version);",
  );
  commit(repo);
  assert.deepEqual(Effect.runSync(runtimeVersionReads(repo)), [
    "packages/router/src/shared-entry.ts",
  ]);
});

await test("installed workspace lifecycle inputs bind keys without runtime imports", (t) => {
  const repo = fixture();
  t.after(() => {
    rmSync(repo, { recursive: true, force: true });
  });
  write(repo, "packages/router/src/index.ts", "export {};");
  write(repo, "packages/registry/src/index.ts", "export {};");
  write(repo, "packages/router/src/index.test.ts", "export {};");
  write(repo, "packages/registry/src/index.test.ts", "export {};");
  write(
    repo,
    "packages/client/package.json",
    JSON.stringify({
      name: "@fixture/core",
      scripts: { postinstall: "node ../../tools/install.ts" },
    }),
  );
  write(repo, "tools/install.ts", "export const value = 1;");
  commit(repo);
  const before = key(repo);
  write(repo, "tools/install.ts", "export const value = 2;");
  commit(repo);
  assert.notEqual(key(repo), before);
});
