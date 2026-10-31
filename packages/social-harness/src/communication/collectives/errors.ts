/** @file Closed failures callers can distinguish at the collective boundary. */

import { Data } from "effect";

/** Operation failures remain distinct from messaging and storage failures. */
export class CollectivesError extends Data.TaggedError("CollectivesError")<{
  readonly reason:
    | "not-registered"
    | "invalid-question"
    | "request-none"
    | "request-expired"
    | "request-answered"
    | "answer-invalid"
    | "persistence-failed"
    | "message-failed";
  readonly detail?: string;
}> {}
