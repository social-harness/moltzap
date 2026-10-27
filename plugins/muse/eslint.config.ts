/** @file The Muse receiver uses the workspace's typed lint rules. */
import { packageEslintConfig } from "../../eslint.shared.js";

export default packageEslintConfig({ tsconfigRootDir: import.meta.dirname });
