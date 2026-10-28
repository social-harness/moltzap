/**
 * @file Package ESLint configuration. `plugin.ts` keeps the OpenClaw
 * registration and channel callbacks together so a reader can see the
 * complete host contract in one place, which needs a higher line ceiling.
 */
import { packageEslintConfig } from "../../eslint.shared.js";

export default packageEslintConfig({
  maxLines: 1200,
  tsconfigRootDir: import.meta.dirname,
});
