/** @file Saved identity survives restart and rejected registration never assigns it. */

import { scopedLive as it } from "@effect/vitest";
import { Context, Effect, Layer } from "effect";
import { describe, expect } from "vitest";
import {
  type Fixture,
  identityLayerFor,
  makeFixture,
} from "../__tests__/daemon-runtime-fixtures.js";
import {
  stateDirectory,
  withDaemonStore,
} from "../__tests__/store-schema-fixtures.js";
import { agentViewOf } from "./cards.js";
import { Identity } from "./local.js";
import {
  RegistryConnectionError,
  type RegistryRegisterResult,
} from "./registry/contract.js";
import { Registry } from "./registry/index.js";
import { AuthenticationFailedError } from "./signing/http-errors.js";

const registry = (
  result: RegistryRegisterResult,
): Context.Tag.Service<typeof Registry> => ({
  register: () => Effect.succeed(result),
  lookup: () => Effect.succeed({ kind: "not_found" }),
});

function openIdentity(
  fixture: Fixture,
  service: Context.Tag.Service<typeof Registry>,
) {
  return Layer.build(identityLayerFor(fixture.bootstrap)).pipe(
    Effect.provideService(Registry, service),
    Effect.map((context) => Context.get(context, Identity)),
  );
}

const registersDurably = () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    const directory = stateDirectory();
    yield* withDaemonStore(directory, () =>
      Effect.gen(function* () {
        const identity = yield* openIdentity(
          fixture,
          registry({ kind: "registered", agentCard: fixture.localCard }),
        );
        expect(yield* identity.me()).toEqual({ kind: "unregistered" });
        expect(yield* identity.register(fixture.registerRequest)).toEqual(
          agentViewOf(fixture.localCard),
        );
      }),
    );
    yield* withDaemonStore(directory, () =>
      Effect.gen(function* () {
        const identity = yield* openIdentity(
          {
            ...fixture,
            bootstrap: {
              ...fixture.bootstrap,
              admissionCredential: Effect.dieMessage(
                "Saved identity must not load admission",
              ),
            },
          },
          registry({ kind: "name_taken" }),
        );
        expect(yield* identity.me()).toEqual({
          kind: "registered",
          agent: agentViewOf(fixture.localCard),
        });
      }),
    );
  });

const leavesRefusalUnregistered = () =>
  withDaemonStore(stateDirectory(), (store) =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const identity = yield* openIdentity(
        fixture,
        registry({ kind: "name_taken" }),
      );
      expect(
        yield* identity.register(fixture.registerRequest).pipe(Effect.flip),
      ).toMatchObject({ reason: "name_taken" });
      expect(yield* identity.me()).toEqual({ kind: "unregistered" });
      expect(yield* store.readIdentity()).toBeUndefined();
    }),
  );

const rejectsWrongCard = () =>
  withDaemonStore(stateDirectory(), (store) =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const other = yield* makeFixture;
      const identity = yield* openIdentity(
        fixture,
        registry({ kind: "registered", agentCard: other.localCard }),
      );
      expect(
        yield* identity.register(fixture.registerRequest).pipe(Effect.flip),
      ).toMatchObject({ reason: "incompatible-daemon" });
      expect(yield* store.readIdentity()).toBeUndefined();
    }),
  );

const projectsRegistryFailures = () =>
  withDaemonStore(stateDirectory(), () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const base = registry({ kind: "name_taken" });
      const unavailable = yield* openIdentity(fixture, {
        ...base,
        register: () => new RegistryConnectionError(),
      });
      expect(
        yield* unavailable.register(fixture.registerRequest).pipe(Effect.flip),
      ).toMatchObject({ reason: "dependency-unavailable" });
      const refused = yield* openIdentity(fixture, {
        ...base,
        register: () => new AuthenticationFailedError(),
      });
      expect(
        yield* refused.register(fixture.registerRequest).pipe(Effect.flip),
      ).toMatchObject({ reason: "admission-refused" });
    }),
  );

// @agent-code-guard/regression-only: local registration is durable and trusts only cards belonging to its configured identity.
describe("local identity", () => {
  it(
    "recovers a saved identity without admission credentials",
    registersDurably,
  );
  it("leaves a refused registration unregistered", leavesRefusalUnregistered);
  it("rejects a returned card for another request", rejectsWrongCard);
  it("returns closed Registry failures", projectsRegistryFailures);
});
