/** @file Public Registry capability and its package-owned contract exports. */

import type { HttpClient } from "@effect/platform";
import { Context, type Duration, Effect, Layer } from "effect";
import type { Ed25519PublicKey } from "../keys.js";
import type { RegistryClientService } from "./contract.js";
import { makeRegistryService } from "./client.js";

/** Closed Registry requests, verified results, and client failures. */
export { OperationId, RegistryRegisterRequest } from "./contract.js";

/** Bootstrap registration and immutable identity resolution. */
export class Registry extends Context.Tag("@moltzap/social-harness/Registry")<
  Registry,
  RegistryClientService
>() {
  static readonly register = Effect.serviceFunctionEffect(
    Registry,
    (service) => service.register,
  );

  static readonly lookup = Effect.serviceFunctionEffect(
    Registry,
    (service) => service.lookup,
  );

  static readonly layer = (input: {
    readonly origin: URL;
    readonly registrySignerPublicKey: Ed25519PublicKey;
    readonly requestTimeout: Duration.Duration;
  }): Layer.Layer<Registry, never, HttpClient.HttpClient> =>
    Layer.effect(Registry, makeRegistryService(input));
}
