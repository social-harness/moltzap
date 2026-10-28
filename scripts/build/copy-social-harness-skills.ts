/**
 * @file Copies the agent skills `@moltzap/social-harness` ships into the calling
 * channel package's `dist/skills`, so every host channel installs the same
 * skill text from its own package. A channel build runs it from the package
 * directory after `tsc -b`; Client lives under `packages/social-harness`.
 */
import { cpSync } from "node:fs";
import { resolve } from "node:path";

cpSync(
  new URL("../../packages/social-harness/skills", import.meta.url),
  resolve("dist/skills"),
  {
    recursive: true,
  },
);
