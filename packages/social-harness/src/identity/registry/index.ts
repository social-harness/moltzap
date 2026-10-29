/** @file Public Registry capability and its package-owned contract exports. */

import type { HttpClient } from "@effect/platform";
import { Context, type Duration, Effect, Layer } from "effect";
import type { Ed25519PublicKey } from "../keys.js";
import type { RegistryClientService } from "./contract.js";
import { makeRegistryService } from "./client.js";

/** Closed Registry requests, verified results, and client failures. */
export { OperationId, RegistryRegisterRequest } from "./contract.js";

/**
 * Registers signing keys and resolves immutable cards through a pinned Registry.
 *
 * Domain outcomes, including registration refusals and lookup `not_found`,
 * are success values. Match failures in the Effect error channel by `_tag`.
 * A recognized server envelope becomes its declared HTTP error. An undeclared
 * envelope, unexpected status or content type, malformed body, or invalid
 * card signature or request binding becomes `RegistryInvalidResponseError`.
 * HTTP 404 is `RouteNotFoundError`, distinct from a successful `not_found` lookup.
 *
 * Expiry of the complete call deadline is `RegistryRequestTimeoutError`.
 * Other failures to establish or use the connection are
 * `RegistryConnectionError`. Local registration signing failures are
 * `AgentSigningError`.
 *
 * Use `VersionMismatchError.supported` only for diagnostics. The client fails
 * closed and never retries at an older version. The exact HTTP envelopes are
 * specified in [Identity wire formats](https://docs.moltzap.xyz/reference/spec/network/identity-representation#envelope-failures).
 */
export class Registry extends Context.Tag("@moltzap/social-harness/Registry")<
  Registry,
  RegistryClientService
>() {
  /**
   * Proves possession of the submitted key using the deployment admission credential.
   *
   * The authority's public key must equal `request.publicKey`. Reuse the
   * request's OperationId and fields for a retry. Each call creates a fresh
   * HTTP signature and nonce.
   * A successful card is verified against the pinned Registry signer and must
   * match the requested principal, name, and signing key.
   *
   * Registration accepts every declared HTTP envelope from the wire contract.
   */
  static readonly register = Effect.serviceFunctionEffect(
    Registry,
    (service) => service.register,
  );

  /**
   * Resolves one exact AgentId or AgentName through the public lookup route.
   *
   * A found card is verified against the pinned Registry signer and must match
   * the selector. Lookup accepts the declared HTTP envelopes except
   * `AuthenticationFailedError`, which is an invalid response on this public route.
   */
  static readonly lookup = Effect.serviceFunctionEffect(
    Registry,
    (service) => service.lookup,
  );

  /**
   * Uses one deadline for each complete Registry call.
   *
   * The deadline covers request preparation, transport, response decoding,
   * and card verification together.
   *
   * @param input Settings fixed for the client's lifetime.
   * @param input.origin Registry HTTP origin, snapshotted at construction.
   * @param input.registrySignerPublicKey Deployment-pinned key for verifying returned cards.
   * @param input.requestTimeout Total call deadline, snapshotted at construction.
   * @returns A Registry layer using an injected HTTP client, with no typed acquisition failure.
   */
  static readonly layer = (input: {
    readonly origin: URL;
    readonly registrySignerPublicKey: Ed25519PublicKey;
    readonly requestTimeout: Duration.Duration;
  }): Layer.Layer<Registry, never, HttpClient.HttpClient> =>
    Layer.effect(Registry, makeRegistryService(input));
}
