/** @file Imports the packed Client entries from an isolated consumer. */
import { Effect } from "effect";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { productManifests } from "./repo/packages.ts";
import {
  installPackedConsumer,
  packProductClosure,
  runCommand,
  runGate,
} from "./test/packed-workspace.ts";

const workspaceRoot = dirname(dirname(fileURLToPath(import.meta.url)));

runGate("sharness-social-harness-pack-", (temporaryRoot) =>
  Effect.gen(function* () {
    const { archives } = yield* packProductClosure(
      workspaceRoot,
      "packages/social-harness",
      temporaryRoot,
    );
    const consumerRoot = yield* installPackedConsumer({
      temporaryRoot,
      name: "sharness-client-packed-consumer",
      archives,
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
    return "social-harness package consumer check passed";
  }),
);

/** Source manifests select the entries an ordinary consumer can import. */
function publicImports(): string {
  return productManifests(workspaceRoot)
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
