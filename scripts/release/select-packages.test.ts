#!/usr/bin/env node
/**
 * @file Tests for the release's package selection, content hash, and
 * host-code hash.
 *
 * Invoked via `pnpm test:select-packages`. The selection runs over an
 * in-memory workspace whose content hash includes each sibling pin, as a
 * packed manifest does; the hashes run over real temporary directories.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  FINAL_PACKAGES,
  RELEASE_PACKAGES,
} from "../architecture/boundary-contract.ts";
import {
  contentHashOfDirectory,
  contentHashOfTarball,
} from "./content-hash.ts";
import { hostCodeHashOfDirectories } from "./host-code-hash.ts";
import {
  classifyNpmView,
  type Manifest,
  type Recorded,
  selectPackages,
  type Workspace,
} from "./select-packages.ts";

const RELEASE = "2099.101.0";
const PREVIOUS = "2099.100.0";

/** Product release tests follow the same package set as release selection. */
const DIRS = RELEASE_PACKAGES;
const DEPENDENCIES = Object.fromEntries(
  DIRS.map((dir) => [dir, FINAL_PACKAGES[dir].deps]),
);

const MANIFEST = {
  name: "@moltzap/openclaw-channel",
  version: PREVIOUS,
  dependencies: { "@moltzap/client": PREVIOUS },
};
const FILES = { "dist/index.js": "export {};\n", "openclaw.plugin.json": "{}" };

const CHANNEL_MANIFEST = MANIFEST;
const CLIENT_MANIFEST = {
  name: "@moltzap/client",
  version: PREVIOUS,
  exports: {
    ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
    "./service": {
      types: "./dist/daemon/index.d.ts",
      import: "./dist/daemon/index.js",
    },
  },
  bin: { sharnessd: "./bin/sharnessd" },
};

const UNAVAILABLE: Recorded["kind"] = "unavailable";

/** Npm holds every PREVIOUS version with the hash it was published with. */
const AS_PUBLISHED = (): Recorded | undefined => undefined;

// @agent-code-guard/regression-only: Each case is one release scenario the publish workflow must get right: client-only, identity, unchanged, missing hash, npm outage, and misordered packages.

await test("a client-only change publishes the client and the channel that pins it", () => {
  const { workspace, versions } = fakeWorkspace(
    { client: "client-changed" },
    AS_PUBLISHED,
  );
  assert.deepEqual(selectPackages(workspace, RELEASE, DIRS), {
    kind: "selected",
    dirs: ["client", "openclaw-channel"],
  });
  assert.deepEqual(Object.fromEntries(versions), {
    client: RELEASE,
    "openclaw-channel": RELEASE,
  });
});

await test("a library change publishes every package that pins the library", () => {
  const { workspace } = fakeWorkspace(
    { client: "library-changed" },
    AS_PUBLISHED,
  );
  assert.deepEqual(selectPackages(workspace, RELEASE, DIRS), {
    kind: "selected",
    dirs: [...DIRS],
  });
});

await test("an unchanged workspace publishes nothing", () => {
  const { workspace } = fakeWorkspace({}, AS_PUBLISHED);
  assert.deepEqual(selectPackages(workspace, RELEASE, DIRS), {
    kind: "selected",
    dirs: [],
  });
});

await test("a version npm holds without a recorded hash is republished", () => {
  const { workspace } = fakeWorkspace({}, (name) =>
    name === "@moltzap/client" ? { kind: "absent" } : undefined,
  );
  assert.deepEqual(selectPackages(workspace, RELEASE, DIRS), {
    kind: "selected",
    dirs: [...DIRS],
  });
});

await test("an npm outage stops the selection", () => {
  const outage: Recorded = { kind: "unavailable", message: "E503" };
  const { workspace } = fakeWorkspace({}, () => outage);
  assert.deepEqual(selectPackages(workspace, RELEASE, DIRS), outage);
});

await test("a package listed before a sibling it depends on stops the selection", () => {
  const { workspace, versions } = fakeWorkspace({}, AS_PUBLISHED);
  assert.deepEqual(
    selectPackages(workspace, RELEASE, ["openclaw-channel", "client"]),
    {
      kind: "out-of-order",
      message:
        "openclaw-channel depends on @moltzap/client, which must come before it",
    },
  );
  assert.equal(versions.get("openclaw-channel"), PREVIOUS);
});

await test("the content hash ignores the version, the recorded hash, and key order", () => {
  assert.equal(
    hashOf(
      {
        sharnessContentHash: "sha256:old",
        dependencies: MANIFEST.dependencies,
        version: RELEASE,
        name: MANIFEST.name,
      },
      FILES,
    ),
    hashOf(MANIFEST, FILES),
  );
});

await test("the content hash changes with any packed file or sibling pin", () => {
  const base = hashOf(MANIFEST, FILES);
  assert.notEqual(
    hashOf(MANIFEST, { ...FILES, "dist/index.js": "export const a = 1;\n" }),
    base,
  );
  assert.notEqual(hashOf(MANIFEST, { ...FILES, "dist/extra.js": "" }), base);
  assert.notEqual(
    hashOf(
      { ...MANIFEST, dependencies: { "@moltzap/client": RELEASE } },
      FILES,
    ),
    base,
  );
});

await test("the content hash changes with a file's executable bit", () => {
  const root = packedDirectory(MANIFEST, { ...FILES, "bin/tool": "" });
  const before = contentHashOfDirectory(root);
  chmodSync(path.join(root, "bin/tool"), 0o755);
  const after = contentHashOfDirectory(root);
  rmSync(root, { recursive: true, force: true });
  assert.notEqual(after, before);
});

await test("a packed tarball hashes as its extracted package does", () => {
  const parent = mkdtempSync(path.join(tmpdir(), "content-hash-tarball-"));
  const root = path.join(parent, "package");
  renameSync(packedDirectory(MANIFEST, { ...FILES, "bin/tool": "" }), root);
  chmodSync(path.join(root, "bin/tool"), 0o755);
  const tarball = path.join(parent, "pkg.tgz");
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- The test packs with the system tar, as content-hash.ts extracts with it.
  const packed = spawnSync("tar", ["-czf", tarball, "-C", parent, "package"]);
  const hash = contentHashOfTarball(tarball);
  const expected = contentHashOfDirectory(root);
  rmSync(parent, { recursive: true, force: true });
  assert.equal(packed.status, 0);
  assert.equal(hash, expected);
});

await test("npm's answers classify as a hash, absent, or unavailable", () => {
  const subject = "@moltzap/client@2099.100.0";
  assert.deepEqual(
    classifyNpmView({ status: 0, stdout: '"sha256:a"\n', stderr: "" }, subject),
    { kind: "hash", hash: "sha256:a" },
  );
  assert.deepEqual(
    classifyNpmView({ status: 0, stdout: "", stderr: "" }, subject),
    { kind: "absent" },
  );
  assert.deepEqual(
    classifyNpmView(
      {
        status: 1,
        stdout: JSON.stringify({ error: { code: "E404" } }),
        stderr: "",
      },
      subject,
    ),
    { kind: "absent" },
  );
  for (const failure of [
    { status: 1, stdout: JSON.stringify({ error: { code: "ECONNREFUSED" } }) },
    { status: null, stdout: "" },
  ]) {
    assert.equal(
      classifyNpmView({ ...failure, stderr: "connect failed" }, subject).kind,
      UNAVAILABLE,
    );
  }
});

await test("the host-code hash ignores Client modules the channel cannot reach", () => {
  const packages = hostPackages();
  const base = hostHash(packages);
  writeFileSync(
    path.join(packages.client, "dist/daemon/index.js"),
    "export const daemon = 2;\n",
  );
  writeFileSync(path.join(packages.client, "bin/sharnessd"), "changed\n");
  assert.equal(hostHash(packages), base);
  removePackages(packages);
});

await test("the host-code hash changes with any Client module the channel reaches", () => {
  const packages = hostPackages();
  const base = hostHash(packages);
  writeFileSync(
    path.join(packages.client, "dist/endpoint.js"),
    "export const endpoint = 2;\n",
  );
  assert.notEqual(hostHash(packages), base);
  removePackages(packages);
});

await test("the host-code hash ignores sibling versions and pins", () => {
  const packages = hostPackages();
  const base = hostHash(packages);
  writeFileSync(
    path.join(packages.channel, "package.json"),
    JSON.stringify({
      ...CHANNEL_MANIFEST,
      version: RELEASE,
      dependencies: { "@moltzap/client": RELEASE },
    }),
  );
  writeFileSync(
    path.join(packages.client, "package.json"),
    JSON.stringify({ ...CLIENT_MANIFEST, version: RELEASE }),
  );
  assert.equal(hostHash(packages), base);
  removePackages(packages);
});

/** An in-memory workspace and the manifest version of each package. */
interface Fake {
  readonly workspace: Workspace;
  readonly versions: Map<string, string>;
}

/**
 * Every package was last published at PREVIOUS with the hash its source and
 * pins had then; `code` overrides a package's current source, and `recorded`
 * overrides what npm answers for a version.
 */
function fakeWorkspace(
  code: Readonly<Record<string, string>>,
  recorded: (name: string, version: string) => Recorded | undefined,
): Fake {
  const versions = new Map<string, string>(DIRS.map((dir) => [dir, PREVIOUS]));
  const published = new Map(
    DIRS.map((dir) => [
      `@moltzap/${dir}@${PREVIOUS}`,
      packedHash(dir, `${dir}-source`, () => PREVIOUS),
    ]),
  );
  const workspace: Workspace = {
    manifest: (dir): Manifest => ({
      name: `@moltzap/${dir}`,
      version: versions.get(dir) ?? PREVIOUS,
      dependencies: Object.fromEntries(
        (DEPENDENCIES[dir] ?? []).map((sibling) => [
          `@moltzap/${sibling}`,
          "workspace:*",
        ]),
      ),
    }),
    contentHash: (dir) =>
      packedHash(
        dir,
        code[dir] ?? `${dir}-source`,
        (sibling) => versions.get(sibling) ?? PREVIOUS,
      ),
    recordedHash: (name, version) => {
      const hash = published.get(`${name}@${version}`);
      return (
        recorded(name, version) ??
        (hash === undefined ? { kind: "absent" } : { kind: "hash", hash })
      );
    },
    select: (dir, version) => {
      versions.set(dir, version);
    },
  };
  return { workspace, versions };
}

/** A fake content hash: the package's source and each sibling pin. */
function packedHash(
  dir: string,
  source: string,
  pin: (sibling: string) => string,
): string {
  const pins = (DEPENDENCIES[dir] ?? []).map(
    (sibling) => sibling + "@" + pin(sibling),
  );
  return `${source}|${pins.join(",")}`;
}

function hashOf(
  manifest: Readonly<Record<string, unknown>>,
  files: Readonly<Record<string, string>>,
): string {
  const root = packedDirectory(manifest, files);
  const hash = contentHashOfDirectory(root);
  rmSync(root, { recursive: true, force: true });
  return hash;
}

/** Extracted channel and Client packages for the host-code hash. */
interface HostPackages {
  readonly channel: string;
  readonly client: string;
}

/**
 * A channel whose plugin imports the Client root entry, and a Client whose
 * root reaches one endpoint module while `./service` and the binary sit
 * outside that graph.
 */
function hostPackages(): HostPackages {
  return {
    channel: packedDirectory(CHANNEL_MANIFEST, {
      "dist/plugin.js":
        'import { acquireHarnessEndpoint } from "@moltzap/client";\nexport default acquireHarnessEndpoint;\n',
      "openclaw.plugin.json": "{}",
    }),
    client: packedDirectory(CLIENT_MANIFEST, {
      "dist/index.js":
        'export { endpoint as acquireHarnessEndpoint } from "./endpoint.js";\n',
      "dist/endpoint.js": "export const endpoint = 1;\n",
      "dist/daemon/index.js": "export const daemon = 1;\n",
      "bin/sharnessd": 'import "../dist/daemon/index.js";\n',
    }),
  };
}

function hostHash(packages: HostPackages): string {
  return hostCodeHashOfDirectories(
    CHANNEL_MANIFEST.name,
    new Map([
      [CHANNEL_MANIFEST.name, packages.channel],
      [CLIENT_MANIFEST.name, packages.client],
    ]),
  );
}

function removePackages(packages: HostPackages): void {
  rmSync(packages.channel, { recursive: true, force: true });
  rmSync(packages.client, { recursive: true, force: true });
}

function packedDirectory(
  manifest: Readonly<Record<string, unknown>>,
  files: Readonly<Record<string, string>>,
): string {
  const root = mkdtempSync(path.join(tmpdir(), "content-hash-test-"));
  writeFileSync(path.join(root, "package.json"), JSON.stringify(manifest));
  for (const [relative, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    writeFileSync(path.join(root, relative), text);
  }
  return root;
}
