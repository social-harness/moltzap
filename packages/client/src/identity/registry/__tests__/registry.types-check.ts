/**
 * @file Registry keeps its complete public inputs and Effect channels exact.
 * These canaries prevent adapters from leaking private requirements or
 * silently widening the failures consumers must handle.
 */

import type { HttpClient } from "@effect/platform";
import type { Duration, Effect, Layer, Redacted, Types } from "effect";
import type {
  Registry,
  RegistryConnectionError,
  RegistryInvalidResponseError,
  RegistryListRequest,
  RegistryListResult,
  RegistryLookupRequest,
  RegistryLookupResult,
  RegistryRegisterRequest,
  RegistryRegisterResult,
  RegistryRequestTimeoutError,
} from "../../../daemon/index.js";
import type {
  AgentSigningAuthority,
  Ed25519PublicKey,
} from "../../../index.js";
import type {
  AuthenticationFailedError,
  InternalServerError,
  MalformedRequestError,
  MethodNotAllowedError,
  OverloadedError,
  PayloadTooLargeError,
  RouteNotFoundError,
  UnavailableError,
  UnsupportedMediaTypeError,
  VersionMismatchError,
} from "../../signing/http-errors.js";
import type { AgentSigningError } from "../../signing/http-signature.js";
import type { HttpOrigin } from "../../signing/origin.js";

type Expect<Value extends true> = Value;

type RegistryClientFailure =
  | MalformedRequestError
  | RouteNotFoundError
  | MethodNotAllowedError
  | VersionMismatchError
  | PayloadTooLargeError
  | UnsupportedMediaTypeError
  | OverloadedError
  | UnavailableError
  | InternalServerError
  | RegistryConnectionError
  | RegistryRequestTimeoutError
  | RegistryInvalidResponseError;
type RegisterFailure =
  | RegistryClientFailure
  | AuthenticationFailedError
  | AgentSigningError;
type RegisterCall = Readonly<{
  request: RegistryRegisterRequest;
  admissionCredential: Redacted.Redacted;
  signingAuthority: AgentSigningAuthority;
}>;

type RegisterEffect = ReturnType<typeof Registry.register>;
type LookupEffect = ReturnType<typeof Registry.lookup>;
type ListEffect = ReturnType<typeof Registry.list>;
type RegistryLayer = ReturnType<typeof Registry.layer>;

type RegisterInputIsExact = Expect<
  Types.Equals<Parameters<typeof Registry.register>[0], RegisterCall>
>;
type RegisterChannelsAreExact = Expect<
  Types.Equals<
    RegisterEffect,
    Effect.Effect<RegistryRegisterResult, RegisterFailure, Registry>
  >
>;
type LookupChannelsAreExact = Expect<
  Types.Equals<
    LookupEffect,
    Effect.Effect<RegistryLookupResult, RegistryClientFailure, Registry>
  >
>;
type LookupInputIsExact = Expect<
  Types.Equals<Parameters<typeof Registry.lookup>[0], RegistryLookupRequest>
>;
type ListChannelsAreExact = Expect<
  Types.Equals<
    ListEffect,
    Effect.Effect<RegistryListResult, RegistryClientFailure, Registry>
  >
>;
type ListInputIsExact = Expect<
  Types.Equals<Parameters<typeof Registry.list>[0], RegistryListRequest>
>;
type RegistryLayerInputIsExact = Expect<
  Types.Equals<
    Parameters<typeof Registry.layer>[0],
    Readonly<{
      origin: HttpOrigin;
      registrySignerPublicKey: Ed25519PublicKey;
      requestTimeout: Duration.Duration;
    }>
  >
>;
type RegistryLayerIsExact = Expect<
  Types.Equals<
    RegistryLayer,
    Layer.Layer<Registry, never, HttpClient.HttpClient>
  >
>;
/** Compile-time evidence for the public Registry capability. */
export type RegistryCapabilityCanaries = [
  RegisterInputIsExact,
  RegisterChannelsAreExact,
  LookupInputIsExact,
  LookupChannelsAreExact,
  ListInputIsExact,
  ListChannelsAreExact,
  RegistryLayerInputIsExact,
  RegistryLayerIsExact,
];
