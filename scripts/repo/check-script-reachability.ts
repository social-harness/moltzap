#!/usr/bin/env node
/**
 * @file Finds scripts with no reference in the tracked repository.
 *
 * Repository-relative paths and sibling relative imports count as references.
 * Prose counts because it can lead a reader to a manually invoked tool.
 * The gate's own fixtures and allowlist do not count as references.
 * Exits 1 for an unreferenced script or a stale allowlist entry, otherwise 0.
 */
import { execFileSync } from "node:child_process";
import { basename, dirname } from "node:path";

/**
 * Manual entry points without a repository reference need a reason naming
 * who runs them and when. Entries fail once referenced or removed.
 */
const ALLOWLIST: ReadonlyMap<string, string> = new Map();

/**
 * Resolve Git paths from the repository root even when invoked inside a
 * package, where a relative `scripts/` path would inspect the wrong directory.
 */
// eslint-disable-next-line sonarjs/no-os-command-from-path -- Developer tooling intentionally resolves installed commands through the caller’s PATH.
const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim();

function main(): void {
  const scripts = trackedScripts();
  const unreachable: string[] = [];
  const staleAllowlist: string[] = [];
  collectReachabilityFailures(scripts, unreachable, staleAllowlist);
  if (unreachable.length === 0 && staleAllowlist.length === 0) {
    console.log(
      `[check-script-reachability] PASS — ${scripts.length} script(s) reachable ` +
        `(${ALLOWLIST.size} allowlisted entry point(s)).`,
    );
    process.exit(0);
  }
  console.error("[check-script-reachability] FAIL\n");
  for (const path of unreachable) {
    console.error(`  ${path}`);
    console.error(
      "    → nothing references it. Wire it into package.json, an Nx target, a " +
        "hook, a workflow, or a sibling script; document it where a reader will " +
        "look; or delete it. If it is a standalone entry point, add it to " +
        "ALLOWLIST in this file with a reason.\n",
    );
  }
  for (const path of staleAllowlist) {
    console.error(`  ${path}  [stale allowlist entry]`);
    console.error(
      "    → it is now referenced, or no longer exists. Remove it from " +
        "ALLOWLIST.\n",
    );
  }
  process.exit(1);
}

function trackedScripts(): readonly string[] {
  return git(["ls-files", "scripts"])
    .split("\n")
    .filter((p) => p.length > 0 && !p.startsWith("scripts/__tests__/"));
}

function collectReachabilityFailures(
  scripts: readonly string[],
  unreachable: string[],
  staleAllowlist: string[],
): void {
  for (const path of scripts) {
    const referenced = isReferenced(path);
    if (ALLOWLIST.has(path)) {
      if (referenced) {
        staleAllowlist.push(path);
      }
      continue;
    }
    if (!referenced) {
      unreachable.push(path);
    }
  }
  collectMissingAllowlistEntries(scripts, staleAllowlist);
}

/**
 * True when any tracked file other than `path` mentions it by its repo-relative
 * path, or a sibling in its directory imports it as `./&lt;name>`. A sibling
 * import makes a module reachable through whatever reaches that sibling.
 */
function isReferenced(path: string): boolean {
  return [
    ...gitGrepFiles(path),
    ...gitGrepFiles(`./${basename(path)}`, `:(glob)${dirname(path)}/*`),
  ].some((f) => f.length > 0 && f !== path);
}

/**
 * `git grep` exits 1 to mean "no match", which `execFileSync` raises as an
 * error. Only that exit code is benign; anything else is a real failure and
 * must not be swallowed into a false "unreferenced" verdict.
 *
 * This file is excluded from its own search: it names every allowlisted path,
 * so counting it as a reference would make each allowlist entry
 * self-justifying.
 */
function gitGrepFiles(needle: string, scope = "."): readonly string[] {
  try {
    return git([
      "grep",
      "--fixed-strings",
      "--files-with-matches",
      needle,
      "--",
      scope,
      ":(exclude)scripts/__tests__",
      ":(exclude)scripts/repo/check-script-reachability.ts",
    ]).split("\n");
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "status" in error &&
      error.status === 1
    ) {
      return [];
    }
    throw error;
  }
}

function git(args: readonly string[]): string {
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- Developer tooling intentionally resolves installed commands through the caller’s PATH.
  return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" });
}

function collectMissingAllowlistEntries(
  scripts: readonly string[],
  staleAllowlist: string[],
): void {
  for (const path of ALLOWLIST.keys()) {
    if (!scripts.includes(path)) {
      staleAllowlist.push(path);
    }
  }
}

main();
