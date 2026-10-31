/** @file A temporary readable MCP credential isolates native adapter tests. */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

const fixtureDirectory = mkdtempSync(join(tmpdir(), "sharness-nanoclaw-test-"));

/** The adapter reads this file through its ordinary credential boundary. */
export const credentialFile = join(fixtureDirectory, "mcp-credential");
writeFileSync(credentialFile, "nanoclaw-test-credential");

afterAll(() => {
  rmSync(fixtureDirectory, { recursive: true, force: true });
});
