/** @file Verifies that every tracked integration source resolves its required lint profiles. */
import { ESLint } from "eslint";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { workspaceRoot } from "./plants.ts";

const { stdout } = await promisify(execFile)(
  "git",
  ["ls-files", "-z", "--", "tests/integration"],
  { cwd: workspaceRoot, encoding: "utf8" },
);
const files = stdout.split("\0").filter((file) => file.endsWith(".ts"));
assert.ok(files.length > 0, "No tracked integration TypeScript files found");
const eslint = new ESLint({ cwd: resolve(workspaceRoot, "tests/integration") });
for (const file of files) {
  const config: unknown = await eslint.calculateConfigForFile(
    resolve(workspaceRoot, file),
  );
  expectErrorRule(
    config,
    "max-lines",
    `${file}: strict profile must enforce max-lines as error`,
  );
  if (file.endsWith(".integration.test.ts")) {
    expectErrorRule(
      config,
      "agent-code-guard/no-vitest-mocks",
      `${file}: integration-test profile must enforce no-vitest-mocks as error`,
    );
  }
}
console.log(
  `Integration lint profiles verified for ${files.length} tracked TypeScript files.`,
);

/** ESLint's config API is untyped, so only the consumed rule severity is narrowed. */
function expectErrorRule(config: unknown, rule: string, message: string): void {
  assert.ok(
    typeof config === "object" && config !== null && "rules" in config,
    message,
  );
  const rules: unknown = config.rules;
  assert.ok(
    typeof rules === "object" && rules !== null && rule in rules,
    message,
  );
  const setting: unknown = Reflect.get(rules, rule);
  assert.ok(Array.isArray(setting) && setting[0] === 2, message);
}
