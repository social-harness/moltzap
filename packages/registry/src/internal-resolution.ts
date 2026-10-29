/** @file Limits Registry's private Identity resolution to Registry-owned modules. */
import { registerHooks } from "node:module";

const REGISTRY_MODULE_ROOTS = [
  new URL("../dist/", import.meta.url).href,
  new URL("../bin/", import.meta.url).href,
];

/**
 * Enables `sharness-internal` for imports made by Registry's `dist/` and `bin/`
 * modules.
 * Imports made by dependencies in Registry's `node_modules/` directory or by
 * unrelated modules retain their original export conditions.
 */
export function installInternalResolution(): void {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (
        !REGISTRY_MODULE_ROOTS.some(
          (root) => context.parentURL?.startsWith(root) === true,
        )
      ) {
        return nextResolve(specifier, context);
      }
      return nextResolve(specifier, {
        ...context,
        conditions: [...context.conditions, "sharness-internal"],
      });
    },
  });
}
