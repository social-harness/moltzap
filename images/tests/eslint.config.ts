/**
 * @file The agent-image live tests run Docker containers and child processes
 * from node:test with Node built-ins, the way the image programs do, so they
 * and their fixtures keep the image programs' exemptions from the
 * Effect-only rules.
 */
import { agentImageEslintConfig } from "../../eslint.shared.js";

export default [
  ...agentImageEslintConfig(import.meta.dirname),
  {
    files: ["*.live.test.ts"],
    rules: {
      "agent-code-guard/async-keyword": "off",
      "agent-code-guard/promise-type": "off",
      "@typescript-eslint/no-floating-promises": [
        "error",
        {
          allowForKnownSafeCalls: [
            {
              from: "package",
              package: "node:test",
              name: ["describe", "it", "suite", "test"],
            },
          ],
        },
      ],
    },
  },
];
