/** @file Private plugin regressions mutate an owned candidate copy, never the checkout or its cache inputs. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { PRIVATE_PLUGINS } from "../architecture/boundary-contract.ts";

const workspaceRoot = resolve(import.meta.dirname, "..", "..");
const fixtureRoot = makeWorkspaceFixture();
const cases = [
  {
    source: 'import "@moltzap/client/service";',
    failure: /runtime adapter must import only/,
  },
  {
    source: 'import "@moltzap/identity";',
    failure: /dependency DAG violation/,
  },
  {
    source: 'import "../../../packages/client/src/index.js";',
    failure: /must not cross its boundary/,
  },
  {
    source: 'export * from "./main.js";',
    failure: /wildcard export is not allowed/,
  },
];

try {
  await test("private plugins pass the normal source boundary", () => {
    assert.ok(
      PRIVATE_PLUGINS.length > 0,
      "The fixture needs a registered private plugin",
    );
    const result = runBoundaries();
    assert.equal(result.status, 0, result.stderr);
    const sourceGuard = runSourceGuard();
    assert.equal(sourceGuard.status, 0, sourceGuard.stdout);
  });

  for (const plugin of PRIVATE_PLUGINS) {
    for (const input of cases) {
      await test(`${plugin.name} rejects ${input.source}`, () => {
        withPlantedSource(plugin.root, input.source, () => {
          const rejected = runBoundaries();
          assert.equal(rejected.status, 1, rejected.stdout + rejected.stderr);
          assert.match(rejected.stderr, input.failure);
        });
      });
    }
    await test(`source guard rejects an unsafe ${plugin.name} cast`, () => {
      withPlantedSource(
        plugin.root,
        "const unsafe = {} as unknown as string;",
        () => {
          const rejected = runSourceGuard();
          assert.equal(rejected.status, 1, rejected.stdout + rejected.stderr);
          const castFinding = rejected.stdout
            .split("\n\n")
            .find((block) => block.includes("[as-unknown-as]"));
          assert.ok(castFinding, rejected.stdout);
          assert.ok(
            castFinding.includes(`${plugin.root}/src/index.ts`),
            rejected.stdout,
          );
          assert.ok(
            castFinding.includes("const unsafe = {} as unknown as string;"),
            rejected.stdout,
          );
        },
      );
    });
  }
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}

/** Every test restores the candidate bytes, including when an assertion throws. */
function withPlantedSource(
  root: string,
  addition: string,
  verify: () => void,
): void {
  const pluginSource = resolve(fixtureRoot, root, "src/index.ts");
  const original = readFileSync(pluginSource, "utf8");
  try {
    writeFileSync(pluginSource, `${original}\n${addition}\n`);
    verify();
  } finally {
    writeFileSync(pluginSource, original);
  }
}

function runBoundaries() {
  return spawnSync(
    process.execPath,
    [resolve(workspaceRoot, "scripts/architecture/check-boundaries.ts")],
    {
      cwd: fixtureRoot,
      encoding: "utf8",
    },
  );
}

function runSourceGuard() {
  return spawnSync(
    resolve(workspaceRoot, "scripts/code/sloppy-code-guard.sh"),
    { cwd: fixtureRoot, encoding: "utf8" },
  );
}

/** Git selects tracked and non-ignored candidate inputs; unstaged deletions are absent from the copy. */
function makeWorkspaceFixture(): string {
  const listing = spawnSync(
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- Gate tests use Git from the developer or CI toolchain with fixed arguments and no shell.
    "git",
    [
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      "packages",
      "plugins",
      "tools/workspace",
      "package.json",
      "knip.json",
      "tsconfig.json",
      "LICENSE",
      "NOTICE",
      ".github/workflows/publish.yml",
    ],
    { cwd: workspaceRoot, encoding: "utf8" },
  );
  assert.equal(listing.status, 0, listing.stderr);
  const root = mkdtempSync(resolve(tmpdir(), "sharness-plugin-guards-"));
  try {
    for (const file of new Set(listing.stdout.split("\0").filter(Boolean))) {
      const source = resolve(workspaceRoot, file);
      if (!lstatSync(source, { throwIfNoEntry: false })) {
        continue;
      }
      const destination = resolve(root, file);
      mkdirSync(dirname(destination), { recursive: true });
      cpSync(source, destination, { verbatimSymlinks: true });
    }
    return root;
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}
