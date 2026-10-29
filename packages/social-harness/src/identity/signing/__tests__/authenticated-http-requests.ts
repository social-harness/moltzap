/** @file Signed-request helpers shared by the AuthenticatedHttp tests. */
import { HttpClientRequest, HttpServerRequest } from "@effect/platform";
import { Clock, Effect, Layer, Match, Schema } from "effect";
import type { VerifiedAgentCard } from "../../cards.js";
import type { AgentId as AgentIdValue } from "../../identifiers.js";
import type {
  RegistryClientService,
  RegistryLookupResult,
} from "../../registry/contract.js";
import { Registry } from "../../registry/index.js";
import { AuthenticatedHttp } from "../../request-authentication.js";
import {
  type IdentityFixture,
  makeIdentityFixture,
} from "./authenticated-http-fixtures.js";

/** The URL every signed test request targets. */
const REQUEST_URL = new URL(
  "http://identity.test/v1/messages:poll?view=current",
);

/** One signed request, as the client sent it and as the server receives it. */
export interface PreparedRequest {
  readonly bodyBytes: Uint8Array;
  readonly clientRequest: HttpClientRequest.HttpClientRequest;
  readonly serverRequest: HttpServerRequest.HttpServerRequest;
}

/** The byte body a signed client request carries. */
const requestBodyBytes = (request: HttpClientRequest.HttpClientRequest) =>
  Match.value(request.body).pipe(
    Match.tag("Uint8Array", (body) =>
      Effect.succeed(Uint8Array.from(body.body)),
    ),
    Match.tag("Empty", "Raw", "FormData", "Stream", () =>
      Effect.dieMessage("signed request did not retain byte body"),
    ),
    Match.exhaustive,
  );

/** The server-side view of a signed client request. */
export const toServerRequest = (
  request: HttpClientRequest.HttpClientRequest,
): HttpServerRequest.HttpServerRequest => {
  const url = new URL(request.url);
  const webRequest = new Request(url, {
    method: request.method,
    headers: {
      ...request.headers,
      host: url.host,
    },
  });
  return HttpServerRequest.fromWeb(webRequest);
};

/**
 * Signs a request as `fixture`, claiming `callerAgentId` when given and the
 * fixture card's AgentId otherwise.
 */
export const prepareRequest = (input: {
  readonly fixture: IdentityFixture;
  readonly callerAgentId?: AgentIdValue;
  readonly encodedRequest?: unknown;
}) =>
  Effect.gen(function* () {
    const clientRequest = yield* AuthenticatedHttp.signAgentRequest({
      httpRequest: HttpClientRequest.post(REQUEST_URL),
      callerAgentId: input.callerAgentId ?? input.fixture.agentCard.agentId,
      encodedRequest: input.encodedRequest ?? { pollCursor: "cursor" },
      signingAuthority: input.fixture.signingAuthority,
    });
    const bodyBytes = yield* requestBodyBytes(clientRequest);
    return {
      bodyBytes,
      clientRequest,
      serverRequest: toServerRequest(clientRequest),
    } satisfies PreparedRequest;
  }).pipe(Effect.withSpan("prepareRequest"));

/** A Registry whose only operation under test is `lookup`. */
export const registryWithLookup = (
  lookup: RegistryClientService["lookup"],
): RegistryClientService => ({
  register: () => Effect.dieMessage("registration is outside this test"),
  lookup,
});

/** AuthenticatedHttp over `registry`, with small test capacities. */
export const authenticatedHttpLayerWithRegistry = (
  registry: RegistryClientService,
  options: {
    readonly registryLookupConcurrencyLimit?: number;
    readonly agentCardCacheCapacity?: number;
  } = {},
) =>
  AuthenticatedHttp.layer({
    liveNonceCapacity: 64,
    agentCardCacheCapacity: options.agentCardCacheCapacity ?? 8,
    registryLookupConcurrencyLimit: options.registryLookupConcurrencyLimit ?? 4,
  }).pipe(Layer.provide(Layer.succeed(Registry, registry)));

/** Verifies `prepared` as the server would. */
export const verifyAgentRequest = (prepared: PreparedRequest) =>
  AuthenticatedHttp.verifyAgentRequest({
    httpRequest: prepared.serverRequest,
    bodyBytes: prepared.bodyBytes,
  });

/** A view of `value` that throws on every member read. */
export const unreadable = <Value extends object>(value: Value): Value =>
  new Proxy(value, {
    get: () => {
      throw new Error("unreadable");
    },
  });

/**
 * Verifies a request from a fresh identity through a Registry whose lookup
 * returns what `lookupResult` builds from that identity's verified card.
 */
export const verifyThroughLookupResult = (
  lookupResult: (agentCard: VerifiedAgentCard) => RegistryLookupResult,
) =>
  Effect.gen(function* () {
    const fixture = yield* makeIdentityFixture;
    const prepared = yield* prepareRequest({ fixture });
    const verified = yield* verifyAgentRequest(prepared).pipe(
      Effect.provide(
        authenticatedHttpLayerWithRegistry(
          registryWithLookup(() =>
            Effect.succeed(lookupResult(fixture.agentCard)),
          ),
        ),
      ),
    );
    return { fixture, verified };
  }).pipe(Effect.withSpan("verifyThroughLookupResult"));

/** Keeps signature time fixed while deadlines use live timers. */
export const clockAt = (milliseconds: number): Clock.Clock => {
  const live = Clock.make();
  return {
    [Clock.ClockTypeId]: Clock.ClockTypeId,
    unsafeCurrentTimeMillis: () => milliseconds,
    currentTimeMillis: Effect.succeed(milliseconds),
    unsafeCurrentTimeNanos: () => BigInt(milliseconds) * 1_000_000n,
    currentTimeNanos: Effect.succeed(BigInt(milliseconds) * 1_000_000n),
    sleep: (duration) => live.sleep(duration),
  };
};

/** Reads the signed expiry so boundary tests follow the request's interval. */
export const signatureExpiry = (prepared: PreparedRequest): number => {
  const signatureInput =
    prepared.serverRequest.headers["signature-input"] ?? "";
  const match = /;expires=(\d+)/u.exec(signatureInput);
  const encodedExpiry = match?.[1];
  if (encodedExpiry === undefined) {
    throw new Error("signed request is missing its expiry");
  }
  const expiry = Schema.NumberFromString.pipe(
    Schema.int(),
    Schema.nonNegative(),
  );
  return Schema.decodeUnknownSync(expiry)(encodedExpiry);
};
