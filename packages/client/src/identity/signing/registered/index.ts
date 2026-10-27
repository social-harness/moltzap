/** @file Registered-agent HTTP signing, resolution, replay defense, and verification. */

import type { HttpClientRequest, HttpServerRequest } from "@effect/platform";
import {
  Brand,
  Cause,
  Context,
  Deferred,
  Effect,
  Layer,
  Option,
  Ref,
  Schema,
} from "effect";
import type { AgentSigningAuthority } from "../../keys.js";
import type { RegistryLookupResult } from "../../registry/contract.js";
import {
  decodeCanonicalJson,
  encodeCanonicalJson,
} from "../../../encoding/canonical-json.js";
import { exactStruct } from "../../../encoding/exact.js";
import { AgentId, type AgentId as AgentIdValue } from "../../agents.js";
import { type BoundedCache, makeBoundedCache } from "../../bounded-cache.js";
import {
  type VerifiedAgentCard,
  verifiedAgentCardSchema,
} from "../../cards.js";
import { Registry } from "../../registry/index.js";
import { WireVersions } from "../../wire-version.js";
import {
  AuthenticationFailedError,
  MalformedRequestError,
  OverloadedError,
  UnavailableError,
  VersionMismatchError,
} from "../http-errors.js";
import {
  AgentSigningError,
  signHttpRequest,
  verifyHttpRequestSignature,
} from "../http-signature.js";

/** Request body and caller identity established by AuthenticatedHttp. */
export type VerifiedAgentRequest = Readonly<{
  readonly callerAgentId: AgentIdValue;
  readonly agentCard: VerifiedAgentCard;
  readonly request: unknown;
}> &
  Brand.Brand<"VerifiedAgentRequest">;

type AuthenticationError =
  | MalformedRequestError
  | AuthenticationFailedError
  | VersionMismatchError
  | OverloadedError
  | UnavailableError;

interface AuthenticatedHttpService {
  readonly verifyAgentRequest: (input: {
    readonly httpRequest: HttpServerRequest.HttpServerRequest;
    readonly bodyBytes: Uint8Array;
  }) => Effect.Effect<VerifiedAgentRequest, AuthenticationError>;
}

/** Registered-agent request signing and verification. */
export class AuthenticatedHttp extends Context.Tag(
  "@moltzap/social-harness/AuthenticatedHttp",
)<AuthenticatedHttp, AuthenticatedHttpService>() {
  static readonly signAgentRequest = signAgentRequest;

  static readonly verifyAgentRequest: (input: {
    readonly httpRequest: HttpServerRequest.HttpServerRequest;
    readonly bodyBytes: Uint8Array;
  }) => Effect.Effect<
    VerifiedAgentRequest,
    AuthenticationError,
    AuthenticatedHttp
  > = Effect.serviceFunctionEffect(
    AuthenticatedHttp,
    (service) => service.verifyAgentRequest,
  );

  static readonly layer = (input: {
    readonly liveNonceCapacity: number;
    readonly agentCardCacheCapacity: number;
    readonly registryLookupConcurrencyLimit: number;
  }): Layer.Layer<AuthenticatedHttp, never, Registry> =>
    Layer.effect(AuthenticatedHttp, makeService({ ...input }));
}

const brandVerifiedAgentRequest = Brand.nominal<VerifiedAgentRequest>();

const registeredAgentBody = exactStruct({
  callerAgentId: AgentId,
  request: Schema.Unknown,
});

function makeService(input: {
  readonly liveNonceCapacity: number;
  readonly agentCardCacheCapacity: number;
  readonly registryLookupConcurrencyLimit: number;
}): Effect.Effect<AuthenticatedHttpService, never, Registry> {
  return Effect.gen(function* () {
    const registry = yield* Registry;
    const nonces = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
    const resolveCard = yield* makeCardResolver(
      {
        cacheCapacity: input.agentCardCacheCapacity,
        lookupConcurrencyLimit: input.registryLookupConcurrencyLimit,
      },
      (request) => registry.lookup(request),
    );
    return {
      verifyAgentRequest: (request) =>
        verifyRequest(request, {
          liveNonceCapacity: input.liveNonceCapacity,
          nonces,
          resolveCard,
        }),
    };
  });
}

function signAgentRequest(input: {
  readonly httpRequest: HttpClientRequest.HttpClientRequest;
  readonly callerAgentId: AgentIdValue;
  readonly encodedRequest: unknown;
  readonly signingAuthority: AgentSigningAuthority;
}): Effect.Effect<HttpClientRequest.HttpClientRequest, AgentSigningError> {
  return encodeCanonicalJson({
    callerAgentId: input.callerAgentId,
    request: input.encodedRequest,
  }).pipe(
    Effect.catchTag("CanonicalJsonError", () =>
      Effect.fail(new AgentSigningError()),
    ),
    Effect.flatMap((bodyBytes) =>
      signHttpRequest({
        httpRequest: input.httpRequest,
        bodyBytes,
        signingAuthority: input.signingAuthority,
        profile: "normal",
      }),
    ),
  );
}

function verifyRequest(
  input: {
    readonly bodyBytes: Uint8Array;
    readonly httpRequest: HttpServerRequest.HttpServerRequest;
  },
  dependencies: {
    readonly liveNonceCapacity: number;
    readonly nonces: Ref.Ref<ReadonlyMap<string, number>>;
    readonly resolveCard: CardResolver;
  },
): Effect.Effect<VerifiedAgentRequest, AuthenticationError> {
  return Effect.gen(function* () {
    const body = yield* decodeCanonicalJson(
      registeredAgentBody,
      new Uint8Array(input.bodyBytes),
    ).pipe(
      Effect.catchTag("CanonicalJsonError", () =>
        Effect.fail(new MalformedRequestError()),
      ),
    );
    const agentCard = yield* dependencies.resolveCard(body.callerAgentId);
    const signature = yield* verifyHttpRequestSignature({
      httpRequest: input.httpRequest,
      bodyBytes: input.bodyBytes,
      publicKey: agentCard.publicKey,
      profile: "normal",
    });
    const claim = yield* claimNonce(dependencies.nonces, {
      capacity: dependencies.liveNonceCapacity,
      nonce: signature.nonce,
      expires: signature.expires,
      now: signature.verifiedAt,
    });
    if (claim === "replayed") {
      return yield* new AuthenticationFailedError();
    }
    if (claim === "full") {
      return yield* new OverloadedError();
    }
    const version = input.httpRequest.headers["sharness-version"];
    if (version === undefined || !(yield* WireVersions.live(version))) {
      return yield* new VersionMismatchError();
    }
    return makeVerifiedAgentRequest({
      callerAgentId: body.callerAgentId,
      agentCard,
      request: body.request,
    });
  });
}

type CardResolutionError =
  | AuthenticationFailedError
  | OverloadedError
  | UnavailableError;

/** In-flight card lookups, keyed by agent, each awaited by later callers. */
type PendingResolutions = ReadonlyMap<
  AgentIdValue,
  Deferred.Deferred<VerifiedAgentCard, CardResolutionError>
>;

type RegistryLookup = (request: {
  readonly agentId: AgentIdValue;
}) => Effect.Effect<RegistryLookupResult, unknown>;

type CacheAccess =
  | Readonly<{ readonly kind: "cached"; readonly card: VerifiedAgentCard }>
  | Readonly<{
      readonly kind: "join";
      readonly deferred: Deferred.Deferred<
        VerifiedAgentCard,
        CardResolutionError
      >;
    }>
  | Readonly<{
      readonly kind: "lead";
      readonly deferred: Deferred.Deferred<
        VerifiedAgentCard,
        CardResolutionError
      >;
    }>;

type RestoreInterruptibility = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
) => Effect.Effect<A, E, R>;

interface CardResolutionSettings {
  readonly cacheCapacity: number;
  readonly lookupConcurrencyLimit: number;
}

interface CardResolverDependencies {
  readonly pendingResolutions: Ref.Ref<PendingResolutions>;
  readonly cards: BoundedCache<AgentIdValue, VerifiedAgentCard>;
  readonly lookup: RegistryLookup;
  readonly lookupPermits: Effect.Semaphore;
}

function makeCardResolver(
  settings: CardResolutionSettings,
  lookup: RegistryLookup,
): Effect.Effect<
  (
    agentId: AgentIdValue,
  ) => Effect.Effect<VerifiedAgentCard, CardResolutionError>
> {
  return Effect.gen(function* () {
    const pendingResolutions = yield* Ref.make<PendingResolutions>(new Map());
    const lookupPermits = yield* Effect.makeSemaphore(
      settings.lookupConcurrencyLimit,
    );
    const dependencies: CardResolverDependencies = {
      pendingResolutions,
      cards: makeBoundedCache<AgentIdValue, VerifiedAgentCard>(
        settings.cacheCapacity,
      ),
      lookup,
      lookupPermits,
    };
    return (
      agentId: AgentIdValue,
    ): Effect.Effect<VerifiedAgentCard, CardResolutionError> =>
      Effect.uninterruptibleMask((restoreInterruptibility) =>
        resolveCard(dependencies, agentId, restoreInterruptibility),
      );
  });
}

type CardResolver = Effect.Effect.Success<ReturnType<typeof makeCardResolver>>;

function resolveCard(
  dependencies: CardResolverDependencies,
  agentId: AgentIdValue,
  restoreInterruptibility: RestoreInterruptibility,
): Effect.Effect<VerifiedAgentCard, CardResolutionError> {
  return Effect.gen(function* () {
    const candidate = yield* Deferred.make<
      VerifiedAgentCard,
      CardResolutionError
    >();
    const access = yield* beginCardResolution(
      dependencies.pendingResolutions,
      dependencies.cards,
      agentId,
      candidate,
    );
    return yield* resolveCacheAccess(
      dependencies,
      agentId,
      access,
      restoreInterruptibility,
    );
  });
}

function resolveCacheAccess(
  dependencies: CardResolverDependencies,
  agentId: AgentIdValue,
  access: CacheAccess,
  restoreInterruptibility: RestoreInterruptibility,
): Effect.Effect<VerifiedAgentCard, CardResolutionError> {
  // eslint-disable-next-line default-case -- the switch is exhaustive
  switch (access.kind) {
    case "cached":
      return Effect.succeed(access.card);
    case "join":
      return restoreInterruptibility(Deferred.await(access.deferred));
    case "lead":
      return Effect.forkDaemon(
        runLeadingResolution(dependencies, agentId, access.deferred).pipe(
          Effect.interruptible,
        ),
      ).pipe(
        Effect.zipRight(
          restoreInterruptibility(Deferred.await(access.deferred)),
        ),
      );
  }
}

function runLeadingResolution(
  dependencies: CardResolverDependencies,
  agentId: AgentIdValue,
  deferred: Deferred.Deferred<VerifiedAgentCard, CardResolutionError>,
): Effect.Effect<VerifiedAgentCard, CardResolutionError> {
  return lookupCard(dependencies, agentId).pipe(
    Effect.tap((card) =>
      retainResolvedCard(dependencies.cards, {
        agentId,
        card,
      }),
    ),
    Effect.onExit((exit) =>
      removePendingResolution(dependencies.pendingResolutions, agentId).pipe(
        Effect.zipRight(Deferred.done(deferred, exit)),
      ),
    ),
  );
}

/**
 * Looks up `agentId`'s card through the `Registry`. Any layer can provide the
 * `Registry`, so its `lookup` runs inside the effect. Registry failures have
 * one recovery at this boundary, so a lookup that fails, throws or dies fails
 * as `UnavailableError` and still settles the pending resolution, while an
 * interrupted lookup stays interrupted.
 * @param dependencies Bounded Registry lookup and shared card-resolution state.
 * @param agentId Immutable identity whose verified card is required.
 * @returns The verified card or a closed resolution failure.
 */
function lookupCard(
  dependencies: CardResolverDependencies,
  agentId: AgentIdValue,
): Effect.Effect<VerifiedAgentCard, CardResolutionError> {
  return dependencies.lookupPermits
    .withPermitsIfAvailable(1)(
      Effect.suspend(() => dependencies.lookup({ agentId })).pipe(
        Effect.catchAllCause((cause) =>
          Cause.isInterrupted(cause)
            ? Effect.interrupt
            : Effect.fail(new UnavailableError()),
        ),
      ),
    )
    .pipe(
      Effect.flatMap((attempted) => resolveLookupAttempt(attempted, agentId)),
    );
}

const isVerifiedAgentCard = Schema.is(verifiedAgentCardSchema);

/**
 * Any layer can provide the `Registry`, so a `found` result's card is read once
 * under a try, must be one this package verified, and must belong to the
 * requested `agentId`; the request's signature key alone does not bind the
 * AgentId. A result or card that throws on read, a card this package did not
 * verify, or another agent's card fails authentication.
 * @param attempted Registry outcome, absent when no lookup permit was available.
 * @param agentId Requested identity that the returned card must bind.
 * @returns The authenticated card or an overload/authentication failure.
 */
function resolveLookupAttempt(
  attempted: Option.Option<RegistryLookupResult>,
  agentId: AgentIdValue,
): Effect.Effect<
  VerifiedAgentCard,
  OverloadedError | AuthenticationFailedError
> {
  if (Option.isNone(attempted)) {
    return Effect.fail(new OverloadedError());
  }
  const result = attempted.value;
  return Effect.try({
    try: () =>
      result.kind === "found" ? Option.some(result.agentCard) : Option.none(),
    catch: () => new AuthenticationFailedError(),
  }).pipe(
    Effect.flatMap((agentCard) =>
      Option.isSome(agentCard) &&
      isVerifiedAgentCard(agentCard.value) &&
      agentCard.value.agentId === agentId
        ? Effect.succeed(agentCard.value)
        : Effect.fail(new AuthenticationFailedError()),
    ),
  );
}

/**
 * Bounded-cache reads and writes are synchronous and never span a yield, so
 * cache access and pending-resolution decisions cannot interleave.
 * @param pendingResolutions Shared in-flight resolutions whose entries must be preserved.
 * @param cards Bounded cache of verified immutable cards.
 * @param agentId Identity used as the cache and pending-resolution key.
 * @param candidate Deferred value installed only if this lookup wins acquisition.
 * @returns The cached card or shared pending lookup selected atomically.
 */
function beginCardResolution(
  pendingResolutions: Ref.Ref<PendingResolutions>,
  cards: BoundedCache<AgentIdValue, VerifiedAgentCard>,
  agentId: AgentIdValue,
  candidate: Deferred.Deferred<VerifiedAgentCard, CardResolutionError>,
): Effect.Effect<CacheAccess> {
  return Ref.modify(
    pendingResolutions,
    (current): readonly [CacheAccess, PendingResolutions] => {
      const card = cards.get(agentId);
      if (Option.isSome(card)) {
        return [{ kind: "cached", card: card.value }, current] as const;
      }
      const pending = current.get(agentId);
      if (pending !== undefined) {
        return [{ kind: "join", deferred: pending }, current] as const;
      }
      return [
        { kind: "lead", deferred: candidate },
        new Map(current).set(agentId, candidate),
      ] as const;
    },
  );
}

function removePendingResolution(
  pendingResolutions: Ref.Ref<PendingResolutions>,
  agentId: AgentIdValue,
): Effect.Effect<void> {
  return Ref.update(pendingResolutions, (current) => {
    const pending = new Map(current);
    pending.delete(agentId);
    return pending;
  });
}

function retainResolvedCard(
  cards: BoundedCache<AgentIdValue, VerifiedAgentCard>,
  input: {
    readonly agentId: AgentIdValue;
    readonly card: VerifiedAgentCard;
  },
): Effect.Effect<void> {
  return Effect.sync(() => {
    cards.set(input.agentId, input.card);
  });
}

type NonceClaim = "claimed" | "replayed" | "full";

interface NonceClaimInput {
  readonly capacity: number;
  readonly nonce: string;
  readonly expires: number;
  readonly now: number;
}

function claimNonce(
  nonces: Ref.Ref<ReadonlyMap<string, number>>,
  input: NonceClaimInput,
): Effect.Effect<NonceClaim> {
  return Ref.modify(nonces, (current) => updateNonces(current, input));
}

function updateNonces(
  current: ReadonlyMap<string, number>,
  input: NonceClaimInput,
): readonly [NonceClaim, ReadonlyMap<string, number>] {
  const live = new Map<string, number>();
  for (const [retainedNonce, retainedExpiry] of current) {
    if (retainedExpiry >= input.now) {
      live.set(retainedNonce, retainedExpiry);
    }
  }
  if (live.has(input.nonce)) {
    return ["replayed", live];
  }
  if (live.size >= input.capacity) {
    return ["full", live];
  }
  live.set(input.nonce, input.expires);
  return ["claimed", live];
}

function makeVerifiedAgentRequest(input: {
  readonly callerAgentId: AgentIdValue;
  readonly agentCard: VerifiedAgentCard;
  readonly request: unknown;
}): VerifiedAgentRequest {
  return brandVerifiedAgentRequest(Object.freeze({ ...input }));
}
