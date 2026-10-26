/** @file Closed daemon failures shared by startup, activation and supervision. */

import { Data } from "effect";

/** Closed private daemon failure projected onto the public startup phases. */
export class DaemonRuntimeError extends Data.TaggedError("DaemonRuntimeError")<{
  readonly phase: "storage" | "listener" | "registration";
  readonly reason?:
    | "outbox-too-old"
    | "agent-not-admitted"
    | "admission-refused"
    | "name_taken"
    | "key_already_registered"
    | "idempotency_conflict"
    | "dependency-unavailable"
    | "persistence-failed"
    | "incompatible-daemon";
}> {}

/** Closed activation failure retained behind the daemon runtime boundary. */
export class DaemonActivationError extends Data.TaggedError(
  "DaemonActivationError",
)<{
  readonly reason:
    | "upstream"
    | "persistence"
    | "representation"
    | "outbox-too-old";
}> {}

/** The daemon failure for the phase the daemon stopped in. */
export const runtimeFailure = (
  phase: DaemonRuntimeError["phase"],
): DaemonRuntimeError => new DaemonRuntimeError({ phase });

/** The activation failure for why the protocol could not activate. */
export const activationFailure = (
  reason: DaemonActivationError["reason"],
): DaemonActivationError => new DaemonActivationError({ reason });
