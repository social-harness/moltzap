/** @file Limits Registry's private Identity resolution to Registry-owned modules. */
import { registerHooks } from "node:module";

const REGISTRY_MODULE_ROOTS = [
  new URL("../dist/", import.meta.url).href,
  new URL("../bin/", import.meta.url).href,
];

/** External consumers retain their original export conditions after Registry starts. */
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
