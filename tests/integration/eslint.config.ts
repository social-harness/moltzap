/** @file Apply one strict profile to every process suite and fixture. */
import { integrationEslintConfig } from "../../eslint.shared.js";

export default integrationEslintConfig(import.meta.dirname);
