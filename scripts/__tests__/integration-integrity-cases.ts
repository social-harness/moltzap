/** @file Test-integrity plants for shared and package fixtures. */
/** Test-integrity rules apply to integration tests as well as product tests. */
export const INTEGRATION_INTEGRITY_CASES = [
  ...[
    "tests/integration/unit-named.test.ts",
    "packages/client/integration/unit-named.test.ts",
  ].map((path) => ({
    name: `all TypeScript fixtures are covered in ${path}`,
    path,
    source: '\nvi.spyOn(console, "log");\n',
    diagnostic: /\[integration-vi-mock\]/,
  })),
  {
    name: "package integration fixture mock guard",
    path: "packages/client/integration/otlp-receiver.ts",
    source: '\nvi.spyOn(console, "log");\n',
    diagnostic: /\[integration-vi-mock\]/,
  },
  {
    name: "nested shared fixture mock guard",
    path: "packages/router/src/router/__tests__/nested/fixture.ts",
    source: '\nvi.spyOn(console, "log");\n',
    diagnostic: /\[integration-vi-mock\]/,
  },
  {
    name: "binary and invalid UTF-8 fixture mock guard",
    path: "tests/integration/binary-fixture.ts",
    source: Buffer.from('\nvi.spyOn(console, "log");\n// \0é\n', "latin1"),
    diagnostic: /\[integration-vi-mock\]/,
  },
  ...[".test.ts", "__tests__", "test-utils", "/dist/"].map((comment) => ({
    name: `production content cannot exclude ${comment}`,
    path: "packages/client/src/guard-plant.ts",
    source: `\nconst result = db.query(); // ${comment}\n`,
    diagnostic: /\[raw-sql\]/,
  })),
  /**
   * Value: protects=the hardcoded-api-key guard scans scripts/ and examples/ as well as packages/ and tests/; fails_when=either root leaves the credential scan scope; why_new=every other credential row plants under packages/ or tests/; seam=none; no_claim=which credential spellings the pattern matches.
   */
  ...[
    "scripts/credential-plant.ts",
    "examples/two-agents/credential-plant.ts",
  ].map((path) => ({
    name: `credential guard scans ${path}`,
    path,
    source: '\nconst apiKey = "' + "synthetic".repeat(4) + '";\n',
    diagnostic: /\[hardcoded-api-key\]/,
  })),
  {
    name: "typed credential guard",
    path: "tests/integration/credential-plant.ts",
    source: '\nconst apiKey: string = "' + "synthetic".repeat(4) + '";\n',
    diagnostic: /\[hardcoded-api-key\]/,
  },
  {
    name: "environment fallback credential guard",
    path: "tests/integration/credential-plant.ts",
    source:
      '\nconst apiKey = process.env.K ?? "' + "synthetic".repeat(4) + '";\n',
    diagnostic: /\[hardcoded-api-key\]/,
  },
  {
    name: "array credential guard",
    path: "tests/integration/credential-plant.ts",
    source: '\nconst apiKeys = ["' + "synthetic".repeat(4) + '"];\n',
    diagnostic: /\[hardcoded-api-key\]/,
  },
  {
    name: "mock paths do not alter fixture scope",
    path: "packages/registry/src/__tests__/registry-process.ts",
    source: '\nvi.mock("../dist/service.js"); // helper.test.ts:\n',
    diagnostic: /\[integration-vi-mock\]/,
  },
  {
    name: "shared fixture mock guard",
    path: "packages/registry/src/__tests__/registry-process.ts",
    source: '\nvi.spyOn(console, "log");\n',
    diagnostic: /\[integration-vi-mock\]/,
  },
  {
    name: "integration fixture mock guard",
    path: "tests/integration/daemon-process-harness.ts",
    source: '\nvi.spyOn(console, "log");\n',
    diagnostic: /\[integration-vi-mock\]/,
  },
  {
    name: "object credential guard",
    path: "tests/integration/daemon-process-harness.ts",
    source: '\nconst config = { apiKey: "' + "synthetic".repeat(4) + '" };\n',
    diagnostic: /\[hardcoded-api-key\]/,
  },
  {
    name: "uppercase credential guard",
    path: "tests/integration/daemon-process-harness.ts",
    source: '\nconst API_KEY = "' + "synthetic".repeat(4) + '";\n',
    diagnostic: /\[hardcoded-api-key\]/,
  },
  {
    name: "distant next-line pragma",
    path: "tests/integration/distant-pragma-plant.ts",
    source:
      '// #ignore-sloppy-code-next-line[hardcoded-api-key]: synthetic plant\nconst unrelated = true;\nconst apiKey = "' +
      "synthetic".repeat(4) +
      '";\n',
    diagnostic: /\[hardcoded-api-key\]/,
  },
  {
    name: "mock guard",
    path: "tests/integration/daemon-process.integration.test.ts",
    source: '\nvi.spyOn(console, "log");\n',
    diagnostic: /\[integration-vi-mock\]/,
  },
  {
    name: "credential guard in a fixture",
    path: "tests/integration/daemon-process-harness.ts",
    source: '\nconst apiKey = "' + "synthetic".repeat(4) + '";\n',
    diagnostic: /\[hardcoded-api-key\]/,
  },
  {
    name: "package mock guard",
    path: "packages/client/integration/process-feedback.integration.test.ts",
    source: '\nvi.spyOn(console, "log");\n',
    diagnostic: /\[integration-vi-mock\]/,
  },
  {
    name: "package credential guard in a fixture",
    path: "packages/registry/src/__tests__/registry-process.ts",
    source: '\nconst apiKey = "' + "synthetic".repeat(4) + '";\n',
    diagnostic: /\[hardcoded-api-key\]/,
  },
  ...["tests/integration", "packages/client/integration"].flatMap(
    (directory) => [
      {
        name: `cast-chain guard scans ${directory}`,
        path: `${directory}/cast-plant.ts`,
        source: "\nconst value = input as unknown as string;\n",
        diagnostic: /\[as-unknown-as\]/,
      },
      {
        name: `wire-error dispatch guard scans ${directory}`,
        path: `${directory}/dispatch-plant.ts`,
        source: '\nif (error._tag === "RpcServerError") {}\n',
        diagnostic: /\[tag-discriminant\]/,
      },
    ],
  ),
] as const;
