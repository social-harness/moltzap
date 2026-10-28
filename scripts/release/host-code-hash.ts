#!/usr/bin/env node
/**
 * @file Hash of the code a host process loads for one plugin package.
 *
 * Usage: `node scripts/release/host-code-hash.ts DIR`, where DIR names a
 * repository-relative package directory. Prints `sha256:` and a hex digest.
 *
 * The release records this value in the OpenClaw channel's published
 * manifest as `sharnessHostCodeHash`. OpenClaw loads the channel and every
 * module the channel's JavaScript reaches, including modules of the
 * workspace siblings it imports, and nothing else of those siblings: the
 * channel imports only the Client root entry, never `./service` or the
 * `sharnessd` binary. A launcher compares two versions' values and restarts
 * OpenClaw only when they differ. The hash therefore covers every packed
 * file of the plugin package, plus each sibling module reachable from it by
 * static or dynamic import through the sibling's `exports` map. Manifests
 * hash without `version`, the recorded hashes, and workspace dependency
 * entries, so a sibling version bump with identical reachable code leaves it
 * unchanged.
 *
 * Run from the repository root after `pnpm build`. Exits 1 when packing or
 * extracting fails.
 */

import { Either } from "effect";
import { readFileSync } from "node:fs";
import path from "node:path";
import { workspacePackages } from "../repo/packages.ts";
import {
  digestOf,
  fileEntry,
  packedFiles,
  type PackFailure,
  packInto,
  withScratch,
} from "./content-hash.ts";
import { moduleGraph } from "./module-graph.ts";

/**
 * Pack `DIR` and its workspace dependency closure and hash the code a host
 * loads for it.
 * @param repo Repository root.
 * @param dir Repository-relative package directory.
 * @returns The host-code hash, or the step that failed.
 */
export function hostCodeHashOfPackage(
  repo: string,
  dir: string,
): string | PackFailure {
  const directories = workspaceDirectories(repo);
  if (!(directories instanceof Map)) {
    return directories;
  }
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
    return hostCodeHashOfDirectories(host, roots, new Set(directories.keys()));
  });
}

/**
 * Hash the host package's files and every sibling module they reach.
 * @param host The plugin package's npm name.
 * @param roots Extracted `package/` directories in the host's runtime dependency closure.
 * @param workspaceNames All workspace package names, whose pins are omitted in every dependency section.
 * @returns `sha256:` and the hex digest.
 */
export function hostCodeHashOfDirectories(
  host: string,
  roots: ReadonlyMap<string, string>,
  workspaceNames: ReadonlySet<string>,
): string {
  const hostRoot = roots.get(host) ?? "";
  const seeds = packedFiles(hostRoot).map((relative) => ({
    name: host,
    relative,
  }));
  return digestOf(
    moduleGraph(seeds, roots, {
      conditions: ["node", "module-sync", "import", "default"],
      all: false,
    }).map((module) =>
      fileEntry(
        roots.get(module.name) ?? "",
        module.relative,
        `${module.name}/${module.relative}`,
        { kind: "drop", names: workspaceNames },
      ),
    ),
  );
}

/** Inventory and manifest decoding failures use the CLI's existing failure channel. */
function workspaceDirectories(repo: string): Map<string, string> | PackFailure {
  return Either.match(
    Either.try({
      try: () => packageDirectories(repo),
      catch: (cause): PackFailure => ({
        kind: "pack-failed",
        message: String(cause),
      }),
    }),
    { onLeft: (failure) => failure, onRight: (directories) => directories },
  );
}

function packageDirectories(repo: string): Map<string, string> | PackFailure {
  const directories = new Map<string, string>();
  for (const { dir, name } of workspacePackages(repo)) {
    if (directories.has(name)) {
      return {
        kind: "pack-failed",
        message: `Duplicate workspace package name ${name} in ${dir}/package.json`,
      };
    }
    directories.set(name, dir);
  }
  return directories;
}

function manifestName(repo: string, dir: string): string {
  return String(readManifest(repo, dir)?.name);
}

/** The package and every workspace dependency it reaches. */
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

function readManifest(
  repo: string,
  dir: string,
): Record<string, unknown> | undefined {
  return readJson(path.join(repo, dir, "package.json"));
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
    process.stderr.write("usage: host-code-hash.ts DIR\n");
    process.exit(2);
  }
  const hash = hostCodeHashOfPackage(process.cwd(), dir);
  if (typeof hash !== "string") {
    process.stderr.write(`${hash.message}\n`);
    process.exit(1);
  }
  process.stdout.write(`${hash}\n`);
}
