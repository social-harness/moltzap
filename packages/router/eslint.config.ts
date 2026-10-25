/** @file Package ESLint configuration: the shared workspace preset. */
import { packageEslintConfig } from "../../eslint.shared.js";

export default [
  ...packageEslintConfig({ tsconfigRootDir: import.meta.dirname }),
  {
    files: ["src/router/__tests__/router-capability.test.ts"],
    /** Effect's scoped registrations are invisible to Sonar's direct Vitest-call detector. */
    rules: { "sonarjs/no-empty-test-file": "off" },
  },
];
