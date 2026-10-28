/**
 * @file Package entry for tools that import the extension by package name.
 *
 * OpenClaw loads `dist/plugin.js`, which `openclaw.extensions` in
 * `package.json` names. `dist/index.js`
 * gives other package consumers a stable default export without exposing
 * OpenClaw-specific types.
 */
import plugin from "./plugin.js";

interface OpenClawLoaderEntry {
  readonly id: string;
}

/** Provides an opaque OpenClaw loader entry without exporting host internals. */
const loaderEntry: OpenClawLoaderEntry = plugin;

// eslint-disable-next-line import-x/no-default-export -- consumers that import the package by name expect a default export; OpenClaw itself loads `dist/plugin.js` from the package's `openclaw.extensions`.
export default loaderEntry;
