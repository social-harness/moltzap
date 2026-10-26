#!/usr/bin/env node
/** @file Exercises repository-owned architecture, publication, and dependency gates through their CLI entry points. */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  INTEGRATION_BOUNDARY_CASES,
  MALFORMED_BOUNDARY_CASES,
} from "./integration-boundary-cases.ts";
import { testIntegrationGraph } from "./integration-boundary-graph.ts";
import {
  testGuardIntegrity,
  testIntegrationIntegrityGuards,
} from "./integration-integrity.ts";
import {
  failures,
  plantBoundarySource,
  plantFile,
  plantSymlink,
  restoreAllPlants,
  runNode,
  test,
  workspaceRoot,
} from "./plants.ts";

const WIRE_VERSION_SOURCE = "packages/client/src/identity/wire-version.ts";

/** The head of version.ts's live window, after which planted entries go. */
const LIVE_WINDOW_HEAD = /const liveWindow = \[WIRE_VERSION/u;
/** The head of version.ts's retired list, after which planted entries go. */
const RETIRED_HEAD = /const RETIRED_WIRE_VERSIONS = \[/u;

/** Every mutation is restored even if the gate under test fails. */
function main(): void {
  try {
    testPublicationGuards();
    testCalendarWireSets();
    testNonCalendarLiveEntry();
    testNonCalendarRetainedEntry();
    testDependencyVersions();
    testMalformedBoundaryInputs();
    testIntegrationBoundaries();
    testIntegrationAgentInstructionsLink();
    testIntegrationGraph();
    testIntegrationLintProfile();
    testIntegrationIntegrityGuards();
    testGuardIntegrity();
    testIsolatedFolderImports();
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

function testPublicationGuards(): void {
  testPublicationGuardsClean();
  testPublicationGuardsPublicNanoClaw();
  testPublicationGuardsPrivateIdentity();
  testPublicationGuardsWrongLicense();
  testPublicationGuardsDriftedNotice();
  testPublicationGuardsForeignRepository();
  testPublicationGuardsSemver();
  testPublicationGuardsWireSemver();
  testManifestWireVersion();
  testPublicationGuardsDriftedList();
  testPublicationGuardsTestOnly();
  testPublicationGuardsNamespaceExport();
}

/** Test overrides require an explicit condition and cannot enter production source. */
function testPublicationGuardsTestOnly(): void {
  plantFile("packages/client/package.json", (source) =>
    source.replace('"sharness-test": {', '"default": {'),
  );
  const unconditional = runBoundaries();
  test(
    "rejects a test override exposed to production resolution",
    unconditional.code !== 0 &&
      /test-only export.*conditions drifted/.test(unconditional.stderr),
    `expected conditional-export failure. exit=${unconditional.code}, stderr=${unconditional.stderr.slice(0, 300)}`,
  );
  restoreAllPlants();
  plantFile(
    "packages/client/src/communication/conversations/index.ts",
    (source) =>
      'import { WireVersions } from "@moltzap/client/test";\n' + source,
  );
  const production = runBoundaries();
  test(
    "rejects a production import of the test override",
    production.code !== 0 &&
      /production source must not import test-only export/.test(
        production.stderr,
      ),
    `expected production-import failure. exit=${production.code}, stderr=${production.stderr.slice(0, 300)}`,
  );
  restoreAllPlants();
}

/** Namespace wildcard exports expose the same unbounded surface as bare wildcards. */
function testPublicationGuardsNamespaceExport(): void {
  plantFile(
    "packages/client/src/index.ts",
    (source) =>
      source +
      '\nexport * as RegistryApi from "./identity/registry/contract.js";\n',
  );
  const wildcard = runBoundaries();
  test(
    "rejects a namespace wildcard export",
    wildcard.code !== 0 &&
      /wildcard export is not allowed/.test(wildcard.stderr),
    `expected namespace-wildcard failure. exit=${wildcard.code}, stderr=${wildcard.stderr.slice(0, 300)}`,
  );
  restoreAllPlants();
}

function testPublicationGuardsClean(): void {
  console.log("\n# check-boundaries publication guards");
  const clean = runBoundaries();
  test(
    "clean tree passes the publication guards",
    clean.code === 0,
    `expected exit 0, got ${clean.code}. stderr: ${clean.stderr.slice(0, 300)}`,
  );
  plantFile("packages/openclaw-channel/package.json", (s) =>
    s.replace(
      '"@moltzap/client": "workspace:*"',
      '"@moltzap/client": "workspace:^"',
    ),
  );
  const loosePin = runBoundaries();
  test(
    "flags a sibling dependency that pack would not pin exactly",
    loosePin.code !== 0 &&
      /final dependency "@moltzap\/client" must be declared as "workspace:\*"/.test(
        loosePin.stderr,
      ),
    `expected exact-pin failure. exit=${loosePin.code}, stderr=${loosePin.stderr.slice(0, 300)}`,
  );
  restoreAllPlants();
  plantFile("packages/openclaw-channel/package.json", (s) =>
    s.replace(/"version": "[^"]+"/, '"version": "2026.101.0"'),
  );
  const ownVersion = runBoundaries();
  test(
    "accepts published packages at their own calendar versions",
    ownVersion.code === 0,
    `expected exit 0, got ${ownVersion.code}. stderr: ${ownVersion.stderr.slice(0, 300)}`,
  );
  restoreAllPlants();
}

function testPublicationGuardsPublicNanoClaw(): void {
  plantFile("packages/nanoclaw-channel/package.json", (s) =>
    // eslint-disable-next-line sonarjs/slow-regex -- The input is bounded, repository-owned documentation or a fixed test fixture.
    s.replace(/\s*"private": true,/, ""),
  );
  const publicNanoClaw = runBoundaries();
  test(
    "flags NanoClaw losing its private flag",
    publicNanoClaw.code !== 0 &&
      /nanoclaw-channel\/package\.json: must stay private/.test(
        publicNanoClaw.stderr,
      ),
    `expected NanoClaw-private failure. exit=${publicNanoClaw.code}, stderr=${publicNanoClaw.stderr.slice(0, 300)}`,
  );
  restoreAllPlants();
}

function testPublicationGuardsPrivateIdentity(): void {
  plantFile("packages/client/package.json", (s) =>
    s.replace('"version"', '"private": true,\n  "version"'),
  );
  const privateIdentity = runBoundaries();
  test(
    "flags a published package that carries private",
    privateIdentity.code !== 0 &&
      /client\/package\.json: a published package must not carry "private"/.test(
        privateIdentity.stderr,
      ),
    `expected published-private failure. exit=${privateIdentity.code}, stderr=${privateIdentity.stderr.slice(0, 300)}`,
  );
  restoreAllPlants();
}

function testPublicationGuardsWrongLicense(): void {
  plantFile("packages/client/package.json", (s) =>
    s.replace('"license": "Apache-2.0"', '"license": "MIT"'),
  );
  const wrongLicense = runBoundaries();
  test(
    "flags a published package with another license",
    wrongLicense.code !== 0 &&
      /client\/package\.json: license is "MIT"/.test(wrongLicense.stderr),
    `expected license failure. exit=${wrongLicense.code}, stderr=${wrongLicense.stderr.slice(0, 300)}`,
  );
  restoreAllPlants();
}

function testPublicationGuardsDriftedNotice(): void {
  plantFile("packages/client/NOTICE", (s) => `${s}Extra line.\n`);
  const driftedNotice = runBoundaries();
  test(
    "flags a packaged NOTICE that differs from the repository NOTICE",
    driftedNotice.code !== 0 &&
      /client\/NOTICE: must be an identical copy/.test(driftedNotice.stderr),
    `expected NOTICE drift failure. exit=${driftedNotice.code}, stderr=${driftedNotice.stderr.slice(0, 300)}`,
  );
  restoreAllPlants();
}

function testPublicationGuardsForeignRepository(): void {
  plantFile("packages/client/package.json", (s) =>
    s.replace(
      "git+https://github.com/social-harness/moltzap.git",
      "https://example.invalid/fork.git",
    ),
  );
  const foreignRepository = runBoundaries();
  test(
    "flags a published package pointing at another repository",
    foreignRepository.code !== 0 &&
      /client\/package\.json: repository\.url must be/.test(
        foreignRepository.stderr,
      ),
    `expected repository failure. exit=${foreignRepository.code}, stderr=${foreignRepository.stderr.slice(0, 300)}`,
  );
  restoreAllPlants();
}

function testPublicationGuardsSemver(): void {
  plantFile("packages/client/package.json", (s) =>
    s.replace(/"version": "[^"]+"/, '"version": "1.2.3"'),
  );
  const semver = runBoundaries();
  test(
    "flags a published manifest whose version is not a calendar version",
    semver.code !== 0 &&
      /client\/package\.json: version "1\.2\.3" is not a YYYY\.MDD\.N CalVer/.test(
        semver.stderr,
      ),
    `expected calver failure. exit=${semver.code}, stderr=${semver.stderr.slice(0, 300)}`,
  );
  restoreAllPlants();
}

/** Published wire metadata must describe the artifacts the package emits. */
function testManifestWireVersion(): void {
  plantFile("packages/client/package.json", (source) =>
    source.replace(
      /"sharnessWireVersion": "[^"]+"/,
      '"sharnessWireVersion": "2099.101.0"',
    ),
  );
  const result = runBoundaries();
  test(
    "rejects Client manifest wire metadata that differs from WIRE_VERSION",
    result.code === 1 &&
      /sharnessWireVersion must equal WIRE_VERSION/.test(result.stderr),
    `expected wire metadata rejection. exit=${result.code}, stderr=${result.stderr}`,
  );
  restoreAllPlants();
}

function testPublicationGuardsWireSemver(): void {
  plantFile(WIRE_VERSION_SOURCE, withCompatibilityVersion("1.2.3"));
  const wireSemver = runBoundaries();
  test(
    "flags a wire compatibility literal that is not a calendar version",
    wireSemver.code !== 0 &&
      /WIRE_VERSION "1\.2\.3" is not a YYYY\.MDD\.N CalVer/.test(
        wireSemver.stderr,
      ),
    `expected wire-literal failure. exit=${wireSemver.code}, stderr=${wireSemver.stderr.slice(0, 300)}`,
  );
  restoreAllPlants();
}

/** Each mutation runs the real gate in a fresh process so version sets are evaluated anew. */
function testCalendarWireSets(): void {
  plantFile(WIRE_VERSION_SOURCE, (source) =>
    insertAfter(
      insertAfter(source, LIVE_WINDOW_HEAD, ', "2099.1023.1"'),
      RETIRED_HEAD,
      '"2098.1231.12", ',
    ),
  );
  const calendar = runBoundaries();
  test(
    "accepts calendar live and retained entries",
    calendar.code === 0 &&
      isDeepStrictEqual(calendar.stderr.trim().split("\n").filter(Boolean), []),
    `expected no failures. exit=${calendar.code}, stderr=${calendar.stderr}`,
  );
  restoreAllPlants();
}

function testNonCalendarLiveEntry(): void {
  plantFile(WIRE_VERSION_SOURCE, (source) =>
    insertAfter(source, LIVE_WINDOW_HEAD, ', "invalid"'),
  );
  const live = runBoundaries();
  test(
    "rejects a non-calendar live entry",
    live.code === 1 &&
      isDeepStrictEqual(live.stderr.trim().split("\n"), [
        "[check-architecture-boundaries] FAIL",
        '  packages/client/src/identity/wire-version.ts: LIVE_WIRE_VERSIONS entry "invalid" is not a YYYY.MDD.N CalVer',
        '  packages/client/src/identity/wire-version.ts: HISTORY_WIRE_VERSIONS entry "invalid" is not a YYYY.MDD.N CalVer',
      ]),
    `expected exactly the live and inherited history failures. exit=${live.code}, stderr=${live.stderr}`,
  );
  restoreAllPlants();
}

function testNonCalendarRetainedEntry(): void {
  plantFile(WIRE_VERSION_SOURCE, (source) =>
    insertAfter(source, RETIRED_HEAD, '"1.2.3", '),
  );
  const retained = runBoundaries();
  test(
    "rejects a non-calendar retained entry",
    retained.code === 1 &&
      isDeepStrictEqual(retained.stderr.trim().split("\n"), [
        "[check-architecture-boundaries] FAIL",
        '  packages/client/src/identity/wire-version.ts: HISTORY_WIRE_VERSIONS entry "1.2.3" is not a YYYY.MDD.N CalVer',
      ]),
    `expected exactly the retained history failure. exit=${retained.code}, stderr=${retained.stderr}`,
  );
  restoreAllPlants();
}

function testPublicationGuardsDriftedList(): void {
  plantFile(".github/workflows/publish.yml", (s) =>
    // eslint-disable-next-line sonarjs/slow-regex -- The input is bounded, repository-owned documentation or a fixed test fixture.
    s.replace(/^(\s*RELEASE_PACKAGES:\s*).+$/m, "$1identity router"),
  );
  const driftedList = runBoundaries();
  test(
    "flags a release package list that drifted from the published set",
    driftedList.code !== 0 &&
      /RELEASE_PACKAGES drifted from the published set/.test(
        driftedList.stderr,
      ),
    `expected release-list failure. exit=${driftedList.code}, stderr=${driftedList.stderr.slice(0, 300)}`,
  );
  restoreAllPlants();
  plantFile(".github/workflows/publish.yml", (source) =>
    // eslint-disable-next-line sonarjs/slow-regex -- The input is bounded, repository-owned workflow text.
    source.replace(/^(\s*RELEASE_PACKAGES:\s*).+$/m, "$& registry"),
  );
  const privatePackage = runBoundaries();
  test(
    "rejects a private package in the release list",
    privatePackage.code !== 0 &&
      /RELEASE_PACKAGES drifted from the published set/.test(
        privatePackage.stderr,
      ),
    `expected private release-list failure. exit=${privatePackage.code}, stderr=${privatePackage.stderr.slice(0, 300)}`,
  );
  restoreAllPlants();
}

/** Each plant must fail the public gate even without a resolved Nx graph. */
function testIntegrationBoundaries(): void {
  console.log("\n# check-boundaries integration workspace");
  runBoundaryPlants(INTEGRATION_BOUNDARY_CASES);
}

/** Scoped agent instructions are the one link the integration tree accepts. */
function testIntegrationAgentInstructionsLink(): void {
  try {
    plantFile("tests/integration/AGENTS.md", () => "# Integration tests\n");
    plantSymlink("tests/integration/CLAUDE.md", "AGENTS.md");
    const result = runBoundaries();
    test(
      "accepts a CLAUDE.md link to its sibling AGENTS.md",
      result.code === 0,
      `expected exit 0, got ${result.code}. stderr: ${result.stderr.slice(0, 300)}`,
    );
  } finally {
    restoreAllPlants();
  }
}

/** Malformed additions must fail even when every valid entry remains present. */
function testMalformedBoundaryInputs(): void {
  console.log("\n# check-boundaries malformed inputs");
  runBoundaryPlants(
    MALFORMED_BOUNDARY_CASES.map((input) => ({
      ...input,
      message: /Malformed/,
    })),
  );
}

/** Each mutation must be rejected by the rule named in its diagnostic. */
function runBoundaryPlants(
  cases: ReadonlyArray<{
    readonly name?: string;
    readonly path: string;
    readonly before?: string;
    readonly after?: string;
    readonly prepend?: string;
    readonly replace?: string;
    readonly symlink?: string;
    readonly message: RegExp;
  }>,
): void {
  for (const [index, input] of cases.entries()) {
    try {
      if (input.symlink !== undefined) {
        plantSymlink(input.path, input.symlink);
      } else {
        plantBoundarySource(input);
      }
      const result = runBoundaries();
      test(
        input.name ??
          `rejects malformed boundary input ${index + 1}: ${input.path}`,
        result.code === 1 && input.message.test(result.stderr),
        `expected boundary rejection. exit=${result.code}, stderr=${result.stderr}`,
      );
    } finally {
      restoreAllPlants();
    }
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

/** Real TypeScript resolution distinguishes sibling escapes from imports within an isolated folder. */
function testIsolatedFolderImports(): void {
  console.log("\n# isolated-folder-import");
  const fixture = mkdtempSync(resolve(tmpdir(), "architecture-isolation-"));
  try {
    mkdirSync(resolve(fixture, "src/launcher"), { recursive: true });
    writeFileSync(
      resolve(fixture, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext" },
        include: ["src/**/*.ts"],
      }),
    );
    writeFileSync(
      resolve(fixture, "safer-architecture.config.json"),
      JSON.stringify({
        isolatedFolders: [
          { folder: "src/launcher", reason: "Independent launcher" },
        ],
      }),
    );
    const dependency = "/** Shared value. */\nexport const value = 1;\n";
    writeFileSync(resolve(fixture, "src/sibling.ts"), dependency);
    writeFileSync(resolve(fixture, "src/launcher/local.ts"), dependency);
    const entry = resolve(fixture, "src/launcher/index.ts");
    const command = resolve(
      workspaceRoot,
      "scripts/architecture/check-package.ts",
    );
    writeFileSync(entry, 'export { value } from "../sibling.js";\n');
    const outside = runNode([command, fixture]);
    test(
      "rejects an isolated folder import of a sibling outside it",
      outside.code === 1 &&
        outside.stdout.includes(
          "error isolated-folder-import src/launcher/index.ts imports src/sibling.ts outside src/launcher",
        ),
      `expected isolated-folder finding. exit=${outside.code}, stdout=${outside.stdout}, stderr=${outside.stderr}`,
    );
    writeFileSync(entry, 'export { value } from "./local.js";\n');
    const inside = runNode([command, fixture]);
    test(
      "accepts imports confined to the isolated folder",
      inside.code === 0 && inside.stdout.includes("0 finding(s)"),
      `expected no findings. exit=${inside.code}, stdout=${inside.stdout}, stderr=${inside.stderr}`,
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

function runDependencyVersions(): {
  code: number;
  stderr: string;
} {
  return runNode([
    resolve(workspaceRoot, "scripts/repo/check-dependency-versions.ts"),
  ]);
}

function runBoundaries(): {
  code: number;
  stderr: string;
} {
  return runNode([
    resolve(workspaceRoot, "scripts/architecture/check-boundaries.ts"),
  ]);
}

/** The plant changes only the emitted literal, preserving the surrounding version sets. */
function withCompatibilityVersion(next: string) {
  return (source: string): string =>
    source.replace(
      /export\s+const\s+WIRE_VERSION\s*=\s*["']([^"']*)["']/,
      `export const WIRE_VERSION = "${next}"`,
    );
}

/**
 * Inserts text right after the first match of pattern in a planted source.
 * @param source The source being planted.
 * @param pattern The array head to insert after.
 * @param insertion The entries to add at the head of that array.
 * @returns The source with the entries inserted.
 */
function insertAfter(
  source: string,
  pattern: RegExp,
  insertion: string,
): string {
  if (!pattern.test(source)) {
    throw new Error(
      `Plant target ${pattern} missing in ${WIRE_VERSION_SOURCE}`,
    );
  }
  return source.replace(pattern, (head) => `${head}${insertion}`);
}

main();
