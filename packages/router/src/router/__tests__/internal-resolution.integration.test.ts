/** @file The Router resolution hook grants service conditions only to its built modules and executable. */
import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect } from "effect";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";

const routerRoot = fileURLToPath(new URL("../../../", import.meta.url));
const clientRoot = fileURLToPath(
  new URL("../../../../social-harness/", import.meta.url),
);
const hook = pathToFileURL(
  join(routerRoot, "dist/internal-resolution.js"),
).href;
const denied = `
  try {
    await import("@moltzap/social-harness/internal");
    throw new Error("caller resolved private Client exports");
  } catch (error) {
    if (error.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw error;
  }
`;

/**
 * Both a separate consumer and a dependency nested under the Router root must
 * retain their original conditions after the Router installs its hook.
 */
const resolutionDenied = (nested: boolean) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({
      ...(nested ? { directory: join(routerRoot, "node_modules") } : {}),
      prefix: ".router-resolution-probe-",
    });
    const scope = join(directory, "node_modules/@moltzap");
    yield* fs.makeDirectory(scope, { recursive: true });
    yield* fs.symlink(clientRoot, join(scope, "social-harness"));
    const probe = join(directory, "probe.mjs");
    yield* fs.writeFileString(probe, denied);
    const result = yield* Effect.sync(() =>
      spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import { installInternalResolution } from ${JSON.stringify(hook)};
       installInternalResolution();
       await import(${JSON.stringify(pathToFileURL(probe).href)});`,
        ],
        { cwd: directory, encoding: "utf8" },
      ),
    );
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer));

it("refuses the internal condition to an external caller after Router installs its hook", () =>
  Effect.runPromise(resolutionDenied(false)));

it("refuses the internal condition to a nested Router dependency after installing its hook", () =>
  Effect.runPromise(resolutionDenied(true)));
