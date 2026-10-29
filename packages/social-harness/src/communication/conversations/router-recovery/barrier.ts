/**
 * @file Recovery fences shared by protocol activation and recovery: one for
 * the whole engine while a Router discontinuity has no recovery run yet, and
 * one per conversation that run has not recovered.
 */

import { Deferred, Effect } from "effect";
import type { ConversationId } from "../../records/index.js";
import type { EngineRuntime } from "../engine-context.js";

/**
 * An engine's recovery fences. The engine fence holds every send from a
 * discontinuity until its recovery run has verified durable history and
 * fenced each conversation it holds. From then on a send waits only for its
 * own conversation's fence, so a conversation that cannot recover holds no
 * other.
 */
interface RecoveryFences {
  engine?: Deferred.Deferred<undefined>;
  readonly conversations: Map<ConversationId, Deferred.Deferred<undefined>>;
}

const recoveryFences = new WeakMap<EngineRuntime, RecoveryFences>();

/**
 * Install the one engine fence shared by all retries of a discontinuity.
 * @param runtime Engine entering Router recovery under its protocol gate.
 * @returns Completion after an engine fence exists.
 */
export function installRecoveryBarrier(
  runtime: EngineRuntime,
): Effect.Effect<void> {
  return Effect.suspend(() => {
    if (fencesOf(runtime).engine !== undefined) {
      return Effect.void;
    }
    return Deferred.make<undefined>().pipe(
      Effect.flatMap((barrier) =>
        Effect.sync(() => {
          fencesOf(runtime).engine ??= barrier;
        }),
      ),
    );
  });
}

/**
 * Read the engine fence a discontinuity installed.
 * @param runtime Engine whose recovery state guards action activation.
 * @returns The pending engine fence, or absence once a recovery run holds
 *     each conversation's own fence.
 */
export function currentRecoveryBarrier(
  runtime: EngineRuntime,
): Deferred.Deferred<undefined> | undefined {
  return recoveryFences.get(runtime)?.engine;
}

/**
 * Release the exact engine fence once a recovery run holds each
 * conversation's own fence.
 * @param runtime Engine whose recovery run has started.
 * @param barrier Engine fence captured by that recovery attempt.
 * @returns Completion after waiters resume and the fence is removed.
 */
export function completeRecoveryBarrier(
  runtime: EngineRuntime,
  barrier: Deferred.Deferred<undefined>,
): Effect.Effect<void> {
  return Effect.suspend(() => {
    const fences = recoveryFences.get(runtime);
    if (fences?.engine !== barrier) {
      return Effect.void;
    }
    delete fences.engine;
    return Deferred.succeed(barrier, undefined).pipe(Effect.asVoid);
  });
}

/**
 * Fence a conversation until its recovery completes. A conversation already
 * fenced keeps its fence and the sends waiting on it.
 * @param runtime Engine whose recovery run holds the conversation.
 * @param conversationId Conversation to fence.
 * @returns Completion after the conversation is fenced.
 */
export function fenceConversation(
  runtime: EngineRuntime,
  conversationId: ConversationId,
): Effect.Effect<void> {
  return Deferred.make<undefined>().pipe(
    Effect.flatMap((fence) =>
      Effect.sync(() => {
        const { conversations } = fencesOf(runtime);
        if (!conversations.has(conversationId)) {
          conversations.set(conversationId, fence);
        }
      }),
    ),
  );
}

/**
 * Release a recovered conversation's fence, resuming the sends that wait on
 * it.
 * @param runtime Engine whose recovery run recovered the conversation.
 * @param conversationId Conversation that recovered.
 * @returns Completion after its waiters resume.
 */
export function releaseConversation(
  runtime: EngineRuntime,
  conversationId: ConversationId,
): Effect.Effect<void> {
  return Effect.suspend(() => {
    const fences = recoveryFences.get(runtime);
    const fence = fences?.conversations.get(conversationId);
    if (fences === undefined || fence === undefined) {
      return Effect.void;
    }
    fences.conversations.delete(conversationId);
    return Deferred.succeed(fence, undefined).pipe(Effect.asVoid);
  });
}

/**
 * The fence traffic for `conversationId` waits behind: the engine fence while
 * a discontinuity has no recovery run, otherwise that conversation's own
 * fence.
 * @param runtime Engine whose recovery state guards the conversation.
 * @param conversationId Conversation the send or ingress targets.
 * @returns The pending fence, or absence when the conversation is open.
 */
export function pendingRecoveryFence(
  runtime: EngineRuntime,
  conversationId: ConversationId,
): Deferred.Deferred<undefined> | undefined {
  const fences = recoveryFences.get(runtime);
  return fences?.engine ?? fences?.conversations.get(conversationId);
}

function fencesOf(runtime: EngineRuntime): RecoveryFences {
  const retained = recoveryFences.get(runtime);
  if (retained !== undefined) {
    return retained;
  }
  const created: RecoveryFences = { conversations: new Map() };
  recoveryFences.set(runtime, created);
  return created;
}
