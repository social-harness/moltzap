/** @file Native HTTP metadata stays private and the Client receipt owns its own lifetime. */
import { FetchHttpClient, HttpServerResponse } from "@effect/platform";
import { scopedLive as it, scoped as withClock } from "@effect/vitest";
import {
  Deferred,
  Effect,
  Fiber,
  Option,
  Redacted,
  TestClock,
  Tracer,
} from "effect";
import { describe, expect } from "vitest";
import { localProvider } from "./__tests__/provider.js";
import { deliverToGrokBot } from "./index.js";

const privateQuery = "private-query";
const routine = {
  url: new URL(`https://routine.example.test/private?route=${privateQuery}`),
  key: Redacted.make("synthetic-key"),
};
const eventId = `dlv_${"A".repeat(43)}`;
const privateHeader = "private-provider-header";

function collectTracing() {
  const spans: Tracer.Span[] = [];
  return Tracer.tracerWith((base) =>
    Effect.succeed({
      spans,
      tracer: Tracer.make({
        context: (run, fiber) => base.context(run, fiber),
        span: (...args) => {
          const span = base.span(...args);
          spans.push(span);
          return span;
        },
      }),
    }),
  );
}

function keepsHttpMetadataPrivate() {
  return Effect.gen(function* () {
    const provider = yield* localProvider(
      Effect.succeed(
        HttpServerResponse.empty({
          headers: { "x-private-provider": privateHeader },
        }),
      ),
    );
    const { tracer, spans } = yield* collectTracing();
    yield* deliverToGrokBot(routine, {
      eventId,
      acknowledge: Effect.void,
    }).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.Fetch, provider.fetch),
      Effect.withTracer(tracer),
    );
    expect(spans).not.toEqual([]);
    const attributes = JSON.stringify(
      spans.map((span) => Array.from(span.attributes)),
    );
    expect(attributes).not.toContain(routine.url.hostname);
    expect(attributes).not.toContain(privateQuery);
    expect(attributes).not.toContain(privateHeader);
    expect(attributes).not.toContain(Redacted.value(routine.key));
  });
}

function separatesReceiptLifetime() {
  return Effect.gen(function* () {
    const provider = yield* localProvider(
      Effect.succeed(HttpServerResponse.empty()),
    );
    const started = yield* Deferred.make<boolean>();
    const finish = yield* Deferred.make<undefined>();
    const waiting = yield* deliverToGrokBot(routine, {
      eventId,
      acknowledge: Effect.suspend(() =>
        Deferred.succeed(started, provider.signals[0]?.aborted === true),
      ).pipe(Effect.zipRight(Deferred.await(finish))),
    }).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.Fetch, provider.fetch),
      Effect.forkScoped,
    );
    expect(yield* Deferred.await(started)).toBe(true);
    yield* TestClock.adjust("4 seconds");
    expect(Option.isNone(yield* Fiber.poll(waiting))).toBe(true);
    yield* Deferred.succeed(finish, undefined);
    yield* Fiber.join(waiting);
  });
}

describe("Grok handoff boundaries", () => {
  it(
    "keeps private HTTP metadata out of exported spans",
    keepsHttpMetadataPrivate,
  );
  withClock(
    "closes HTTP before a Client receipt that outlives the provider deadline",
    separatesReceiptLifetime,
  );
});
