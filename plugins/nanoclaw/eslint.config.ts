/** @file Package ESLint configuration: the shared workspace preset. */
import { packageEslintConfig } from "../../eslint.shared.js";

export default packageEslintConfig({ tsconfigRootDir: import.meta.dirname });
