/** @file A reported protocol storage fault stops the real daemon runtime. */

import { scopedLive as it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";
import { expect } from "vitest";
import {
  makeFixture,
  runRegisteredFixture,
  runtimeDependencies,
} from "../../__tests__/daemon-runtime-fixtures.js";
import {
  stateDirectory,
  withDaemonStore,
} from "../../__tests__/store-schema-fixtures.js";
import { makeEndpointEngine } from "../../communication/conversations/index.js";
import { EndpointStoreError } from "../../communication/store/index.js";
import { DaemonRuntimeError } from "../lifecycle.js";

const stopsOnReportedFault = () =>
  withDaemonStore(stateDirectory(), (store) =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      yield* store.bindIdentity({
        agentId: fixture.localCard.agentId,
        canonicalAgentCard: fixture.canonicalLocalCard,
      });
      const reported = yield* Deferred.make<Effect.Effect<void>>();
      const ready = yield* Deferred.make<undefined>();
      const dependencies = {
        ...runtimeDependencies(() =>
          Deferred.succeed(ready, undefined).pipe(Effect.asVoid),
        ),
        makeEngine: (input: Parameters<typeof makeEndpointEngine>[0]) =>
          Deferred.succeed(
            reported,
            input.reportStorageFault(
              new EndpointStoreError({ reason: "persistence" }),
            ),
          ).pipe(Effect.zipRight(makeEndpointEngine(input))),
      };
      const daemon = yield* runRegisteredFixture(fixture, dependencies).pipe(
        Effect.forkScoped,
      );
      yield* Deferred.await(ready).pipe(Effect.raceFirst(Fiber.join(daemon)));
      yield* Effect.flatten(Deferred.await(reported));
      expect(yield* Fiber.join(daemon).pipe(Effect.flip)).toEqual(
        new DaemonRuntimeError({ phase: "storage" }),
      );
    }),
  );

it("stops when the engine reports a storage fault", stopsOnReportedFault);
