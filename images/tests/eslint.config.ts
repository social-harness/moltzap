/** @file Agent-image tooling uses the workspace strict lint rules. */
import { integrationEslintConfig } from "../../eslint.shared.js";
export default integrationEslintConfig(import.meta.dirname, ["**/*.ts"]);
