/** @file Limits Router's private Identity resolution to Router-owned modules. */
import { registerHooks } from "node:module";

const ROUTER_MODULE_ROOTS = [
  new URL("../dist/", import.meta.url).href,
  new URL("../bin/", import.meta.url).href,
];

/** External consumers retain their original export conditions after Router starts. */
export function installInternalResolution(): void {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (
        !ROUTER_MODULE_ROOTS.some(
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
