/** @file A deadline and confirmed request refusals choose one durable terminal outcome. */

import { scoped as it } from "@effect/vitest";
import {
  Clock,
  Deferred,
  Effect,
  Equal,
  Fiber,
  type FiberId,
  Schema,
  Scope,
  TestClock,
} from "effect";
import { expect } from "vitest";
import type { InboundItem } from "./inbound.js";
import type { CollectivePorts } from "./ports.js";
import { engineFixture } from "../../__tests__/firewall-runtime-fixtures.js";
import { SendError } from "../conversations/errors.js";
import { AgentAddress, MessageAddressInput } from "../records/index.js";
import {
  encodeRuntimeValue,
  type EndpointStore,
  type EndpointStoreError,
} from "../store/index.js";
import { makeCollectiveOperations } from "./index.js";

it("keeps the deadline result when all request refusals finish during finalization", () =>
  Effect.gen(function* () {
    const fixture = yield* refusalRace();
    const sending = yield* fixture.collective
      .send({
        to: Schema.decodeUnknownSync(MessageAddressInput)("agent:bob"),
        text: "Choose a time",
        collective: {
          op: "gather",
          deadline: 60,
          requestedSchema: { type: "object", properties: {} },
        },
      })
      .pipe(Effect.withClock(fixture.clock), Effect.fork);
    yield* Deferred.await(fixture.advance);
    yield* TestClock.adjust("1 minute");
    yield* Deferred.await(fixture.frozen);
    yield* Deferred.succeed(fixture.advanced, undefined);
    yield* TestClock.adjust("0 millis");
    yield* Deferred.succeed(fixture.release, undefined);

    const result = yield* Fiber.join(sending);
    expect(result).toMatchObject({ kind: "collective" });
    expect(fixture.faults).toEqual([]);
    expect(fixture.emitted).toMatchObject([
      { kind: "collectiveResult", id: result.operationId },
    ]);
    expect(yield* fixture.store.readCollectiveOperations()).toMatchObject([
      { phase: "completed" },
    ]);
  }));

interface RaceTime {
  requestsStarted: boolean;
  advanced: boolean;
  owner?: FiberId.FiberId;
}

function refusalRace() {
  return Effect.gen(function* () {
    const subject = yield* engineFixture();
    const controls = yield* raceControls();
    const store = racedStore(subject.store, controls);
    const faults: EndpointStoreError[] = [];
    const emitted: InboundItem[] = [];
    const collective = yield* makeCollectiveOperations({
      store,
      self: Schema.decodeUnknownSync(AgentAddress)("agent:alice"),
      lookupMember: () => Effect.void,
      sendPost: () => {
        controls.time.requestsStarted = true;
        return Effect.fail(new SendError({ reason: "network-unavailable" }));
      },
      bindPost: () => Effect.dieMessage("gather uses request fanout"),
      sendAdmitted: () => Effect.never,
      observePost: () => Effect.never,
      reportStorageFault: (fault) =>
        Effect.sync(() => {
          faults.push(fault);
        }),
      emit: retainedEmitter(subject.store, emitted),
      scope: yield* Scope.Scope,
    });
    return { ...controls, store, collective, emitted, faults };
  });
}

function raceControls(): Effect.Effect<Controls> {
  return Effect.gen(function* () {
    const refused = yield* Deferred.make<undefined>();
    const frozen = yield* Deferred.make<undefined>();
    const release = yield* Deferred.make<undefined>();
    const advanced = yield* Deferred.make<undefined>();
    const advance = yield* Deferred.make<undefined>();
    const time: RaceTime = { requestsStarted: false, advanced: false };
    const controls = { refused, frozen, release, advance, advanced, time };
    return {
      ...controls,
      clock: deadlineClock(yield* Clock.clockWith(Effect.succeed), controls),
    };
  });
}

interface Controls {
  readonly refused: Deferred.Deferred<undefined>;
  readonly frozen: Deferred.Deferred<undefined>;
  readonly release: Deferred.Deferred<undefined>;
  readonly advance: Deferred.Deferred<undefined>;
  readonly advanced: Deferred.Deferred<undefined>;
  readonly time: RaceTime;
  readonly clock: Clock.Clock;
}

/** The owner resumes after refusals only once the deadline has committed its selection. */
function deadlineClock(
  clock: Clock.Clock,
  controls: Omit<Controls, "clock">,
): Clock.Clock {
  const { time, refused, advance, advanced } = controls;
  return {
    [Clock.ClockTypeId]: Clock.ClockTypeId,
    unsafeCurrentTimeMillis: () => clock.unsafeCurrentTimeMillis(),
    unsafeCurrentTimeNanos: () => clock.unsafeCurrentTimeNanos(),
    currentTimeNanos: clock.currentTimeNanos,
    sleep: (duration) => clock.sleep(duration),
    currentTimeMillis: Effect.fiberId.pipe(
      Effect.flatMap((current) => {
        if (
          !time.requestsStarted ||
          time.advanced ||
          !Equal.equals(current, time.owner)
        ) {
          return clock.currentTimeMillis;
        }
        time.advanced = true;
        return Deferred.await(refused).pipe(
          Effect.zipRight(Effect.yieldNow()),
          Effect.zipRight(Deferred.succeed(advance, undefined)),
          Effect.zipRight(Deferred.await(advanced)),
          Effect.zipRight(clock.currentTimeMillis),
        );
      }),
    ),
  };
}

function racedStore(store: EndpointStore, controls: Controls): EndpointStore {
  return {
    ...store,
    putCollectiveOperation: (operation) =>
      Effect.fiberId.pipe(
        Effect.tap((owner) =>
          Effect.sync(() => {
            controls.time.owner = owner;
          }),
        ),
        Effect.zipRight(store.putCollectiveOperation(operation)),
      ),
    recordCollectiveRefusal: (refusal) =>
      store
        .recordCollectiveRefusal(refusal)
        .pipe(Effect.tap(() => Deferred.succeed(controls.refused, undefined))),
    finalizeCollectiveOperation: (id, selection) =>
      store.finalizeCollectiveOperation(id, selection).pipe(
        Effect.tap(() => Deferred.succeed(controls.frozen, undefined)),
        Effect.tap(() => Deferred.await(controls.release)),
      ),
  };
}

function retainedEmitter(
  store: EndpointStore,
  emitted: InboundItem[],
): CollectivePorts["emit"] {
  return (item, ...[, terminal]) =>
    Effect.gen(function* () {
      if (terminal === undefined) {
        return yield* Effect.dieMessage("expected retained result");
      }
      yield* store.publishCollectiveItem({
        ...terminal,
        canonicalItem: yield* encodeRuntimeValue(item),
        conversation: "agent:bob",
        firewall: false,
      });
      emitted.push(item);
    }).pipe(Effect.orDie);
}
