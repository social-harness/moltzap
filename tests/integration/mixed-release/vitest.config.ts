/** @file Vitest configuration for the adjacent-release process suite. */
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { conditions: ["sharness-test"] },
  ssr: { resolve: { conditions: ["sharness-test"] } },
  test: {
    include: [
      "tests/integration/mixed-release/mixed-release.integration.test.ts",
    ],
    maxWorkers: 1,
    passWithNoTests: false,
  },
});
