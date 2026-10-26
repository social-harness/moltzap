#!/usr/bin/env node
/** @file Exercises repository-owned dependency and integration integrity gates through their CLI entry points. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  testGuardIntegrity,
  testIntegrationIntegrityGuards,
} from "./integration-integrity.ts";
import {
  failures,
  plantBoundarySource,
  plantFile,
  restoreAllPlants,
  runNode,
  test,
  workspaceRoot,
} from "./plants.ts";

/** Every mutation is restored even if the gate under test fails. */
function main(): void {
  try {
    testDependencyVersions();
    testIntegrationLintProfile();
    testIntegrationIntegrityGuards();
    testGuardIntegrity();
  } finally {
    restoreAllPlants();
  }
  if (failures.length > 0) {
    console.error(`\n${failures.length} assertion(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll repository gate tests passed.");
}

/** Resolved config protects every tracked fixture and process suite from glob drift. */
function testIntegrationLintProfile(): void {
  const result = runNode(["scripts/__tests__/integration-lint-profile.ts"]);
  test(
    "tracked integration sources resolve strict and integration-test lint profiles",
    result.code === 0,
    result.stderr,
  );
  try {
    plantBoundarySource({
      path: "eslint.shared.ts",
      before:
        'makeStrictBlock(["**/*.ts"], languageOptions, makeStrictRules())',
      after:
        'makeStrictBlock(["src/**/*.ts"], languageOptions, makeStrictRules())',
    });
    const narrowed = runNode(["scripts/__tests__/integration-lint-profile.ts"]);
    test(
      "integration lint gate rejects a narrowed strict-profile glob",
      narrowed.code !== 0 &&
        narrowed.stderr.includes(
          "strict profile must enforce max-lines as error",
        ),
      narrowed.stderr,
    );
  } finally {
    restoreAllPlants();
  }
}

function testDependencyVersions(): void {
  console.log("\n# check-dependency-versions");
  const clean = runDependencyVersions();
  test(
    "clean tree passes the dependency-version gate",
    clean.code === 0,
    `expected exit 0, got ${clean.code}. stderr: ${clean.stderr.slice(0, 300)}`,
  );
  testDependencyVersionsLiteralSpecifier();
  testDependencyVersionsExampleCopy();
  testDependencyVersionsDriftedEngines();
  testDependencyVersionsNodePin();
  testDependencyVersionsActionRefs();
}

function testDependencyVersionsLiteralSpecifier(): void {
  plantFile("packages/router/package.json", (s) =>
    s.replace('"jose": "catalog:"', '"jose": "6.2.6"'),
  );
  const literal = runDependencyVersions();
  test(
    "flags a workspace manifest that writes its own npm version",
    literal.code !== 0 &&
      /router\/package\.json: dependencies\.jose is "6\.2\.6"; declare "catalog:"/.test(
        literal.stderr,
      ),
    `expected catalog failure. exit=${literal.code}, stderr=${literal.stderr.slice(0, 300)}`,
  );
  restoreAllPlants();
}

/** The planted range is not a published version, so no catalog bump can match it. */
function testDependencyVersionsExampleCopy(): void {
  const example =
    /* Safe because the example manifest is repository-owned JSON with a dependencies object. */ JSON.parse(
      readFileSync(
        resolve(workspaceRoot, "examples/two-agents/package.json"),
        "utf8",
      ),
    ) as { dependencies: Record<string, string> };
  const name =
    Object.keys(example.dependencies).find(
      (dependency) => !dependency.startsWith("@moltzap/"),
    ) ?? "";
  plantFile("examples/two-agents/package.json", (s) =>
    s.replace(
      `"${name}": "${example.dependencies[name] ?? ""}"`,
      `"${name}": "0.0.0-drift"`,
    ),
  );
  const drifted = runDependencyVersions();
  test(
    "flags an example dependency that differs from the catalog",
    drifted.code !== 0 &&
      drifted.stderr.includes(
        `two-agents/package.json: dependencies.${name} is "0.0.0-drift", expected the catalog range`,
      ),
    `expected example copy failure for ${name}. exit=${drifted.code}, stderr=${drifted.stderr.slice(0, 300)}`,
  );
  restoreAllPlants();
}

function testDependencyVersionsDriftedEngines(): void {
  plantFile("packages/client/package.json", (s) =>
    s.replace(/"node": "[^"]+"/, '"node": ">=20"'),
  );
  const engines = runDependencyVersions();
  test(
    "flags a published Node.js range that differs from the workspace root",
    engines.code !== 0 &&
      /client\/package\.json: engines\.node is ">=20", expected the root/.test(
        engines.stderr,
      ),
    `expected engines failure. exit=${engines.code}, stderr=${engines.stderr.slice(0, 300)}`,
  );
  restoreAllPlants();
}

/** Node.js 0.0.0 lies below the floor of any supported range. */
function testDependencyVersionsNodePin(): void {
  plantFile(".node-version", () => "0.0.0\n");
  const pin = runDependencyVersions();
  test(
    "flags a Node.js pin outside the supported range",
    pin.code !== 0 &&
      pin.stderr.includes(
        ".node-version: 0.0.0 is outside the root engines.node range",
      ),
    `expected Node pin failure. exit=${pin.code}, stderr=${pin.stderr.slice(0, 300)}`,
  );
  restoreAllPlants();
}

function testDependencyVersionsActionRefs(): void {
  plantFile(".github/workflows/publish.yml", (s) =>
    s.replace(/actions\/checkout@\S+/, "actions/checkout@v7"),
  );
  const action = runDependencyVersions();
  test(
    "flags an action used at two refs",
    action.code !== 0 &&
      /actions\/checkout: used at 2 refs/.test(action.stderr),
    `expected action ref failure. exit=${action.code}, stderr=${action.stderr.slice(0, 300)}`,
  );
  restoreAllPlants();
}

function runDependencyVersions(): {
  code: number;
  stderr: string;
} {
  return runNode([
    resolve(workspaceRoot, "scripts/repo/check-dependency-versions.ts"),
  ]);
}

main();
