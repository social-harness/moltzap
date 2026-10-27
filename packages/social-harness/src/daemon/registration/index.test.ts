/** @file Startup recovery and atomic Registry-to-store identity binding tests. */

import { HttpClient, HttpClientResponse } from "@effect/platform";
import { live as it } from "@effect/vitest";
import {
  type Context,
  Duration,
  Effect,
  Layer,
  Redacted,
  Ref,
  Schema,
} from "effect";
import { describe, expect } from "vitest";
import { makeFixture } from "../../__tests__/daemon-runtime-fixtures.js";
import {
  EndpointStoreError,
  type IdentityBinding,
} from "../../communication/store/index.js";
import { managementRegisterRequestSchema } from "../../harness/protocol/index.js";
import {
  RegistryConnectionError,
  type RegistryRegisterRequest,
  type RegistryRegisterResult,
} from "../../identity/registry/contract.js";
import { Registry } from "../../identity/registry/index.js";
import { DaemonConfigurationError } from "../bootstrap.js";
import {
  DaemonRegistrationPersistenceError,
  DaemonRegistrationRefusedError,
  DaemonRegistrationRepresentationError,
  type DaemonRegistrationStore,
  DaemonRegistrationUpstreamError,
  readDaemonRegistrationState,
  registerDaemonIdentity,
  requireAdmission,
} from "./index.js";

interface MemoryStore {
  readonly store: DaemonRegistrationStore;
  readonly binding: Ref.Ref<IdentityBinding | undefined>;
  readonly failWrites: Ref.Ref<boolean>;
}

/**
 * Bind `candidate` as the production store's identity write does: insert when
 * unbound, report an identical binding as existing, and refuse a different
 * one as a conflict.
 */
const bindMemoryIdentity = (
  binding: Ref.Ref<IdentityBinding | undefined>,
  candidate: IdentityBinding,
) =>
  Ref.get(binding).pipe(
    Effect.flatMap((existing) => {
      if (existing === undefined) {
        return Ref.set(binding, candidate).pipe(Effect.as("inserted" as const));
      }
      return existing.agentId === candidate.agentId &&
        Buffer.compare(
          existing.canonicalAgentCard,
          candidate.canonicalAgentCard,
        ) === 0
        ? Effect.succeed("existing" as const)
        : Effect.fail(new EndpointStoreError({ reason: "conflict" }));
    }),
  );

const makeMemoryStore = Effect.gen(function* () {
  const binding = yield* Ref.make<IdentityBinding | undefined>(undefined);
  const failWrites = yield* Ref.make(false);
  const store: DaemonRegistrationStore = {
    readIdentity: () => Ref.get(binding),
    bindIdentity: (candidate) =>
      Ref.get(failWrites).pipe(
        Effect.flatMap((shouldFail) =>
          shouldFail
            ? Effect.fail(new EndpointStoreError({ reason: "persistence" }))
            : bindMemoryIdentity(binding, candidate),
        ),
      ),
  };
  return { store, binding, failWrites } satisfies MemoryStore;
});

const registryLayer = (input: {
  readonly result: RegistryRegisterResult;
  readonly fail?: boolean;
}) => {
  const registrations = new Map<string, RegistryRegisterRequest>();
  const service: Context.Tag.Service<typeof Registry> = {
    register: ({ request }) =>
      Effect.suspend(() => {
        if (input.fail === true) {
          return Effect.fail(new RegistryConnectionError());
        }
        const existing = registrations.get(request.agentName);
        if (
          existing !== undefined &&
          (existing.operationId !== request.operationId ||
            existing.principalId !== request.principalId)
        ) {
          return Effect.succeed({ kind: "name_taken" as const });
        }
        if (input.result.kind === "registered") {
          registrations.set(request.agentName, request);
        }
        return Effect.succeed(input.result);
      }),
    lookup: () => Effect.succeed({ kind: "not_found" }),
  };
  return Layer.succeed(Registry, service);
};

const provideRegistry = <A, E>(
  effect: Effect.Effect<A, E, Registry>,
  result: RegistryRegisterResult,
  fail = false,
) => Effect.provide(effect, registryLayer({ result, fail }));

const registersAndActivates = () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    const memory = yield* makeMemoryStore;
    const before = yield* readDaemonRegistrationState({
      store: memory.store,
      bootstrap: fixture.bootstrap,
    });
    expect(before).toEqual({ kind: "unregistered" });
    const result = yield* provideRegistry(
      registerDaemonIdentity({
        request: fixture.registerRequest,
        store: memory.store,
        bootstrap: fixture.bootstrap,
      }),
      { kind: "registered", agentCard: fixture.localCard },
    );
    expect(result).toEqual({
      kind: "registered",
      agentCard: fixture.localCard,
    });
    const after = yield* readDaemonRegistrationState({
      store: memory.store,
      bootstrap: fixture.bootstrap,
    });
    expect(after).toEqual({ kind: "active", agentCard: fixture.localCard });
  });

const retriesAfterLocalPersistenceFailure = () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    const memory = yield* makeMemoryStore;
    const result = {
      kind: "registered" as const,
      agentCard: fixture.localCard,
    };
    const registry = registryLayer({ result });
    yield* Ref.set(memory.failWrites, true);
    const firstFailure = yield* Effect.flip(
      Effect.provide(
        registerDaemonIdentity({
          request: fixture.registerRequest,
          store: memory.store,
          bootstrap: fixture.bootstrap,
        }),
        registry,
      ),
    );
    expect(firstFailure).toBeInstanceOf(DaemonRegistrationPersistenceError);
    expect(yield* Ref.get(memory.binding)).toBeUndefined();

    yield* Ref.set(memory.failWrites, false);
    const recovered = yield* Effect.provide(
      registerDaemonIdentity({
        request: fixture.registerRequest,
        store: memory.store,
        bootstrap: fixture.bootstrap,
      }),
      registry,
    );
    expect(recovered).toEqual(result);
    expect(
      yield* readDaemonRegistrationState({
        store: memory.store,
        bootstrap: fixture.bootstrap,
      }),
    ).toEqual({ kind: "active", agentCard: fixture.localCard });
  });

const keepsRegistryRefusalsUncommitted = () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    const memory = yield* makeMemoryStore;
    const result = yield* provideRegistry(
      registerDaemonIdentity({
        request: fixture.registerRequest,
        store: memory.store,
        bootstrap: fixture.bootstrap,
      }),
      { kind: "name_taken" },
    );
    expect(result).toEqual({ kind: "name_taken" });
    expect(yield* Ref.get(memory.binding)).toBeUndefined();
  });

const closesUpstreamAndRepresentationFailures = () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    const memory = yield* makeMemoryStore;
    const upstream = yield* Effect.flip(
      provideRegistry(
        registerDaemonIdentity({
          request: fixture.registerRequest,
          store: memory.store,
          bootstrap: fixture.bootstrap,
        }),
        { kind: "name_taken" },
        true,
      ),
    );
    expect(upstream).toBeInstanceOf(DaemonRegistrationUpstreamError);

    const mismatchedRequest = Schema.decodeUnknownSync(
      managementRegisterRequestSchema,
    )({ ...fixture.registerRequest, agentName: "agent-two" });
    const representation = yield* Effect.flip(
      provideRegistry(
        registerDaemonIdentity({
          request: mismatchedRequest,
          store: memory.store,
          bootstrap: fixture.bootstrap,
        }),
        { kind: "registered", agentCard: fixture.localCard },
      ),
    );
    expect(representation).toBeInstanceOf(
      DaemonRegistrationRepresentationError,
    );
  });

const rejectsCorruptPreexistingBinding = () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    const memory = yield* makeMemoryStore;
    yield* Ref.set(memory.binding, {
      agentId: fixture.localCard.agentId,
      canonicalAgentCard: new TextEncoder().encode("{}"),
    });
    const error = yield* Effect.flip(
      readDaemonRegistrationState({
        store: memory.store,
        bootstrap: fixture.bootstrap,
      }),
    );
    expect(error).toBeInstanceOf(DaemonRegistrationRepresentationError);
  });

const missingAdmission = Effect.fail(
  new DaemonConfigurationError({
    reason: "admission-credential-file",
    message: "admission credential file is required",
  }),
);

const unregisteredStartupFailsClosed = () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    const error = yield* Effect.flip(
      requireAdmission(
        { kind: "unregistered" },
        {
          ...fixture.bootstrap,
          admissionCredential: missingAdmission,
        },
      ),
    );
    expect(error).toEqual(
      new DaemonConfigurationError({
        reason: "admission-credential-file",
        message: "admission credential file is required",
      }),
    );
  });

const unregisteredStartupLoadsCredential = () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    expect(
      yield* requireAdmission({ kind: "unregistered" }, fixture.bootstrap),
    ).toBeUndefined();
  });

const registeredStartupSkipsCredential = () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    expect(
      yield* requireAdmission(
        { kind: "active", agentCard: fixture.localCard },
        {
          ...fixture.bootstrap,
          admissionCredential: missingAdmission,
        },
      ),
    ).toBeUndefined();
  });

const startupSurfacesStoreFailure = () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    const store: DaemonRegistrationStore = {
      readIdentity: () =>
        Effect.fail(new EndpointStoreError({ reason: "persistence" })),
      bindIdentity: () =>
        Effect.fail(new EndpointStoreError({ reason: "persistence" })),
    };
    const error = yield* Effect.flip(
      readDaemonRegistrationState({
        store,
        bootstrap: fixture.bootstrap,
      }),
    );
    expect(error).toBeInstanceOf(DaemonRegistrationPersistenceError);
  });

const presentsLoadedCredentialToRegistry = () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    const memory = yield* makeMemoryStore;
    const presented = yield* Ref.make<string | undefined>(undefined);
    const service: Context.Tag.Service<typeof Registry> = {
      register: (call) =>
        Ref.set(presented, Redacted.value(call.admissionCredential)).pipe(
          Effect.as({
            kind: "registered" as const,
            agentCard: fixture.localCard,
          }),
        ),
      lookup: () => Effect.succeed({ kind: "not_found" }),
    };
    yield* Effect.provide(
      registerDaemonIdentity({
        request: fixture.registerRequest,
        store: memory.store,
        bootstrap: fixture.bootstrap,
      }),
      Layer.succeed(Registry, service),
    );
    // eslint-disable-next-line agent-code-guard/no-hardcoded-assertion-literals -- The fixture credential must reach the Registry boundary unchanged.
    expect(yield* Ref.get(presented)).toBe("bootstrap-token=");
  });

const refusesRegistrationWithoutCredential = () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    const memory = yield* makeMemoryStore;
    const error = yield* Effect.flip(
      provideRegistry(
        registerDaemonIdentity({
          request: fixture.registerRequest,
          store: memory.store,
          bootstrap: {
            ...fixture.bootstrap,
            admissionCredential: missingAdmission,
          },
        }),
        { kind: "registered", agentCard: fixture.localCard },
      ),
    );
    expect(error).toEqual(
      new DaemonConfigurationError({
        reason: "admission-credential-file",
        message: "admission credential file is required",
      }),
    );
    expect(yield* Ref.get(memory.binding)).toBeUndefined();
  });

// @agent-code-guard/regression-only: these examples pin that only an unregistered daemon needs the admission credential.
describe("daemon admission credential", () => {
  it(
    "fails an unregistered startup closed without the credential",
    unregisteredStartupFailsClosed,
  );
  it(
    "loads the credential for an unregistered startup",
    unregisteredStartupLoadsCredential,
  );
  it(
    "starts a registered daemon without requiring the credential",
    registeredStartupSkipsCredential,
  );
  it(
    "presents the loaded credential to Registry registration",
    presentsLoadedCredentialToRegistry,
  );
  it(
    "refuses registration when the credential is unavailable",
    refusesRegistrationWithoutCredential,
  );
});

// @agent-code-guard/regression-only: these examples cover recovery after failed persistence and one durable identity binding.
describe("daemon registration", () => {
  it(
    "moves from unregistered to active only after local binding",
    registersAndActivates,
  );
  it(
    "recovers active registration after local persistence failure",
    retriesAfterLocalPersistenceFailure,
  );
  it(
    "does not bind Registry domain refusals",
    keepsRegistryRefusalsUncommitted,
  );
  it(
    "closes upstream and cross-field representation failures",
    closesUpstreamAndRepresentationFailures,
  );
  it(
    "fails closed on a corrupt preexisting binding",
    rejectsCorruptPreexistingBinding,
  );
  it(
    "surfaces an unreadable identity binding as a persistence failure",
    startupSurfacesStoreFailure,
  );
});

/** The Registry client decodes the actual admission-refusal envelope. */
it("makes a refused admission credential a final registration refusal", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    const memory = yield* makeMemoryStore;
    const registry = Registry.layer({
      origin: fixture.bootstrap.configuration.registryOrigin,
      registrySignerPublicKey:
        fixture.bootstrap.configuration.registrySignerPublicKey,
      requestTimeout: Duration.seconds(1),
    }).pipe(
      Layer.provide(
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                new Response('{"error":"authentication_failed"}', {
                  status: 401,
                  headers: { "content-type": "application/json" },
                }),
              ),
            ),
          ),
        ),
      ),
    );
    const error = yield* registerDaemonIdentity({
      request: fixture.registerRequest,
      store: memory.store,
      bootstrap: fixture.bootstrap,
    }).pipe(Effect.provide(registry), Effect.flip);
    expect(error).toBeInstanceOf(DaemonRegistrationRefusedError);
    expect(error.message).toMatch(/Registry refused the admission credential/);
    expect(error.message).toMatch(
      /Docs: https:\/\/.*#the-registry-refused-the-admission-credential$/,
    );
    expect(yield* Ref.get(memory.binding)).toBeUndefined();
  }));
