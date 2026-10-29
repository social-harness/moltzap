/** @file Optional credential separation for tunneled runtime and owner requests. */

import { Redacted } from "effect";
import { createHash, timingSafeEqual } from "node:crypto";

/** File-loaded credentials never enter a model-visible MCP representation. */
export interface HarnessMcpCredentials {
  readonly runtime: Redacted.Redacted;
  readonly owner: Redacted.Redacted;
}

/** Trusted-local access or an explicitly authenticated authority. */
export type HarnessMcpRole = "local" | "runtime" | "owner";

const digest = (value: string): Uint8Array =>
  createHash("sha256").update(value).digest();

/**
 * Compare fixed-size digests without disclosing credential bytes or lengths.
 * @param supplied Presented bearer value.
 * @param expected File-loaded private credential.
 * @returns Whether both values denote the same authority.
 */
export const credentialMatches = (
  supplied: string,
  expected: Redacted.Redacted,
): boolean =>
  timingSafeEqual(digest(supplied), digest(Redacted.value(expected)));

/**
 * Authenticate before SDK or extension dispatch, including discovery and errors.
 * @param request Incoming request on the guarded loopback listener.
 * @param credentials Explicit tunneled-mode authority, absent in trusted-local mode.
 * @returns The authorized role, or no authority for an invalid request.
 */
export const authenticateHarnessRequest = (
  request: Request,
  credentials?: HarnessMcpCredentials,
): HarnessMcpRole | undefined => {
  if (credentials === undefined) {
    return "local";
  }
  const authorization = request.headers.get("authorization");
  if (authorization === null || !authorization.startsWith("Bearer ")) {
    return undefined;
  }
  const supplied = authorization.slice("Bearer ".length);
  if (credentialMatches(supplied, credentials.owner)) {
    return "owner";
  }
  return credentialMatches(supplied, credentials.runtime)
    ? "runtime"
    : undefined;
};
