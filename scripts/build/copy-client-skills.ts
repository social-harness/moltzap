/**
 * @file Copies the agent skills `@moltzap/social-harness` ships into the calling
 * channel package's `dist/skills`, so every host channel installs the same
 * skill text from its own package. A channel build runs it from the package
 * directory after `tsc -b`; the workspace keeps Client at `../client`.
 */
import { cpSync } from "node:fs";
import { resolve } from "node:path";

cpSync(resolve("../client/skills"), resolve("dist/skills"), {
  recursive: true,
});
