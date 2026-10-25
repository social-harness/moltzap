/** @file Bounded long-poll waiter coordination keyed by addressed agent. */
import type { AgentId } from "@moltzap/client";
import { Data, Deferred, Effect, Ref } from "effect";

/** Bounded addressed-notification capability. */
export interface PollWaiters {
  readonly awaitSignal: (
    agentId: AgentId,
    addressedDataIsReady: Effect.Effect<boolean>,
  ) => Effect.Effect<void, HeldPollCapacityError>;
  readonly notify: (recipients: ReadonlySet<AgentId>) => Effect.Effect<void>;
  readonly activeCount: Effect.Effect<number>;
}

/**
 * Creates request-scoped poll waiters with global and per-agent bounds.
 *
 * @param capacity Maximum simultaneous poll waiters.
 * @returns The bounded waiter capability.
 */
export const makePollWaiters = (capacity: number): Effect.Effect<PollWaiters> =>
  Effect.gen(function* () {
    const waiters = yield* Ref.make<Waiters>(new Map());
    const service: PollWaiters = {
      awaitSignal: (
        agentId: AgentId,
        addressedDataIsReady: Effect.Effect<boolean>,
      ) =>
        awaitRegisteredWaiter(waiters, capacity, agentId, addressedDataIsReady),
      notify: (recipients: ReadonlySet<AgentId>) =>
        notifyWaiters(waiters, recipients),
      activeCount: Ref.get(waiters).pipe(Effect.map((current) => current.size)),
    };
    return Object.freeze(service);
  }).pipe(Effect.withSpan("makePollWaiters"));

/** No poll-waiter slot is immediately available. */
class HeldPollCapacityError extends Data.TaggedError("HeldPollCapacityError") {}

type Waiter = Deferred.Deferred<undefined>;
type Waiters = ReadonlyMap<AgentId, Waiter>;

const removeWaiter = (
  waiters: Ref.Ref<Waiters>,
  agentId: AgentId,
  deferred: Waiter,
): Effect.Effect<void> =>
  Ref.update(waiters, (current) => {
    if (current.get(agentId) !== deferred) {
      return current;
    }
    const next = new Map(current);
    next.delete(agentId);
    return next;
  });

const registerWaiter = (
  waiters: Ref.Ref<Waiters>,
  capacity: number,
  agentId: AgentId,
  deferred: Waiter,
): Effect.Effect<boolean> =>
  Ref.modify(waiters, (current): readonly [boolean, Waiters] => {
    if (current.has(agentId) || current.size >= capacity) {
      return [false, current];
    }
    const next = new Map(current);
    next.set(agentId, deferred);
    return [true, next];
  });

const detachWaiters = (
  waiters: Ref.Ref<Waiters>,
  recipients: ReadonlySet<AgentId>,
): Effect.Effect<readonly Waiter[]> =>
  Ref.modify(waiters, (current): readonly [readonly Waiter[], Waiters] => {
    const next = new Map(current);
    const found: Waiter[] = [];
    for (const agentId of recipients) {
      const deferred = next.get(agentId);
      if (deferred !== undefined) {
        found.push(deferred);
        next.delete(agentId);
      }
    }
    return [found, next];
  });

function awaitRegisteredWaiter(
  waiters: Ref.Ref<Waiters>,
  capacity: number,
  agentId: AgentId,
  addressedDataIsReady: Effect.Effect<boolean>,
): Effect.Effect<void, HeldPollCapacityError> {
  return Effect.gen(function* () {
    const deferred = yield* Deferred.make<undefined>();
    const registered = yield* registerWaiter(
      waiters,
      capacity,
      agentId,
      deferred,
    );
    if (!registered) {
      return yield* Effect.fail(new HeldPollCapacityError());
    }
    return yield* Effect.gen(function* () {
      if (yield* addressedDataIsReady) {
        return;
      }
      yield* Deferred.await(deferred);
    }).pipe(Effect.ensuring(removeWaiter(waiters, agentId, deferred)));
  });
}

function notifyWaiters(
  waiters: Ref.Ref<Waiters>,
  recipients: ReadonlySet<AgentId>,
): Effect.Effect<void> {
  return detachWaiters(waiters, recipients).pipe(
    Effect.flatMap((detached) =>
      Effect.forEach(
        detached,
        (deferred) => Deferred.succeed(deferred, undefined),
        { concurrency: 128, discard: true },
      ),
    ),
  );
}
