#!/usr/bin/env node
/**
 * @file Hash of the code a host process loads for one plugin package.
 *
 * Usage: `node scripts/release/host-code-hash.ts DIR`, where DIR names a
 * directory under `packages/`. Prints `sha256:` and a hex digest.
 *
 * The release records this value in the OpenClaw channel's published
 * manifest as `sharnessHostCodeHash`. OpenClaw loads the channel and every
 * module the channel's JavaScript reaches, including modules of the
 * `@moltzap/*` siblings it imports, and nothing else of those siblings: the
 * channel imports only the Client root entry, never `./service` or the
 * `sharnessd` binary. A launcher compares two versions' values and restarts
 * OpenClaw only when they differ. The hash therefore covers every packed
 * file of the plugin package, plus each sibling module reachable from it by
 * static or dynamic import through the sibling's `exports` map. Manifests
 * hash without `version`, the recorded hashes, and `@moltzap/*` dependency
 * entries, so a sibling version bump with identical reachable code leaves it
 * unchanged.
 *
 * Run from the repository root after `pnpm build`. Exits 1 when packing or
 * extracting fails.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import {
  digestOf,
  fileEntry,
  packedFiles,
  type PackFailure,
  packInto,
  withScratch,
} from "./content-hash.ts";

/** One file of one package in the module graph. */
export interface Module {
  readonly name: string;
  readonly relative: string;
}

/**
 * Pack `packages/DIR` and its `@moltzap/*` closure and hash the code a host
 * loads for it.
 * @param repo Repository root.
 * @param dir Directory name under `packages/`.
 * @returns The host-code hash, or the step that failed.
 */
export function hostCodeHashOfPackage(
  repo: string,
  dir: string,
): string | PackFailure {
  const directories = workspaceDirectories(repo);
  const host = manifestName(repo, dir);
  return withScratch((scratch) => {
    const roots = new Map<string, string>();
    for (const name of siblingClosure(repo, host, directories)) {
      const sibling = directories.get(name) ?? dir;
      const root = packInto(repo, sibling, scratch);
      if (typeof root !== "string") {
        return root;
      }
      roots.set(name, root);
    }
    return hostCodeHashOfDirectories(host, roots);
  });
}

/**
 * Hash the host package's files and every sibling module they reach.
 * @param host The plugin package's npm name.
 * @param roots Extracted `package/` directory of the host and each sibling.
 * @returns `sha256:` and the hex digest.
 */
export function hostCodeHashOfDirectories(
  host: string,
  roots: ReadonlyMap<string, string>,
): string {
  const hostRoot = roots.get(host) ?? "";
  const seeds = packedFiles(hostRoot).map((relative) => ({
    name: host,
    relative,
  }));
  return digestOf(
    moduleGraph(seeds, roots).map((module) =>
      fileEntry(
        roots.get(module.name) ?? "",
        module.relative,
        `${module.name}/${module.relative}`,
        { siblingPins: "drop" },
      ),
    ),
  );
}

/** Reads a module graph from packed files or a committed source tree. */
export interface ModuleReader {
  readonly read: (file: string) => string;
  readonly locate: (root: string, relative: string) => string | undefined;
  readonly missing?: (specifier: string) => never;
}

const PACKED_READER: ModuleReader = {
  read: (file) => readFileSync(file, "utf8"),
  locate: (root, relative) =>
    existsSync(path.join(root, relative)) ? relative : undefined,
};

/** Follows workspace exports and relative imports without including unrelated sibling modules. */
export function moduleGraph(
  seeds: readonly Module[],
  roots: ReadonlyMap<string, string>,
  reader: ModuleReader = PACKED_READER,
): readonly Module[] {
  const pending = [...seeds];
  const seen = new Map<string, Module>();
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const label = `${next.name}/${next.relative}`;
    if (!seen.has(label)) {
      seen.set(label, next);
      pending.push(
        ...importedModules(next, roots.get(next.name) ?? "", roots, reader),
      );
    }
  }
  return [...seen.values()];
}

function workspaceDirectories(repo: string): ReadonlyMap<string, string> {
  return new Map(
    readdirSync(path.join(repo, "packages"))
      .filter((dir) =>
        existsSync(path.join(repo, "packages", dir, "package.json")),
      )
      .map((dir) => [manifestName(repo, dir), dir] as const),
  );
}

function manifestName(repo: string, dir: string): string {
  return String(readManifest(repo, dir)?.name);
}

/** The package and every `@moltzap/*` package its dependencies reach. */
function siblingClosure(
  repo: string,
  name: string,
  directories: ReadonlyMap<string, string>,
): ReadonlySet<string> {
  const closure = new Set<string>();
  const pending = [name];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const dir = directories.get(next);
    if (closure.has(next) || dir === undefined) {
      continue;
    }
    closure.add(next);
    const dependencies = readManifest(repo, dir)?.dependencies;
    if (typeof dependencies === "object" && dependencies !== null) {
      pending.push(
        ...Object.keys(dependencies).filter((dependency) =>
          directories.has(dependency),
        ),
      );
    }
  }
  return closure;
}

/** The modules a JavaScript file imports that resolve inside `roots`. */
function importedModules(
  module: Module,
  root: string,
  roots: ReadonlyMap<string, string>,
  reader: ModuleReader,
): readonly Module[] {
  if (!/\.[cm]?[jt]s$/u.test(module.relative)) {
    return [];
  }
  const source = reader.read(path.join(root, module.relative));
  return ts
    .preProcessFile(source, true, true)
    .importedFiles.map(({ fileName }) =>
      resolve(module, fileName, roots, reader),
    )
    .filter((target): target is Module => target !== undefined);
}

function resolve(
  from: Module,
  specifier: string,
  roots: ReadonlyMap<string, string>,
  reader: ModuleReader,
): Module | undefined {
  if (specifier.startsWith(".")) {
    const relative = reader.locate(
      rootOf(roots, from.name),
      path.posix.normalize(
        path.posix.join(path.posix.dirname(from.relative), specifier),
      ),
    );
    return relative === undefined ? undefined : { name: from.name, relative };
  }
  const parts = specifier.split("/");
  const count = specifier.startsWith("@") ? 2 : 1;
  const name = parts.slice(0, count).join("/");
  const root = roots.get(name);
  if (root === undefined) {
    return undefined;
  }
  const subpath =
    parts.length > count ? `./${parts.slice(count).join("/")}` : ".";
  const target = exportTarget(root, subpath, reader);
  return resolvedExport({ name, root, target, specifier }, reader);
}

function resolvedExport(
  request: {
    readonly name: string;
    readonly root: string;
    readonly target?: string;
    readonly specifier: string;
  },
  reader: ModuleReader,
): Module | undefined {
  if (request.target === undefined) {
    return undefined;
  }
  const relative = reader.locate(request.root, request.target);
  if (relative === undefined) {
    reader.missing?.(request.specifier);
    return undefined;
  }
  return { name: request.name, relative };
}

/** Conditions are considered in manifest order, matching Node's conditional exports. */
function exportTarget(
  root: string,
  subpath: string,
  reader: ModuleReader,
): string | undefined {
  const exports = readExports(reader.read(path.join(root, "package.json")));
  if (
    typeof exports === "object" &&
    exports !== null &&
    Object.keys(exports).some((key) => key.startsWith("."))
  ) {
    return importCondition(
      Object.entries(exports).find(([key]) => key === subpath)?.[1],
    );
  }
  return subpath === "." ? importCondition(exports) : undefined;
}

function readExports(text: string): unknown {
  const value: unknown = JSON.parse(text);
  return typeof value === "object" && value !== null && "exports" in value
    ? value.exports
    : undefined;
}

function rootOf(roots: ReadonlyMap<string, string>, name: string): string {
  return roots.get(name) ?? "";
}

function importCondition(entry: unknown): string | undefined {
  if (typeof entry === "string") {
    return entry;
  }
  if (Array.isArray(entry)) {
    return entry.map(importCondition).find((target) => target !== undefined);
  }
  if (typeof entry !== "object" || entry === null) {
    return undefined;
  }
  const active = Object.entries(entry).filter(([condition]) =>
    ["import", "sharness-internal", "default"].includes(condition),
  );
  return active
    .map(([, value]) => importCondition(value))
    .find((target) => target !== undefined);
}

function readManifest(
  repo: string,
  dir: string,
): Record<string, unknown> | undefined {
  return readJson(path.join(repo, "packages", dir, "package.json"));
}

function readJson(file: string): Record<string, unknown> | undefined {
  const value: unknown = JSON.parse(readFileSync(file, "utf8"));
  return typeof value === "object" && value !== null
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}

if (import.meta.main) {
  const [dir] = process.argv.slice(2);
  if (dir === undefined) {
    console.error("usage: host-code-hash.ts DIR");
    process.exit(2);
  }
  const hash = hostCodeHashOfPackage(process.cwd(), dir);
  if (typeof hash !== "string") {
    console.error(hash.message);
    process.exit(1);
  }
  console.log(hash);
}
