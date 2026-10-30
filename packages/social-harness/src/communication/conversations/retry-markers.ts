/**
 * @file The `retry.pending` and `retry.settled` marker spans. They bracket
 * daemon work in flight that can wait for seconds or minutes and emit
 * nothing meanwhile, so a trace reader counts the daemon busy from one to
 * the other.
 */

import { Effect, Exit } from "effect";

/**
 * What a marked wait does:
 * - `proposal`: an author's proposal resends;
 * - `catch-up`: a conversation's catch-up retries, or the quorum recovery
 *   that takes over from them;
 * - `reanchor`: a restarted conversation's wait for its re-anchor;
 * - `outbound`: the outbox drain, including its waits for the Router;
 * - `firewall-check`: one firewall check;
 * - `webhook`: a webhook delivery's retries.
 */
export type RetryKind =
  | "proposal"
  | "catch-up"
  | "reanchor"
  | "outbound"
  | "firewall-check"
  | "webhook";

/**
 * How a marked wait ended, as its `retry.settled` span's `outcome`:
 * - `certified`: a proposal certified;
 * - `superseded`: a later proposal, a moved head or a re-anchor round took over;
 * - `recovered`: a conversation recovered;
 * - `sent`: the outbox emptied;
 * - `checked`: a check decided;
 * - `delivered`: a webhook host acknowledged its delivery;
 * - `gave-up`: the attempts ran out, or a webhook delivery stalled;
 * - `interrupted`: the engine, the run or a replacing arm ended it;
 * - `failed`: a store read, a fatal failure or a defect ended it.
 */
export type RetryOutcome =
  | "certified"
  | "superseded"
  | "recovered"
  | "sent"
  | "checked"
  | "delivered"
  | "gave-up"
  | "interrupted"
  | "failed";

/**
 * The outcome of a marked wait from its exit, once the caller has ruled out
 * the outcomes only it can name.
 * @param exit How the bracketed effect ended.
 * @param succeeded The outcome when it succeeded.
 * @returns `succeeded`, `interrupted`, or `failed` for a failure or defect.
 */
export function exitOutcome(
  exit: Exit.Exit<unknown, unknown>,
  succeeded: RetryOutcome,
): RetryOutcome {
  if (Exit.isSuccess(exit)) {
    return succeeded;
  }
  return Exit.isInterrupted(exit) ? "interrupted" : "failed";
}

/**
 * Record the short `retry.pending` span that opens a marked wait.
 * @param kind What waits.
 * @param id What the wait is for: a message, conversation or delivery id, a
 *     check's direction, or `outbox`. A reader pairs pending and settled
 *     spans by count per kind and id, so a reused id pairs correctly.
 * @returns Completion once the span is recorded.
 */
export function retryPending(kind: RetryKind, id: string): Effect.Effect<void> {
  return Effect.withSpan(Effect.void, "retry.pending", {
    captureStackTrace: false,
    attributes: { kind, id },
  });
}

/**
 * Record the short `retry.settled` span that closes a marked wait. Each
 * pending span gets exactly one.
 * @param kind What waited.
 * @param id The id its pending span carried.
 * @param outcome How the wait ended.
 * @returns Completion once the span is recorded.
 */
export function retrySettled(
  kind: RetryKind,
  id: string,
  outcome: RetryOutcome,
): Effect.Effect<void> {
  return Effect.withSpan(Effect.void, "retry.settled", {
    captureStackTrace: false,
    attributes: { kind, id, outcome },
  });
}

/**
 * Bracket an effect with one pending span when it starts and one settled
 * span when it ends, however it ends.
 * @param kind What the effect waits on.
 * @param id What the wait is for.
 * @param outcome How the wait ended, named from the effect's exit.
 * @returns The effect, bracketed.
 */
export function markRetries<A, E, R>(
  kind: RetryKind,
  id: string,
  outcome: (exit: Exit.Exit<A, E>) => RetryOutcome,
): (retries: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R> {
  return (retries) =>
    Effect.uninterruptibleMask((restore) =>
      retryPending(kind, id).pipe(
        Effect.zipRight(restore(retries)),
        Effect.onExit((exit) => retrySettled(kind, id, outcome(exit))),
      ),
    );
}
