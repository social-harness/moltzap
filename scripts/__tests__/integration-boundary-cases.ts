/** @file Mutations that exercise the private integration workspace contract. */

/** Each case identifies a forbidden workspace change and its gate diagnostic. */
export const INTEGRATION_BOUNDARY_CASES = [
  {
    name: "percent-encoded path",
    path: "tests/integration/daemon-process-harness.ts",
    prepend: 'require("./%2e%2e/%2e%2e/packages/client/src/index.ts");\n',
    message:
      /test infrastructure must not use query, fragment, or encoded path specifiers/,
  },
  {
    name: "query path",
    path: "tests/integration/daemon-process-harness.ts",
    prepend: 'require("./x?/../../packages/client/src/index.ts");\n',
    message:
      /test infrastructure must not use query, fragment, or encoded path specifiers/,
  },
  {
    name: "fragment path",
    path: "tests/integration/daemon-process-harness.ts",
    prepend: 'require("./x#/../../packages/client/src/index.ts");\n',
    message:
      /test infrastructure must not use query, fragment, or encoded path specifiers/,
  },
  {
    name: "uppercase file URL",
    path: "tests/integration/daemon-process-harness.ts",
    prepend: 'require("FILE:///tmp/outside-integration.js");\n',
    message: /test infrastructure must not cross its boundary/,
  },
  {
    name: "nested node_modules cannot evade scanning",
    path: "tests/integration/mixed-release/node_modules/boundary-plant.ts",
    prepend: 'import "@moltzap/client/internal";\n',
    message:
      /test infrastructure must not contain nested node_modules or dist directories/,
  },
  {
    name: "nested dist cannot evade scanning",
    path: "tests/integration/mixed-release/dist/boundary-plant.ts",
    prepend: 'import "@moltzap/client/internal";\n',
    message:
      /test infrastructure must not contain nested node_modules or dist directories/,
  },
  {
    name: "import.meta.resolve cannot resolve product source",
    path: "tests/integration/daemon-process-harness.ts",
    prepend: 'import.meta.resolve("../../packages/client/src/index.ts");\n',
    message: /test infrastructure must not cross its boundary/,
  },
  {
    name: "require.resolve cannot resolve product source",
    path: "tests/integration/daemon-process-harness.ts",
    prepend: 'require.resolve("../../packages/client/src/index.ts");\n',
    message: /test infrastructure must not cross its boundary/,
  },
  {
    name: "createRequire(import.meta.url).resolve cannot resolve product source",
    path: "tests/integration/daemon-process-harness.ts",
    prepend:
      'createRequire(import.meta.url).resolve("../../packages/client/src/index.ts");\n',
    message: /test infrastructure must not cross its boundary/,
  },
  {
    name: "linked sources cannot evade scanning",
    path: "tests/integration/mixed-release/linked.ts",
    symlink: "../../../packages/client/src/index.ts",
    message: /test infrastructure must not contain symbolic links/,
  },
  {
    name: "a CLAUDE.md link to another file cannot evade scanning",
    path: "tests/integration/CLAUDE.md",
    symlink: "../../packages/client/src/index.ts",
    message: /test infrastructure must not contain symbolic links/,
  },
  {
    name: "escaped import cannot conceal an external path",
    path: "tests/integration/daemon-process-harness.ts",
    prepend: String.raw`import "\u002e\u002e/../packages/client/src/index.ts";`,
    message:
      /test infrastructure must not use escaped import or URL specifiers/,
  },
  {
    name: "escaped URL cannot conceal an external path",
    path: "tests/integration/daemon-process-harness.ts",
    prepend: String.raw`new URL("\u002e\u002e/../packages/client/src/index.ts", import.meta.url);`,
    message:
      /test infrastructure must not use escaped import or URL specifiers/,
  },
  {
    name: "shorthand Vitest alias cannot bypass imports",
    path: "tests/integration/vitest.integration.config.ts",
    before: "resolve: { conditions:",
    after: "resolve: { alias, conditions:",
    message:
      /test infrastructure must not configure import resolution bypasses/,
  },
  {
    name: "computed Vitest alias cannot bypass imports",
    path: "tests/integration/vitest.integration.config.ts",
    before: "resolve: { conditions:",
    after: 'resolve: { ["alias"]: {}, conditions:',
    message:
      /test infrastructure must not configure import resolution bypasses/,
  },
  {
    name: "URL with trailing comma cannot escape",
    path: "tests/integration/daemon-process-harness.ts",
    prepend:
      'new URL("../../packages/client/src/index.ts", import.meta.url,);\n',
    message: /test infrastructure must not cross its boundary/,
  },
  {
    name: "bare relative URL cannot escape",
    path: "tests/integration/daemon-process-harness.ts",
    prepend:
      'new URL("child/../../../packages/client/src/index.ts", import.meta.url);\n',
    message: /test infrastructure must not cross its boundary/,
  },
  {
    name: "external protocol URL cannot escape",
    path: "tests/integration/daemon-process-harness.ts",
    prepend: 'new URL("https://example.invalid/module.ts", import.meta.url);\n',
    message: /test infrastructure must not cross its boundary/,
  },

  {
    name: "quoted Vitest alias cannot bypass imports",
    path: "tests/integration/vitest.integration.config.ts",
    before: "resolve: { conditions:",
    after:
      'resolve: { "alias": { "@moltzap/client": "../../packages/client/src/index.ts" }, conditions:',
    message:
      /test infrastructure must not configure import resolution bypasses/,
  },
  {
    name: "workspace-root dependency binary",
    path: "tests/integration/daemon-process-harness.ts",
    prepend:
      'const binary = join(WORKSPACE_ROOT, "packages/registry/node_modules/.bin/pglite-server");\n',
    message:
      /test infrastructure must not use another workspace's node_modules/,
  },
  {
    name: "malformed file URL",
    path: "tests/integration/daemon-process-harness.ts",
    prepend: 'import "file://remote/path.js";\n',
    message: /test infrastructure must not cross its boundary/,
  },
  {
    name: "integration workspace name is fixed",
    path: "tests/integration/package.json",
    before: '"name": "@moltzap/integration-tests"',
    after: '"name": "@moltzap/renamed-tests"',
    message: /must name @moltzap\/integration-tests and stay private/,
  },
  {
    name: "integration implicit edges cannot be added",
    path: "tests/integration/package.json",
    before: '"nx": {',
    after: '"nx": {"implicitDependencies": ["@moltzap/client"],',
    message: /test infrastructure dependencies drifted/,
  },
  {
    name: "internal condition in target command",
    path: "tests/integration/package.json",
    before: '"command": "',
    after: '"command": "node --conditions=sharness-internal && ',
    message: /test infrastructure must not enable sharness-internal/,
  },
  {
    name: "internal condition in TypeScript config",
    path: "tests/integration/tsconfig.json",
    before: '"sharness-test"',
    after: '"sharness-test", "sharness-internal"',
    message: /test infrastructure must not enable sharness-internal/,
  },
  {
    name: "TypeScript paths cannot bypass imports",
    path: "tests/integration/tsconfig.json",
    before: '"compilerOptions": {',
    after: '"compilerOptions": {"paths": {},',
    message:
      /test infrastructure must not configure import resolution bypasses/,
  },
  {
    name: "TypeScript baseUrl cannot bypass imports",
    path: "tests/integration/tsconfig.json",
    before: '"compilerOptions": {',
    after: '"compilerOptions": {"baseUrl": ".",',
    message:
      /test infrastructure must not configure import resolution bypasses/,
  },
  {
    name: "package imports cannot bypass imports",
    path: "tests/integration/package.json",
    before: '"private": true,',
    after: '"private": true, "imports": {},',
    message:
      /test infrastructure must not configure import resolution bypasses/,
  },
  {
    name: "Vitest product alias cannot bypass imports",
    path: "tests/integration/vitest.integration.config.ts",
    before: "resolve: { conditions:",
    after:
      'resolve: { alias: { "@moltzap/client": "../../packages/client/src/index.ts" }, conditions:',
    message:
      /test infrastructure must not configure import resolution bypasses/,
  },
  {
    name: "member-assigned Vitest alias cannot bypass imports",
    path: "tests/integration/vitest.integration.config.ts",
    before: "export default defineConfig({",
    after:
      'const config = defineConfig({});\nconfig.resolve.alias = { "@moltzap/client": "../../packages/client/src/index.ts" };\nexport default defineConfig({',
    message:
      /test infrastructure must not configure import resolution bypasses/,
  },
  {
    name: "backtick template product source",
    path: "tests/integration/daemon-process-harness.ts",
    prepend: "await import(`../../packages/client/src/index.js`);\n",
    message: /test infrastructure must not cross its boundary/,
  },
  {
    name: "non-literal dynamic import",
    path: "tests/integration/daemon-process-harness.ts",
    prepend: "await import(moduleName);\n",
    message: /test infrastructure imports must use string literals/,
  },
  {
    name: "non-literal require",
    path: "tests/integration/daemon-process-harness.ts",
    prepend: "require(moduleName);\n",
    message: /test infrastructure imports must use string literals/,
  },
  {
    name: "interpolated template import",
    path: "tests/integration/daemon-process-harness.ts",
    prepend: "await import(`./${moduleName}.js`);\n",
    message: /test infrastructure imports must use string literals/,
  },
  {
    name: "absolute product source",
    path: "tests/integration/daemon-process-harness.ts",
    prepend: 'import "/tmp/outside-integration.js";\n',
    message: /test infrastructure must not cross its boundary/,
  },
  {
    name: "file URL product source",
    path: "tests/integration/daemon-process-harness.ts",
    prepend: 'import "file:///tmp/outside-integration.js";\n',
    message: /test infrastructure must not cross its boundary/,
  },
  {
    name: "URL product source",
    path: "tests/integration/daemon-process-harness.ts",
    prepend:
      'new URL("../../packages/client/src/index.ts", import.meta.url);\n',
    message: /test infrastructure must not cross its boundary/,
  },
  {
    name: "another workspace dependency binary",
    path: "tests/integration/daemon-process-harness.ts",
    prepend:
      'const binary = "../../packages/registry/node_modules/.bin/pglite-server";\n',
    message:
      /test infrastructure must not use another workspace's node_modules/,
  },
  {
    name: "ESLint relative exception belongs only to its config",
    path: "tests/integration/daemon-process-harness.ts",
    prepend: 'import "../../eslint.shared.js";\n',
    message: /test infrastructure must not cross its boundary/,
  },
  {
    name: "__tests__ must occupy a whole path segment",
    path: "packages/client/src/__tests__suffix-gate.ts",
    prepend: 'import "@moltzap/client/test";\n',
    message: /production source must not import test-only export/,
  },
  {
    name: "integration workspace stays private",
    path: "tests/integration/package.json",
    before: '"private": true',
    after: '"private": false',
    message: /must name @moltzap\/integration-tests and stay private/,
  },
  {
    name: "integration dependency cannot disappear",
    path: "tests/integration/package.json",
    before: '"@moltzap/client": "workspace:*",',
    after: "",
    message: /test infrastructure dependencies drifted/,
  },
  {
    name: "integration dependency cannot be added",
    path: "tests/integration/package.json",
    before: '"devDependencies": {',
    after: '"devDependencies": {"@moltzap/nanoclaw-channel": "workspace:*",',
    message: /test infrastructure dependencies drifted/,
  },
  {
    name: "integration Knip root cannot be renamed",
    path: "knip.json",
    before: '"tests/integration": {',
    after: '"tests/renamed": {',
    message: /test workspace roots drifted/,
  },
  {
    name: "integration lane must be declared",
    path: "tests/integration/package.json",
    before: '"test:integration": {',
    after: '"test:renamed": {',
    message: /required Nx target declarations are missing: test:integration/,
  },
  {
    name: "integration fixtures cannot import internal Identity",
    path: "tests/integration/daemon-process-harness.ts",
    prepend: 'import "@moltzap/client/internal";\n',
    message:
      /test infrastructure must import public or test-only product exports/,
  },
  {
    name: "relative product source",
    path: "tests/integration/daemon-process-harness.ts",
    prepend: 'import "../../packages/client/src/index.js";\n',
    message: /test infrastructure must not cross its boundary/,
  },
  {
    name: "internal condition text",
    path: "tests/integration/daemon-process-harness.ts",
    prepend: 'const forbiddenCondition = "sharness-internal";\n',
    message: /test infrastructure must not enable sharness-internal/,
  },
  {
    name: "unexported deep entry",
    path: "tests/integration/daemon-process-harness.ts",
    prepend: 'import "@moltzap/client/dist/index.js";\n',
    message: /test infrastructure must import public or test-only/,
  },
  {
    name: "undeclared product",
    path: "tests/integration/daemon-process-harness.ts",
    prepend: 'import "@moltzap/nanoclaw-channel";\n',
    message: /test infrastructure must import public or test-only/,
  },
  {
    name: "package integration dependency",
    path: "packages/client/integration/boundary-plant.ts",
    prepend: 'import "@moltzap/registry";\n',
    message: /dependency DAG violation/,
  },
  {
    name: "package integration test-only entry",
    path: "packages/client/integration/boundary-plant.ts",
    prepend: 'import { WireVersions } from "@moltzap/client/test";\n',
    message: /production source must not import test-only export/,
  },
];

/** Invalid shapes must fail closed even when the remaining contract is intact. */
export const MALFORMED_BOUNDARY_CASES = [
  {
    path: "tsconfig.json",
    before: '"references": [',
    after: '"references": [7,',
  },
  {
    path: "tsconfig.json",
    before: '"references": [',
    after: '"references": [null,',
  },
  {
    path: "tsconfig.json",
    before: '"references": [',
    after: '"references": [{"path": 7},',
  },
  {
    path: "tsconfig.json",
    before: '"references": [',
    after: '"references": [{},',
  },
  {
    path: "knip.json",
    before: '"@electric-sql/pglite",',
    after: '7, "@electric-sql/pglite",',
  },
  {
    path: "packages/client/tsconfig.json",
    before: '"references": []',
    after: '"references": {}',
  },
  { path: "packages/client/tsconfig.json", replace: "[]" },
] as const;
