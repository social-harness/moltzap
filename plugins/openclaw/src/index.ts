/** @file An opaque package entry keeps OpenClaw's host types out of the package import. */
import plugin from "./plugin.js";

interface OpenClawLoaderEntry {
  readonly id: string;
}

/** Provides an opaque OpenClaw loader entry without exporting host internals. */
const loaderEntry: OpenClawLoaderEntry = plugin;

// eslint-disable-next-line import-x/no-default-export -- consumers that import the package by name expect a default export; OpenClaw itself loads `dist/plugin.js` from the package's `openclaw.extensions`.
export default loaderEntry;
