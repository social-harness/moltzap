/** @file Process test-lane collection check. */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { test, workspaceRoot } from "./plants.ts";

/**
 * The process lane collects only its own suites.
 *
 * Value: protects=@moltzap/integration-tests:test:integration collects exactly the suites under tests/integration outside mixed-release/; fails_when=its include or exclude lets Vitest collect files through node_modules links to product packages or from mixed-release/; why_new=a lane run stays green whenever linked product suites happen to pass; seam=none; no_claim=which suites the lane holds or whether they pass.
 */
export function testIntegrationLaneCollection(): void {
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
