/** @file Registry composition without a platform URL type in its public contract. */
import type { HttpClient } from "@effect/platform";
import { Context, type Duration, type Layer } from "effect";
import type { Ed25519PublicKey } from "../keys.js";
import type { HttpOrigin } from "../signing/origin.js";
import type { RegistryClientService } from "./contract.js";
import { Registry as RegistryTag } from "./index.js";

/** Immutable resolution retains the same Effect requirement as internal Registry calls. */
export type Registry = RegistryTag;

interface RegistryCapability
  extends Context.Tag<Registry, RegistryClientService> {
  readonly register: typeof RegistryTag.register;
  readonly lookup: typeof RegistryTag.lookup;
  readonly list: typeof RegistryTag.list;
  readonly layer: (input: {
    readonly origin: HttpOrigin;
    readonly registrySignerPublicKey: Ed25519PublicKey;
    readonly requestTimeout: Duration.Duration;
  }) => Layer.Layer<Registry, never, HttpClient.HttpClient>;
}

/** Trusted compositions install one Registry capability using only a serialized origin. */
// eslint-disable-next-line @typescript-eslint/naming-convention, @typescript-eslint/no-redeclare -- The capability tag shares the name of its Effect requirement.
export const Registry: RegistryCapability = Object.assign(
  Context.GenericTag<Registry, RegistryClientService>(RegistryTag.key),
  {
    register: RegistryTag.register,
    lookup: RegistryTag.lookup,
    list: RegistryTag.list,
    layer: (input: {
      readonly origin: HttpOrigin;
      readonly registrySignerPublicKey: Ed25519PublicKey;
      readonly requestTimeout: Duration.Duration;
    }) => RegistryTag.layer({ ...input, origin: new URL(input.origin.href) }),
  },
);
