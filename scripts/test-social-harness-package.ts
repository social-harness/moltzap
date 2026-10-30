/** @file Verifies packed service entries and explicit firewall assets in an isolated consumer. */
import { Effect } from "effect";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { workspacePackages } from "./repo/packages.ts";
import {
  installPackedConsumer,
  packProductClosure,
  readConsumerPins,
  runCommand,
  runGate,
} from "./test/packed-workspace.ts";

const workspaceRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/** An installed consumer compares published bytes with the source assets and uses the public loader. */
const policyAssetScript = `
import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Option } from "effect";
import { loadMessagePolicy } from "@moltzap/social-harness/service";

const sourceRoot = ${JSON.stringify(`${workspaceRoot}/packages/social-harness/config/firewall`)};
const installedRoot = fileURLToPath(new URL("../config/firewall/", import.meta.resolve("@moltzap/social-harness")));
const entries = await readdir(sourceRoot, { recursive: true, withFileTypes: true });
const rules = entries.filter((entry) => entry.isFile() && entry.name === "BEHAVIOR.md");
if (rules.length === 0) throw new Error("source policy assets contain no rules");
const directories = [];
for (const rule of rules) {
  const source = join(rule.parentPath, rule.name);
  const path = relative(sourceRoot, source);
  const expected = await readFile(source, "utf8");
  const actual = await readFile(join(installedRoot, path), "utf8");
  if (actual !== expected) throw new Error("packed rule changed: " + path);
  directories.push(dirname(path));
}
const presetPath = join(installedRoot, "message-policy.json");
const preset = JSON.parse(await readFile(presetPath, "utf8"));
const allRulesPath = join(installedRoot, "packed-consumer-policy.json");
await writeFile(allRulesPath, JSON.stringify({
  ...preset,
  text: { fixedBehaviors: directories },
  decisionProvider: { kind: "unavailable" },
}));
for (const messagePolicyFile of [presetPath, allRulesPath]) {
  const loaded = await Effect.runPromise(loadMessagePolicy(
    { messagePolicyFile },
    () => Effect.dieMessage("unavailable policy attempted to read credentials"),
  ));
  if (Option.isNone(loaded)) throw new Error("packed policy was not loaded");
  const configured = loaded.value.policy.text?.fixedRules ?? [];
  if (configured.length === 0 || loaded.value.behaviorRulePaths.size !== configured.length) {
    throw new Error("packed policy did not resolve its selected rules");
  }
  if (messagePolicyFile === allRulesPath && configured.length !== rules.length) {
    throw new Error("packed policy omitted a shipped rule");
  }
}
`;

runGate("sharness-social-harness-pack-", (temporaryRoot) =>
  Effect.gen(function* () {
    const { archives } = yield* packProductClosure(
      workspaceRoot,
      "packages/social-harness",
      temporaryRoot,
    );
    const pins = yield* readConsumerPins(workspaceRoot);
    const consumerRoot = yield* installPackedConsumer({
      temporaryRoot,
      name: "sharness-client-packed-consumer",
      archives,
      dependencies: { effect: pins.effect },
    });
    const imports = publicImports();
    yield* runCommand(
      process.execPath,
      ["--input-type=module", "-e", imports],
      {
        cwd: consumerRoot,
        env: { NODE_PATH: "" },
      },
    );
    yield* runCommand(
      process.execPath,
      [
        "--conditions=sharness-test",
        "--input-type=module",
        "-e",
        'await import("@moltzap/social-harness/test");',
      ],
      {
        cwd: consumerRoot,
        env: { NODE_PATH: "" },
      },
    );
    yield* verifyInternalResolution(consumerRoot);
    yield* verifyPolicyAssets(consumerRoot);
    return "social-harness package consumer check passed";
  }),
);

/** Source manifests select the entries an ordinary consumer can import. */
function publicImports(): string {
  return workspacePackages(workspaceRoot)
    .filter(({ name }) => name === "@moltzap/social-harness")
    .flatMap(({ name, exports }) =>
      Object.entries(exports)
        .filter(
          ([, target]) =>
            !(
              typeof target === "object" &&
              target !== null &&
              ("sharness-test" in target || "sharness-internal" in target)
            ),
        )
        .map(([subpath]) =>
          subpath === "." ? name : `${name}/${subpath.slice(2)}`,
        ),
    )
    .map((specifier) => `await import(${JSON.stringify(specifier)});`)
    .join("\n");
}

/** Service capabilities resolve only under the private service condition. */
function verifyInternalResolution(consumerRoot: string) {
  return Effect.gen(function* () {
    yield* runCommand(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
try {
  await import("@moltzap/social-harness/internal");
  throw new Error("internal entry resolved without its condition");
} catch (error) {
  if (error.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw error;
}
`,
      ],
      { cwd: consumerRoot, env: { NODE_PATH: "" } },
    );
    yield* runCommand(
      process.execPath,
      [
        "--conditions=sharness-internal",
        "--input-type=module",
        "-e",
        'await import("@moltzap/social-harness/internal");',
      ],
      { cwd: consumerRoot, env: { NODE_PATH: "" } },
    );
  });
}

/** Packed policies load through the public API, including every shipped rule document. */
function verifyPolicyAssets(consumerRoot: string) {
  return runCommand(
    process.execPath,
    ["--input-type=module", "-e", policyAssetScript],
    { cwd: consumerRoot, env: { NODE_PATH: "" } },
  );
}
