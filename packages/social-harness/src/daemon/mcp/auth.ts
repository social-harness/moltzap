/** @file Bearer authentication for every request to one agent's daemon. */

import { Redacted } from "effect";
import { createHash, timingSafeEqual } from "node:crypto";

const digest = (value: string): Uint8Array =>
  createHash("sha256").update(value).digest();

/** Compares fixed-size digests without disclosing credential bytes or lengths. */
const credentialMatches = (
  supplied: string,
  expected: Redacted.Redacted,
): boolean =>
  timingSafeEqual(digest(supplied), digest(Redacted.value(expected)));

/** Authenticates discovery, operations and transport extensions with the same credential. */
export const authenticateHarnessRequest = (
  request: Request,
  credential: Redacted.Redacted,
): boolean => {
  const authorization = request.headers.get("authorization");
  return (
    authorization !== null &&
    authorization.startsWith("Bearer ") &&
    credentialMatches(authorization.slice("Bearer ".length), credential)
  );
};
