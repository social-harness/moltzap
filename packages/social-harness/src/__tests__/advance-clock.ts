/** @file Steps the TestClock so fibers woken by each step can sleep again, and waits in live time for work the TestClock cannot step. */

import { Duration, Effect, Schedule, TestClock, TestServices } from "effect";

const STEP = Duration.millis(250);

/**
 * Advance the TestClock in 250 ms steps, yielding between them so every fiber
 * a step wakes registers its next sleep before the following step. A yield
 * does not wait for work that settles on real promises, such as sealing and
 * signing an outer envelope; wait for its result with `untilLive` before
 * stepping the clock past a timer that work starts.
 * @param span Total virtual time to pass.
 * @returns Completion once the clock has moved by `span`.
 */
export function advanceClock(
  span: Duration.DurationInput,
): Effect.Effect<void> {
  const steps = Math.ceil(
    Duration.toMillis(Duration.decode(span)) / Duration.toMillis(STEP),
  );
  return Effect.forEach(
    Array.from({ length: steps }),
    () => TestClock.adjust(STEP).pipe(Effect.zipRight(Effect.yieldNow())),
    { concurrency: 1, discard: true },
  );
}

/**
 * Wait in live time until `ready` reads true, polling every 5 ms. A condition
 * that never holds ends at the test's timeout.
 * @param ready Condition the system under test reaches on its own.
 * @returns Completion once `ready` reads true.
 */
export function untilLive(ready: Effect.Effect<boolean>): Effect.Effect<void> {
  return TestServices.provideLive(
    ready.pipe(
      Effect.repeat({
        until: (met) => met,
        schedule: Schedule.spaced("5 millis"),
      }),
    ),
  ).pipe(Effect.asVoid);
}
