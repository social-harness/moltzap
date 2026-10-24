/** @file Test-integrity plants for integration fixtures and scan roots. */
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";

import { INTEGRATION_INTEGRITY_CASES } from "./integration-boundary-cases.ts";
import { plantBoundarySource, plantFile, restoreAllPlants } from "./plants.ts";

type GateAssertion = (name: string, passed: boolean, message: string) => void;

/**
 * Runs the guard and lane integrity checks that live outside the plant tables.
 * @param test Records one gate assertion.
 * @param workspaceRoot Repository root.
 */
export function testGuardIntegrity(
  test: GateAssertion,
  workspaceRoot: string,
): void {
  testMissingGuardDirectory(test, workspaceRoot);
  testPragmaPathIsData(test, workspaceRoot);
  testIntegrationLaneCollection(test, workspaceRoot);
}

/** Test-integrity guards cover spies and synthetic literals in fixtures and tests. */
export function testIntegrationIntegrityGuards(
  test: GateAssertion,
  workspaceRoot: string,
): void {
  for (const {
    name,
    path,
    source,
    diagnostic,
  } of INTEGRATION_INTEGRITY_CASES) {
    console.log(`\n# integration ${name}`);
    try {
      plantFile(path, (text) => text + source);
      const result = runSloppyGuard(workspaceRoot);
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
function testMissingGuardDirectory(
  test: GateAssertion,
  workspaceRoot: string,
): void {
  try {
    plantBoundarySource({
      path: "scripts/code/sloppy-code-guard.sh",
      before: '"packages/ tests/"',
      after: '"packages/ tests/integration/missing-guard-root/"',
    });
    const result = runSloppyGuard(workspaceRoot);
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
 * @param test Records one gate assertion.
 * @param workspaceRoot Repository root the guard runs from.
 */
function testPragmaPathIsData(
  test: GateAssertion,
  workspaceRoot: string,
): void {
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
    const result = runSloppyGuard(workspaceRoot);
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
 * @param test Records one gate assertion.
 * @param workspaceRoot Repository root.
 */
function testIntegrationLaneCollection(
  test: GateAssertion,
  workspaceRoot: string,
): void {
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

/** Both integrity tables and focused regressions run the same guard invocation. */
function runSloppyGuard(workspaceRoot: string) {
  return spawnSync("/bin/bash", ["scripts/code/sloppy-code-guard.sh"], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });
}
