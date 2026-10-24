#!/usr/bin/env node
/**
 * @file Architecture boundary checks for the final product graph.
 *
 * Shared `packages/*` rules cover wildcard exports and barrel discipline. The
 * final-package contract in `boundary-contract.ts` pins the directory and
 * package names, public entrypoints, binaries, manifest edges, TypeScript
 * references, and required Nx targets for all workspace products. Pass
 * `--nx-graph FILE` to also compare the graph `nx graph --print` resolved.
 *
 * Every rule asserts its input set is non-empty before reporting success. A
 * check that walks nothing passes vacuously and is indistinguishable from no
 * check at all. Run from the repository root; exits 1 on any failure.
 */
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { FINAL_PACKAGE_DIRS, PRIVATE_PLUGINS } from "./boundary-contract.ts";
import {
  checkCompatibilityVersion,
  checkProductManifests,
  checkReleaseSet,
  checkWorkspaceRoots,
} from "./boundary-manifests.ts";
import { checkNxGraphArgument } from "./boundary-nx-graph.ts";
import { type BoundaryRun, failOnSetDrift } from "./boundary-run.ts";
import {
  checkFinalImports,
  checkLayerVocabulary,
  checkSharedSourceRules,
} from "./boundary-sources.ts";

const repo = process.cwd();
const run: BoundaryRun = {
  repo,
  packagesRoot: path.join(repo, "packages"),
  failures: [],
};

const sourceCount = checkSharedSourceRules(run);
failOnSetDrift(run, {
  where: "packages/",
  what: "product directories drifted",
  actual: packageDirectories(run.packagesRoot),
  wanted: FINAL_PACKAGE_DIRS,
});
const vocabularyCount = checkLayerVocabulary(run);
const compatibilityVersion = checkCompatibilityVersion(run);
checkWorkspaceRoots(run);
const publishedVersions = checkProductManifests(run);
checkReleaseSet(run, publishedVersions);
const finalSourceCount = checkFinalImports(run);
checkNxGraphArgument(run, process.argv.slice(2));

if (run.failures.length > 0) {
  console.error("[check-architecture-boundaries] FAIL");
  for (const failure of run.failures) {
    console.error(`  ${failure}`);
  }
  process.exit(1);
}

console.log(
  `[check-architecture-boundaries] OK — ${sourceCount} package/plugin TypeScript sources, ${finalSourceCount} product/plugin code files, exact six-package static graph with ${PRIVATE_PLUGINS.length} private plugins, ${publishedVersions.size} published manifests at ${[...new Set(publishedVersions.values())].join(", ")}, and ${vocabularyCount} Identity/Router non-documentation files scanned at compatibility version ${String(compatibilityVersion)}`,
);

function packageDirectories(packagesRoot: string): readonly string[] {
  if (!existsSync(packagesRoot)) {
    return [];
  }
  return readdirSync(packagesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}
