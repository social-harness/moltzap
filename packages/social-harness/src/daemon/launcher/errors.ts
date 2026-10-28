/** @file The launcher's one closed failure and the docs its messages link. */

import { Data } from "effect";

/** The launcher rules, which its `--help` and command and seed failures link. */
export const LAUNCHER_DOCS =
  "https://docs.moltzap.xyz/spec/harness/daemon#launcher";

/** The upgrades guide, whose troubleshooting entries launcher failures link. */
export const UPGRADES_GUIDE = "https://docs.moltzap.xyz/guides/upgrades";

/**
 * Why the launcher could not prepare or start a daemon. `registry` and
 * `provenance` failures only ever keep the recorded release; the other
 * reasons stop the start, since no release could be run safely.
 */
export class LauncherError extends Data.TaggedError("LauncherError")<{
  readonly reason:
    | "configuration"
    | "seed"
    | "record"
    | "integrity"
    | "registry"
    | "provenance"
    | "install"
    | "start";
  readonly message: string;
}> {}

/**
 * The failure for `reason`, with a message naming what failed.
 *
 * @param reason The closed reason.
 * @param message What failed, with paths and versions but never file contents.
 * @returns The failure.
 */
export const launcherError = (
  reason: LauncherError["reason"],
  message: string,
): LauncherError => new LauncherError({ reason, message });
