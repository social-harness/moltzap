/** @file Agent-image tooling uses the workspace strict lint rules. */
import { agentImageEslintConfig } from "../../eslint.shared.js";
export default agentImageEslintConfig(import.meta.dirname);
