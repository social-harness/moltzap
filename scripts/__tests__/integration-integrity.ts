/** @file Test-integrity plants for integration fixtures and scan roots. */
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";

import { INTEGRATION_INTEGRITY_CASES } from "./integration-boundary-cases.ts";
import {
  plantBoundarySource,
  plantFile,
  restoreAllPlants,
  test,
  workspaceRoot,
} from "./plants.ts";

/**
 * Runs the guard and lane integrity checks that live outside the plant tables.
 */
export function testGuardIntegrity(): void {
  testMissingGuardDirectory();
  testBrokenGuardTool();
  testBrokenGuardFilters();
  testPragmaPathIsData();
  testIntegrationLaneCollection();
}

/** Test-integrity guards cover spies and synthetic literals in fixtures and tests. */
export function testIntegrationIntegrityGuards(): void {
  for (const {
    name,
    path,
    source,
    diagnostic,
  } of INTEGRATION_INTEGRITY_CASES) {
    console.log(`\n# integration ${name}`);
    try {
      plantFile(path, (text) =>
        Buffer.concat([
          Buffer.from(text),
          typeof source === "string" ? Buffer.from(source) : source,
        ]),
      );
      const result = runSloppyGuard();
      test(
        `integration ${name} rejects its planted regression`,
        result.status === 1 && diagnostic.test(result.stdout),
        result.stdout + result.stderr,
      );
    } finally {
      restoreAllPlants();
    }
  }
}

/** A missing scan root must fail rather than report a clean scan. */
function testMissingGuardDirectory(): void {
  try {
    plantBoundarySource({
      path: "scripts/code/sloppy-code-guard.sh",
      before: '"packages/ tests/"',
      after: '"packages/ tests/integration/missing-guard-root/"',
    });
    const result = runSloppyGuard();
    test(
      "integrity guard refuses a missing directory",
      result.status === 1 &&
        result.stderr.includes(
          "Directory does not exist: tests/integration/missing-guard-root/",
        ),
      result.stdout + result.stderr,
    );
  } finally {
    restoreAllPlants();
  }
}

/**
 * A pragma line is read as data even when its file name carries shell syntax.
 *
 * Value: protects=sloppy-code-guard reads a next-line pragma from a file whose path contains quotes and command substitution without running it; fails_when=filter_pragma reads the previous line through a shell command again; why_new=every other plant uses plain paths, where a shell read gives the same answer; seam=none; no_claim=the pragma grammar or which rules accept pragmas.
 */
function testPragmaPathIsData(): void {
  const marker = resolve(workspaceRoot, "pragma-path-ran");
  try {
    plantFile(
      'tests/integration/pragma"$(touch pragma-path-ran)".ts',
      () =>
        "// #ignore-sloppy-code-next-line[hardcoded-api-key]: synthetic pragma plant\n" +
        'const apiKey = "' +
        "synthetic".repeat(4) +
        '";\n',
    );
    const result = runSloppyGuard();
    test(
      "integrity guard reads a pragma without running its file name",
      result.status === 0 &&
        !result.stdout.includes("[hardcoded-api-key]") &&
        !existsSync(marker),
      result.stdout + result.stderr,
    );
  } finally {
    rmSync(marker, { force: true });
    restoreAllPlants();
  }
}

/**
 * The process lane collects only its own suites.
 *
 * Value: protects=@moltzap/integration-tests:test:integration collects exactly the suites under tests/integration outside mixed-release/; fails_when=its include or exclude lets Vitest collect files through node_modules links to product packages or from mixed-release/; why_new=a lane run stays green whenever linked product suites happen to pass; seam=none; no_claim=which suites the lane holds or whether they pass.
 */
function testIntegrationLaneCollection(): void {
  const lane = resolve(workspaceRoot, "tests/integration");
  const result = spawnSync(
    process.execPath,
    [
      resolve(lane, "node_modules/vitest/vitest.mjs"),
      "list",
      "--filesOnly",
      "--config",
      "vitest.integration.config.ts",
    ],
    { cwd: lane, encoding: "utf8" },
  );
  const files = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.endsWith(".integration.test.ts"));
  test(
    "integration lane collects only its own suites",
    result.status === 0 &&
      files.length > 0 &&
      files.every(
        (file) =>
          !file.includes("node_modules/") && !file.includes("mixed-release/"),
      ),
    result.stdout + result.stderr,
  );
}

/** A broken expression is a tooling failure, never evidence of a clean tree. */
function testBrokenGuardTool(): void {
  try {
    plantBoundarySource({
      path: "scripts/code/sloppy-code-guard.sh",
      before: "'[^.]*[^q]\\.query\\(|db\\.query\\('",
      after: "'['",
    });
    const result = runSloppyGuard();
    test(
      "integrity guard fails closed on a broken grep expression",
      result.status !== 0 && result.stderr.includes("[raw-sql] grep failed"),
      result.stdout + result.stderr,
    );
  } finally {
    restoreAllPlants();
  }
}

/** Each stage after the search breaks the same way a broken search expression does. */
const BROKEN_GUARD_FILTERS = [
  {
    stage: "exclude filter",
    before:
      "NON_TEST_EXCLUDE='^[^:]*(__tests__|\\.test\\.|test-utils|/dist/)[^:]*:'",
    after: "NON_TEST_EXCLUDE='['",
  },
  {
    stage: "pragma filter",
    before: "function has_pragma(text,",
    after: "function has_pragma((text,",
  },
] as const;

/**
 * A broken exclude or pragma stage is a tooling failure, never evidence of a clean tree.
 *
 * Value: protects=sloppy-code-guard exits nonzero and names the stage when its exclude grep or pragma awk program fails; fails_when=either stage's failure status is discarded so its empty output reads as no violations; why_new=testBrokenGuardTool breaks only the first grep, whose handling is separate; seam=none; no_claim=which lines either stage removes.
 */
function testBrokenGuardFilters(): void {
  for (const { stage, before, after } of BROKEN_GUARD_FILTERS) {
    try {
      plantBoundarySource({
        path: "scripts/code/sloppy-code-guard.sh",
        before,
        after,
      });
      const result = runSloppyGuard();
      test(
        `integrity guard fails closed on a broken ${stage}`,
        result.status !== 0 &&
          result.stderr.includes(`[raw-sql] ${stage} failed`),
        result.stdout + result.stderr,
      );
    } finally {
      restoreAllPlants();
    }
  }
}

/** Both integrity tables and focused regressions run the same guard invocation. */
function runSloppyGuard() {
  return spawnSync("/bin/bash", ["scripts/code/sloppy-code-guard.sh"], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });
}
