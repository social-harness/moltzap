/** @file Enforces the reviewed host module and external package allowlists. */
import type { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { dirname, relative, resolve } from "node:path";
import {
  type GateError,
  readText,
  requireCondition,
} from "./packed-workspace.ts";

/** Reviewed paths the packed root can load without daemon machinery. */
const clientHostModules: ReadonlySet<string> = new Set([
  "dist/index.js",
  "dist/environment.js",
  "package.json",
  "dist/encoding/exact.js",
  "dist/encoding/canonical-json.js",
  "dist/encoding/identifier.js",
  "dist/identity/agents.js",
  "dist/identity/keys.js",
  "dist/identity/cards.js",
  "dist/identity/wire-version.js",
  "dist/identity/bounded-cache.js",
  "dist/communication/envelope/signed-message.js",
  "dist/communication/envelope/wire-profile.js",
  "dist/release/",
  "dist/firewall/outcome/",
  "dist/communication/records/values.js",
  "dist/communication/store/types.js",
  "dist/communication/conversations/errors.js",
  "dist/communication/conversations/message.js",
  "dist/communication/collectives/forms.js",
  "dist/communication/collectives/inbound.js",
  "dist/communication/collectives/message-text.js",
  "dist/communication/collectives/render.js",
  "dist/harness/protocol/operations.js",
  "dist/harness/protocol/names.js",
  "dist/harness/endpoint/",
  "dist/harness/inbox/history-export.js",
]);

/**
 * Bare specifiers the packed root entry may import, matched exactly, so a
 * package subpath such as a Router or Registry server entry fails the check.
 */
const hostPackages: ReadonlySet<string> = new Set([
  "@effect/platform",
  "@modelcontextprotocol/client",
  "canonicalize",
  "effect",
  "node:crypto",
  "node:util",
  "@noble/curves/ed25519.js",
  "effect/Function",
  "jose",
  "http-message-signatures",
  "structured-headers",
]);

/**
 * Patterns for the module specifiers a built module loads. They match a
 * static import or re-export that is not type-only, a bare side-effect
 * import, and a literal dynamic import.
 */
const importPatterns: readonly RegExp[] = [
  // eslint-disable-next-line sonarjs/slow-regex -- input is this repository's own emitted `dist/` JavaScript, not untrusted text
  /^(?:import|export)\s+(?!type\b)[^;]*?from\s+["']([^"']+)["']/gmu,
  /^import\s+["']([^"']+)["']/gmu,
  /\bimport\(\s*["']([^"']+)["']\s*\)/gu,
];
const unresolvableLoad = /\bimport\(\s*[^"'\s]|\bcreateRequire\b|\brequire\(/u;

/**
 * Fail when the packed root entry reaches a module or package outside the
 * host allowlists, through a static or literal dynamic import, or loads a
 * module it names only at run time.
 * @param extractedPackage Directory of the unpacked client archive.
 * @param entry Package-relative path of the root entry module.
 */
export function verifyHostImportGraph(
  extractedPackage: string,
  entry: string,
): Effect.Effect<void, GateError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const seen = new Set<string>();
    const pending = [resolve(extractedPackage, entry)];
    for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
      if (!seen.has(file)) {
        seen.add(file);
        pending.push(...(yield* hostModuleImports(extractedPackage, file)));
      }
    }
  }).pipe(Effect.withSpan("verifyHostImportGraph"));
}

/**
 * Check one reachable module and return the package-relative files it
 * imports.
 * @param extractedPackage Directory of the unpacked client archive.
 * @param file Absolute path of the module.
 */
function hostModuleImports(
  extractedPackage: string,
  file: string,
): Effect.Effect<readonly string[], GateError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const module = relative(extractedPackage, file);
    yield* requireCondition(
      [...clientHostModules].some((allowed) =>
        allowed.endsWith("/") ? module.startsWith(allowed) : module === allowed,
      ),
      `client root entry loads ${module}, which is not a host module`,
    );
    const source = yield* readText(
      file,
      `client root entry is missing ${module}`,
    );
    yield* requireCondition(
      !unresolvableLoad.test(source),
      `client root entry loads a module ${module} names only at run time`,
    );
    const specifiers = importPatterns.flatMap((pattern) =>
      [...source.matchAll(pattern)].map((match) => match[1] ?? ""),
    );
    yield* Effect.forEach(
      specifiers.filter((specifier) => !specifier.startsWith(".")),
      (specifier) =>
        requireCondition(
          hostPackages.has(specifier),
          `client root entry imports ${specifier} through ${module}`,
        ),
      { concurrency: 1, discard: true },
    );
    return specifiers
      .filter((specifier) => specifier.startsWith("."))
      .map((specifier) => resolve(dirname(file), specifier));
  });
}
