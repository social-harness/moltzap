/**
 * @file The docs reader of the Social Harness wire compatibility literal.
 *
 * Source readers share one literal pattern without executing Client code.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Workspace-relative source of `WIRE_VERSION`. */
export const WIRE_VERSION_SOURCE =
  "packages/client/src/identity/wire-version.ts";

/** Matches the literal export; group 1 is the value. */
export const WIRE_VERSION_LITERAL =
  /export\s+const\s+WIRE_VERSION\s*=\s*["']([^"']*)["']/;

/**
 * Read the literal from the workspace, or explain why it could not be read.
 * @param workspaceRoot Absolute workspace root.
 * @returns The trimmed literal, or an error message.
 */
export const readCompatibilityVersion = (
  workspaceRoot: string,
): { readonly value: string } | { readonly error: string } => {
  const filePath = resolve(workspaceRoot, WIRE_VERSION_SOURCE);
  let source: string;
  try {
    source = readFileSync(filePath, "utf8");
  } catch (cause) {
    return {
      error: `could not read ${WIRE_VERSION_SOURCE}: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }
  return parseCompatibilityVersion(source);
};

/** Read the emitted wire value from source text, including a committed tree. */
export function parseCompatibilityVersion(
  source: string,
): { readonly value: string } | { readonly error: string } {
  const match = WIRE_VERSION_LITERAL.exec(source);
  if (match === null) {
    return {
      error: `expected \`export const WIRE_VERSION = "..."\` in ${WIRE_VERSION_SOURCE}`,
    };
  }
  const value = (match[1] ?? "").trim();
  return value.length === 0
    ? { error: `expected a nonempty version in ${WIRE_VERSION_SOURCE}` }
    : { value };
}
