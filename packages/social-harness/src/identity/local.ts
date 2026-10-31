/** @file One saved agent identity owns local registration and Registry resolution. */

import { SqlClient } from "@effect/sql";
import {
  Context,
  Data,
  Effect,
  Fiber,
  Layer,
  Option,
  type Redacted,
  Ref,
  Scope,
  SubscriptionRef,
} from "effect";
import type { AgentName, PrincipalId } from "./identifiers.js";
import type { AgentSigningAuthority, Ed25519PublicKey } from "./keys.js";
import type { OperationId } from "./registry/contract.js";
import {
  type AgentView,
  agentViewOf,
  type VerifiedAgentCard,
} from "./cards.js";
import {
  IdentityError,
  readLocalIdentity,
  saveLocalIdentity,
} from "./local-store.js";
import { Registry } from "./registry/index.js";

/** The service exposes local persistence failures alongside registration failures. */
export { IdentityError } from "./local-store.js";

/** Callers can correct registration conflicts or replace a refused admission credential. */
export class RegistrationError extends Data.TaggedError("RegistrationError")<{
  readonly reason:
    | "admission-refused"
    | "name_taken"
    | "key_already_registered"
    | "idempotency_conflict"
    | "dependency-unavailable"
    | "persistence-failed"
    | "incompatible-daemon";
}> {}

/** The Registry binds this operation to an immutable principal, name and local key. */
export interface RegistrationRequest {
  readonly operationId: OperationId;
  readonly principalId: PrincipalId;
  readonly agentName: AgentName;
}

/** A saved identity is available before communication recovery finishes. */
export type LocalIdentityStatus =
  | Readonly<{ kind: "unregistered" }>
  | Readonly<{ kind: "registered"; agent: AgentView }>;

/** Identity operations capture their Registry and persistence dependencies at construction. */
export class Identity extends Context.Tag("@moltzap/Identity")<
  Identity,
  {
    /** Reports saved registration independently of communication startup. */
    readonly me: () => Effect.Effect<LocalIdentityStatus, IdentityError>;
    /** Saves a Registry-verified identity before returning to its caller. */
    readonly register: (
      request: RegistrationRequest,
    ) => Effect.Effect<AgentView, RegistrationError>;
    /** Resolves names in input order and identifies the first name that fails. */
    readonly resolve: (
      names: readonly AgentName[],
    ) => Effect.Effect<readonly AgentView[], IdentityError>;
  }
>() {}

/** Private verified-card state shared with protocol startup and wire adapters. */
export class LocalIdentity extends Context.Tag("@moltzap/LocalIdentity")<
  LocalIdentity,
  SubscriptionRef.SubscriptionRef<Option.Option<VerifiedAgentCard>>
>() {}

interface LocalIdentitySettings {
  readonly registrySignerPublicKey: Ed25519PublicKey;
  readonly agentPublicKey: Ed25519PublicKey;
  readonly signingAuthority: AgentSigningAuthority;
  readonly admissionCredential: Effect.Effect<Redacted.Redacted, unknown>;
}

/** The layer scope owns registration through durable commit even if its caller stops waiting. */
export function localIdentityLayer(
  settings: LocalIdentitySettings,
): Layer.Layer<
  Identity | LocalIdentity,
  IdentityError,
  Registry | SqlClient.SqlClient
> {
  return Layer.scopedContext(
    Effect.gen(function* () {
      const current = yield* SubscriptionRef.make(
        Option.fromNullable(yield* readLocalIdentity(settings)),
      );
      const service = yield* makeIdentity(settings, current);
      return Context.make(Identity, service).pipe(
        Context.add(LocalIdentity, current),
      );
    }).pipe(Effect.withSpan("localIdentityLayer")),
  );
}

function makeIdentity(
  settings: LocalIdentitySettings,
  current: Context.Tag.Service<typeof LocalIdentity>,
) {
  return Effect.gen(function* () {
    const scope = yield* Scope.Scope;
    const registry = yield* Registry;
    const sql = yield* SqlClient.SqlClient;
    const gate = yield* Effect.makeSemaphore(1);
    return Identity.of({
      me: () =>
        Ref.get(current).pipe(
          Effect.map(
            (card): LocalIdentityStatus =>
              Option.isSome(card)
                ? { kind: "registered", agent: agentViewOf(card.value) }
                : { kind: "unregistered" },
          ),
        ),
      register: (request) =>
        gate
          .withPermits(1)(
            registerLocal(request, settings, registry, current).pipe(
              Effect.provideService(SqlClient.SqlClient, sql),
            ),
          )
          .pipe(
            Effect.interruptible,
            Effect.forkIn(scope),
            Effect.flatMap(Fiber.join),
          ),
      resolve: (names) =>
        Effect.forEach(names, (name) => resolveAgent(registry, name), {
          concurrency: 1,
        }),
    });
  });
}

function resolveAgent(
  registry: Context.Tag.Service<typeof Registry>,
  agentName: AgentName,
) {
  return registry.lookup({ agentName }).pipe(
    Effect.mapError((error) => resolveFailure(error, agentName)),
    Effect.flatMap((result) =>
      result.kind === "found"
        ? Effect.succeed(agentViewOf(result.agentCard))
        : Effect.fail(
            new IdentityError({ reason: "unknown-agent", agentName }),
          ),
    ),
  );
}

type RegistryFailure = Effect.Effect.Error<
  ReturnType<Context.Tag.Service<typeof Registry>["register"]>
>;

const registrationFailureReasons = {
  AuthenticationFailedError: "admission-refused",
  AgentSigningError: "dependency-unavailable",
  RegistryConnectionError: "dependency-unavailable",
  RegistryRequestTimeoutError: "dependency-unavailable",
  RegistryInvalidResponseError: "dependency-unavailable",
  MalformedRequestError: "dependency-unavailable",
  RouteNotFoundError: "dependency-unavailable",
  MethodNotAllowedError: "dependency-unavailable",
  VersionMismatchError: "dependency-unavailable",
  PayloadTooLargeError: "dependency-unavailable",
  UnsupportedMediaTypeError: "dependency-unavailable",
  OverloadedError: "dependency-unavailable",
  UnavailableError: "dependency-unavailable",
  InternalServerError: "dependency-unavailable",
} as const satisfies Readonly<
  Record<RegistryFailure["_tag"], RegistrationError["reason"]>
>;

function registrationFailure(error: RegistryFailure) {
  return new RegistrationError({
    reason: registrationFailureReasons[error._tag],
  });
}

function resolveFailure(
  error: Effect.Effect.Error<
    ReturnType<Context.Tag.Service<typeof Registry>["lookup"]>
  >,
  agentName: AgentName,
) {
  return new IdentityError({
    reason: registrationFailureReasons[error._tag],
    agentName,
  });
}

const admissionFailure = () =>
  new RegistrationError({ reason: "incompatible-daemon" });

function registerLocal(
  request: RegistrationRequest,
  settings: LocalIdentitySettings,
  registry: Context.Tag.Service<typeof Registry>,
  current: SubscriptionRef.SubscriptionRef<Option.Option<VerifiedAgentCard>>,
) {
  return Effect.gen(function* () {
    const admissionCredential = yield* settings.admissionCredential.pipe(
      Effect.mapError(admissionFailure),
    );
    const result = yield* registry
      .register({
        request: { ...request, publicKey: settings.agentPublicKey },
        admissionCredential,
        signingAuthority: settings.signingAuthority,
      })
      .pipe(Effect.mapError(registrationFailure));
    if (result.kind !== "registered") {
      return yield* new RegistrationError({ reason: result.kind });
    }
    const card = result.agentCard;
    if (
      card.agentName !== request.agentName ||
      card.principalId !== request.principalId ||
      card.publicKey.x !== settings.agentPublicKey.x
    ) {
      return yield* new RegistrationError({ reason: "incompatible-daemon" });
    }
    yield* saveLocalIdentity(card).pipe(
      Effect.catchTag(
        "IdentityError",
        (error) =>
          new RegistrationError({
            reason:
              error.reason === "persistence-failed"
                ? "persistence-failed"
                : "incompatible-daemon",
          }),
      ),
    );
    if (Option.isNone(yield* Ref.get(current))) {
      yield* SubscriptionRef.set(current, Option.some(card));
    }
    return agentViewOf(card);
  });
}
