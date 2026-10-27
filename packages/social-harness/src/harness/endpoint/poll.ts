/** @file Lease renewal remains live independently of downstream host acceptance. */

import { type Client, fromJsonSchema } from "@modelcontextprotocol/client";
import { Effect, Queue, Stream, Take } from "effect";
import { ListenError } from "../../communication/conversations/errors.js";
import {
  HARNESS_CONSUMER_META_KEY,
  INBOX_ITEM_EVENT,
} from "../protocol/names.js";
import { decodePollResult, type PollResult } from "../protocol/operations.js";
import { listenFailure } from "./failures.js";

const resultSchema = fromJsonSchema({ type: "object" });
const request = (client: Client, params: Readonly<Record<string, unknown>>) =>
  Effect.tryPromise({
    try: (signal) =>
      client.request({ method: "events/poll", params }, resultSchema, {
        signal,
      }),
    catch: listenFailure,
  }).pipe(
    Effect.flatMap((value) =>
      decodePollResult(value).pipe(
        Effect.catchTag("ParseError", () =>
          Effect.fail(new ListenError({ reason: "decode-failed" })),
        ),
      ),
    ),
  );

const metadata = (generation: string) => ({
  [HARNESS_CONSUMER_META_KEY]: { generation },
});

interface Reception {
  readonly client: Client;
  readonly queue: Queue.Queue<Take.Take<undefined, ListenError>>;
  position?: PollResult;
}

const setPosition = (state: Reception, position: PollResult) =>
  Effect.sync(() => {
    state.position = position;
  });

/** Install the acquired generation before cancellation can enter finalization. */
const open = (state: Reception) =>
  Effect.uninterruptibleMask((restore) =>
    restore(
      request(state.client, {
        name: INBOX_ITEM_EVENT,
        arguments: {},
        cursor: null,
      }),
    ).pipe(Effect.tap((position) => setPosition(state, position))),
  );

const release = (state: Reception) =>
  Effect.suspend(() =>
    state.position === undefined
      ? Effect.void
      : request(state.client, {
          name: INBOX_ITEM_EVENT,
          arguments: {},
          cursor: null,
          _meta: {
            [HARNESS_CONSUMER_META_KEY]: {
              generation:
                state.position._meta[HARNESS_CONSUMER_META_KEY].generation,
              release: true,
            },
          },
        }).pipe(
          Effect.interruptible,
          Effect.timeoutOption("5 seconds"),
          Effect.ignore,
        ),
  );

const receive = Effect.fn("poll.receive")(function* (
  state: Reception,
  generation: string,
) {
  const result = yield* request(state.client, {
    name: INBOX_ITEM_EVENT,
    arguments: {},
    cursor: state.position?.cursor,
    _meta: metadata(generation),
  });
  if (result._meta[HARNESS_CONSUMER_META_KEY].generation !== generation) {
    return yield* Effect.fail(new ListenError({ reason: "decode-failed" }));
  }
  yield* setPosition(state, result);
  if (result.events.length !== 0 || result.truncated) {
    yield* Queue.offer(state.queue, Take.of(undefined));
  }
  if (!result.hasMore) {
    yield* Effect.sleep(Math.max(result.nextPollMs, 1000));
  }
});

/**
 * The first poll acquires ownership before unread recovery. A sliding queue
 * coalesces wakeups while a scoped fiber renews the lease during slow host work.
 * Local receipts are revoked before bounded remote release, including failed
 * readiness. Acquisition is interruptible; a lost response relies on lease expiry.
 *
 * ```mermaid
 * sequenceDiagram
 *   participant Host
 *   participant Client
 *   participant Daemon
 *   Client->>Daemon: Acquire poll consumer at now
 *   Daemon-->>Client: Generation and cursor
 *   Client->>Client: Start scoped renewal
 *   Client-->>Host: Receiver ready
 *   Client->>Daemon: Recover unread inbox
 *   loop While host accepts work
 *     Client->>Daemon: Renew and poll
 *     Daemon-->>Client: Coalesced wakeup
 *   end
 *   Client->>Client: Disable local receipts
 *   Client->>Daemon: Bounded best-effort release
 * ```
 */
export const pollWakeups = (
  client: Client,
  fence: Effect.Effect<void>,
  onReady: Effect.Effect<void>,
): Stream.Stream<Readonly<Record<string, unknown>>, ListenError> =>
  Stream.unwrapScoped(
    Effect.gen(function* () {
      const queue = yield* Queue.sliding<Take.Take<undefined, ListenError>>(1);
      const state: Reception = { client, queue };
      yield* Effect.addFinalizer(() =>
        fence.pipe(
          Effect.andThen(release(state)),
          Effect.ensuring(Queue.shutdown(queue)),
        ),
      );
      const first = yield* open(state);
      const generation = first._meta[HARNESS_CONSUMER_META_KEY].generation;
      yield* Queue.offer(queue, Take.of(undefined));
      yield* receive(state, generation).pipe(
        Effect.forever,
        Effect.catchAll((error) =>
          fence.pipe(Effect.andThen(Queue.offer(queue, Take.fail(error)))),
        ),
        Effect.forkScoped,
      );
      yield* onReady;
      return Stream.fromQueue(queue).pipe(
        Stream.flattenTake,
        Stream.as(metadata(generation)),
      );
    }).pipe(Effect.withSpan("pollWakeups")),
  );
