/**
 * @file Relocated integration fixtures keep the lint rules of their owning scopes.
 * Run directly, this module prints each fixture's resolved rule table beside its owner's.
 *
 * Value: protects=each relocated fixture is linted by the rules its owning scope applies at its original path; fails_when=a relocation prefix, glob or block stops matching;
 * why_new=a clean lint run passes when relocation drops rules; seam=none; no_claim=type-aware findings or which rules owners choose.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

type GateAssertion = (name: string, passed: boolean, message: string) => void;
type GateRunner = (args: readonly string[]) => {
  code: number;
  stdout: string;
  stderr: string;
};

/** One fixture per relocation in `tests/integration/eslint.config.ts`, with the scope and path that owned it. */
const RELOCATED_FIXTURES = [
  {
    fixture: "daemon-process-harness.ts",
    owner: "packages/client",
    original: "integration/daemon-process-harness.ts",
  },
  {
    fixture: "adapter-daemon-fixture.ts",
    owner: ".",
    original: "scripts/test/adapter-daemon-fixture.ts",
  },
  {
    fixture: "vitest.integration.config.ts",
    owner: "packages/client",
    original: "vitest.integration.config.ts",
  },
  {
    fixture: "client-version-roundtrip.ts",
    owner: "packages/router",
    original: "src/router/__tests__/integration/client-version-roundtrip.ts",
  },
  {
    fixture: "registry-router.integration.test.ts",
    owner: "packages/router",
    original: "src/router/__tests__/registry-router.integration.test.ts",
  },
] as const;

const MODULE_PATH = fileURLToPath(import.meta.url);

/**
 * Each relocated fixture's resolved rules equal its owner's rules at the original path.
 * @param test Records one named assertion.
 * @param runNode Runs this module, which resolves configurations through ESLint's API.
 */
export function testLintRelocation(
  test: GateAssertion,
  runNode: GateRunner,
): void {
  console.log("\n# integration lint relocation");
  const resolved = runNode([MODULE_PATH]);
  const pairs: unknown = resolved.code === 0 ? JSON.parse(resolved.stdout) : [];
  for (const [index, relocation] of RELOCATED_FIXTURES.entries()) {
    const { fixture, owner, original } = relocation;
    const pair: unknown = Array.isArray(pairs) ? pairs[index] : undefined;
    const [relocated, owning] = Array.isArray(pair)
      ? [ruleTable(pair[0]), ruleTable(pair[1])]
      : [{}, {}];
    const differing = Object.keys({ ...owning, ...relocated }).filter(
      (rule) => !isDeepStrictEqual(owning[rule], relocated[rule]),
    );
    test(
      `relocated ${fixture} keeps the rules ${owner} applies to ${original}`,
      Object.keys(relocated).length > 0 && differing.length === 0,
      `relocated ${String(Object.keys(relocated).length)} rules, owning ${String(Object.keys(owning).length)}; differing: ${differing.join(", ")}; stderr: ${resolved.stderr}`,
    );
  }
}

/** ESLint returns resolved configuration untyped; a missing or ignored file has no rules. */
function ruleTable(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null ? { ...value } : {};
}

/** Returns the rules table from a resolved ESLint configuration, or an empty table. */
function rulesOf(config: unknown): unknown {
  return typeof config === "object" && config !== null && "rules" in config
    ? config.rules
    : {};
}

if (process.argv[1] === MODULE_PATH) {
  const { ESLint } = await import("eslint");
  const owners = new Map<string, InstanceType<typeof ESLint>>();
  const workspaceRoot = resolve(dirname(MODULE_PATH), "../..");
  const integrationRoot = resolve(workspaceRoot, "tests/integration");
  const integration = new ESLint({ cwd: integrationRoot });
  const pairs: unknown[] = [];
  for (const { fixture, owner, original } of RELOCATED_FIXTURES) {
    const ownerRoot = resolve(workspaceRoot, owner);
    const relocated: unknown = await integration.calculateConfigForFile(
      resolve(integrationRoot, fixture),
    );
    const ownerLint = owners.get(ownerRoot) ?? new ESLint({ cwd: ownerRoot });
    owners.set(ownerRoot, ownerLint);
    const owning: unknown = await ownerLint.calculateConfigForFile(
      resolve(ownerRoot, original),
    );
    pairs.push([rulesOf(relocated), rulesOf(owning)]);
  }
  console.log(JSON.stringify(pairs));
}
