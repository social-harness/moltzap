/**
 * @file AuthenticatedHttp keeps its complete signing and verification inputs and
 * Effect channels exact. These canaries prevent adapters from leaking private
 * requirements or silently widening the failures consumers must handle.
 */

import type { HttpClientRequest, HttpServerRequest } from "@effect/platform";
import type { Effect, Layer, Types } from "effect";
import type { AgentId, AgentSigningAuthority } from "../../../index.js";
import type { Registry } from "../../registry/index.js";
import type {
  AuthenticatedHttp,
  VerifiedAgentRequest,
} from "../../request-authentication.js";
import type {
  AuthenticationFailedError,
  MalformedRequestError,
  OverloadedError,
  UnavailableError,
  VersionMismatchError,
} from "../http-errors.js";
import type { AgentSigningError } from "../http-signature.js";

type Expect<Value extends true> = Value;

type AuthenticationFailure =
  | MalformedRequestError
  | AuthenticationFailedError
  | VersionMismatchError
  | OverloadedError
  | UnavailableError;

type SignCall = Readonly<{
  httpRequest: HttpClientRequest.HttpClientRequest;
  callerAgentId: AgentId;
  encodedRequest: unknown;
  signingAuthority: AgentSigningAuthority;
}>;
type VerifyCall = Readonly<{
  httpRequest: HttpServerRequest.HttpServerRequest;
  bodyBytes: Uint8Array;
}>;

type SignEffect = ReturnType<typeof AuthenticatedHttp.signAgentRequest>;
type VerifyEffect = ReturnType<typeof AuthenticatedHttp.verifyAgentRequest>;
type AuthenticationLayer = ReturnType<typeof AuthenticatedHttp.layer>;

type SignInputIsExact = Expect<
  Types.Equals<
    Parameters<typeof AuthenticatedHttp.signAgentRequest>[0],
    SignCall
  >
>;
type SignChannelsAreExact = Expect<
  Types.Equals<
    SignEffect,
    Effect.Effect<HttpClientRequest.HttpClientRequest, AgentSigningError>
  >
>;
type VerifyInputIsExact = Expect<
  Types.Equals<
    Parameters<typeof AuthenticatedHttp.verifyAgentRequest>[0],
    VerifyCall
  >
>;
type VerifyChannelsAreExact = Expect<
  Types.Equals<
    VerifyEffect,
    Effect.Effect<
      VerifiedAgentRequest,
      AuthenticationFailure,
      AuthenticatedHttp
    >
  >
>;
type AuthenticationLayerInputIsExact = Expect<
  Types.Equals<
    Parameters<typeof AuthenticatedHttp.layer>[0],
    Readonly<{
      liveNonceCapacity: number;
      agentCardCacheCapacity: number;
      registryLookupConcurrencyLimit: number;
    }>
  >
>;
type AuthenticationLayerIsExact = Expect<
  Types.Equals<
    AuthenticationLayer,
    Layer.Layer<AuthenticatedHttp, never, Registry>
  >
>;

/** Compile-time evidence for the public AuthenticatedHttp capability. */
export type AuthenticatedHttpCapabilityCanaries = [
  SignInputIsExact,
  SignChannelsAreExact,
  VerifyInputIsExact,
  VerifyChannelsAreExact,
  AuthenticationLayerInputIsExact,
  AuthenticationLayerIsExact,
];
