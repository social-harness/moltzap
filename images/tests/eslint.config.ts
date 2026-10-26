/**
 * @file The agent-image live tests run Docker containers and child processes
 * from node:test with Node built-ins, the way the image programs do.
 */
import { agentImageEslintConfig } from "../../eslint.shared.js";

export default agentImageEslintConfig(import.meta.dirname);
