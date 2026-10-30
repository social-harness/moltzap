/** @file Identity registration and recovery use real durable SQL state. */

import { live as it } from "@effect/vitest";
import { type Context, Effect, Redacted } from "effect";
import { describe, expect } from "vitest";
import { makeFixture } from "../../__tests__/daemon-runtime-fixtures.js";
import {
  stateDirectory,
  withDaemonStore,
} from "../../__tests__/store-schema-fixtures.js";
import {
  RegistryConnectionError,
  type RegistryRegisterResult,
} from "../../identity/registry/contract.js";
import { Registry } from "../../identity/registry/index.js";
import { AuthenticationFailedError } from "../../identity/signing/http-errors.js";
import { DaemonConfigurationError } from "../bootstrap.js";
import {
  DaemonRegistrationRefusedError,
  DaemonRegistrationRepresentationError,
  DaemonRegistrationUpstreamError,
  readDaemonRegistrationState,
  registerDaemonIdentity,
  requireAdmission,
} from "./index.js";

const missingAdmission = Effect.fail(
  new DaemonConfigurationError({
    reason: "admission-credential-file",
    message: "admission credential file is required",
  }),
);
const registry = (
  result: RegistryRegisterResult,
): Context.Tag.Service<typeof Registry> => ({
  register: () => Effect.succeed(result),
  lookup: () => Effect.succeed({ kind: "not_found" }),
});

const registersDurably = () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    const directory = stateDirectory();
    yield* withDaemonStore(directory, () =>
      Effect.gen(function* () {
        expect(
          yield* readDaemonRegistrationState({ bootstrap: fixture.bootstrap }),
        ).toEqual({ kind: "unregistered" });
        const result = yield* registerDaemonIdentity({
          request: fixture.registerRequest,
          bootstrap: fixture.bootstrap,
        }).pipe(
          Effect.provideService(
            Registry,
            registry({ kind: "registered", agentCard: fixture.localCard }),
          ),
        );
        expect(result).toEqual({
          kind: "registered",
          agentCard: fixture.localCard,
        });
      }),
    );
    yield* withDaemonStore(directory, () =>
      Effect.gen(function* () {
        expect(
          yield* readDaemonRegistrationState({ bootstrap: fixture.bootstrap }),
        ).toEqual({ kind: "active", agentCard: fixture.localCard });
      }),
    );
  });

const keepsRefusedRegistrationUnbound = () =>
  withDaemonStore(stateDirectory(), (store) =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      expect(
        yield* registerDaemonIdentity({
          request: fixture.registerRequest,
          bootstrap: fixture.bootstrap,
        }).pipe(
          Effect.provideService(Registry, registry({ kind: "name_taken" })),
        ),
      ).toEqual({ kind: "name_taken" });
      expect(yield* store.readIdentity()).toBeUndefined();
    }),
  );

const rejectsWrongCard = () =>
  withDaemonStore(stateDirectory(), (store) =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const other = yield* makeFixture;
      const error = yield* registerDaemonIdentity({
        request: fixture.registerRequest,
        bootstrap: fixture.bootstrap,
      }).pipe(
        Effect.provideService(
          Registry,
          registry({ kind: "registered", agentCard: other.localCard }),
        ),
        Effect.flip,
      );
      expect(error).toBeInstanceOf(DaemonRegistrationRepresentationError);
      expect(yield* store.readIdentity()).toBeUndefined();
    }),
  );

const projectsRegistryFailures = () =>
  withDaemonStore(stateDirectory(), () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const call = registerDaemonIdentity({
        request: fixture.registerRequest,
        bootstrap: fixture.bootstrap,
      });
      const unavailable = yield* call.pipe(
        Effect.provideService(Registry, {
          ...registry({ kind: "name_taken" }),
          register: () => Effect.fail(new RegistryConnectionError()),
        }),
        Effect.flip,
      );
      expect(unavailable).toBeInstanceOf(DaemonRegistrationUpstreamError);
      const refused = yield* call.pipe(
        Effect.provideService(Registry, {
          ...registry({ kind: "name_taken" }),
          register: () => Effect.fail(new AuthenticationFailedError()),
        }),
        Effect.flip,
      );
      expect(refused).toBeInstanceOf(DaemonRegistrationRefusedError);
    }),
  );

const presentsAdmission = () =>
  withDaemonStore(stateDirectory(), () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const expected = Redacted.value(
        yield* fixture.bootstrap.admissionCredential,
      );
      const service: Context.Tag.Service<typeof Registry> = {
        ...registry({ kind: "name_taken" }),
        register: ({ admissionCredential }) =>
          Effect.sync(() => {
            expect(Redacted.value(admissionCredential)).toBe(expected);
            return { kind: "name_taken" as const };
          }),
      };
      yield* registerDaemonIdentity({
        request: fixture.registerRequest,
        bootstrap: fixture.bootstrap,
      }).pipe(Effect.provideService(Registry, service));
    }),
  );

const checksStartupAdmission = () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    const bootstrap = {
      ...fixture.bootstrap,
      admissionCredential: missingAdmission,
    };
    expect(
      yield* requireAdmission({ kind: "unregistered" }, bootstrap).pipe(
        Effect.flip,
      ),
    ).toBeInstanceOf(DaemonConfigurationError);
    yield* requireAdmission(
      { kind: "active", agentCard: fixture.localCard },
      bootstrap,
    );
  });

const refusesMissingAdmission = () =>
  withDaemonStore(stateDirectory(), (store) =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const error = yield* registerDaemonIdentity({
        request: fixture.registerRequest,
        bootstrap: {
          ...fixture.bootstrap,
          admissionCredential: missingAdmission,
        },
      }).pipe(
        Effect.provideService(
          Registry,
          registry({ kind: "registered", agentCard: fixture.localCard }),
        ),
        Effect.flip,
      );
      expect(error).toBeInstanceOf(DaemonConfigurationError);
      expect(yield* store.readIdentity()).toBeUndefined();
    }),
  );

// @agent-code-guard/regression-only: registration recovery trusts only the saved verified identity and does not require an admission secret afterward.
describe("daemon registration", () => {
  it(
    "persists a successful registration and recovers its identity after reopening",
    registersDurably,
  );
  it(
    "keeps a Registry domain refusal unregistered",
    keepsRefusedRegistrationUnbound,
  );
  it(
    "rejects a returned card that belongs to another request",
    rejectsWrongCard,
  );
  it(
    "returns closed failures for unavailable and refusing Registry connections",
    projectsRegistryFailures,
  );
  it(
    "passes the admission credential to the Registry unchanged",
    presentsAdmission,
  );
});

describe("daemon startup admission", () => {
  it(
    "requires the credential before registration and skips it for an active identity",
    checksStartupAdmission,
  );
  it(
    "does not bind identity when its admission credential cannot load",
    refusesMissingAdmission,
  );
});
