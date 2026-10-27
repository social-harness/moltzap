/**
 * @file Isolates tests from the developer's environment. OpenClaw's public
 * inbound runner records sessions in a temporary state directory, and every
 * test starts with both experiment switches unset, so a shell that exports one
 * for an evaluation changes no result and the Nx cache key needs neither.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, vi } from "vitest";

/** Temporary OpenClaw state directory shared by setup and test configuration. */
export const openClawTestStateDirectory = mkdtempSync(
  join(tmpdir(), "sharness-openclaw-channel-test-"),
);

vi.stubEnv("OPENCLAW_STATE_DIR", openClawTestStateDirectory);

beforeEach(() => {
  vi.stubEnv("SHARNESS_EXPERIMENT_HIDE_COLLECTIVES", undefined);
  vi.stubEnv("SHARNESS_EXPERIMENT_HIDE_GROUPS", undefined);
});

afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(openClawTestStateDirectory, { recursive: true, force: true });
});
