/** @file Isolates cryptographic provenance verification from the installed-launcher acceptance test. */
import { registerHooks } from "node:module";

const verifier =
  "data:text/javascript,export const verify = () => Promise.resolve();";

registerHooks({
  resolve(specifier, context, nextResolve) {
    return specifier === "sigstore"
      ? { url: verifier, shortCircuit: true }
      : nextResolve(specifier, context);
  },
});
