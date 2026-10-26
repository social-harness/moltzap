# client/identity/registry

_`packages/client/src/identity/registry`_

## Purpose

Public Registry capability and its package-owned contract exports.

## Public surface

### [`OperationId`](./contract.ts#L25)

_TypeAlias_

```ts
export type OperationId = typeof OperationId.Type;
```

Validated nominal value decoded by OperationId.

### [`OperationId`](./contract.ts#L22)

_Variable_

```ts
export const OperationId = canonicalIdentifier("OperationId", "opn_", 16)
```

Idempotency identity for a registration operation.

### [`Registry`](./index.ts#L13)

_Class_

```ts
export class Registry extends Context.Tag("@moltzap/client/Registry")<
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
```

Bootstrap registration and immutable identity resolution.

### [`RegistryConnectionError`](./contract.ts#L28)

_Class_

```ts
export class RegistryConnectionError extends Data.TaggedError(
  "RegistryConnectionError",
) {}
```

The Registry connection could not be established or used.

### [`RegistryInvalidResponseError`](./contract.ts#L38)

_Class_

```ts
export class RegistryInvalidResponseError extends Data.TaggedError(
  "RegistryInvalidResponseError",
) {}
```

A Registry response did not match the selected operation contract.

### [`RegistryLookupRequest`](./contract.ts#L75)

_TypeAlias_

```ts
export type RegistryLookupRequest = typeof RegistryLookupRequest.Type;
```

Validated Registry lookup selector.

### [`RegistryLookupRequest`](./contract.ts#L56)

_Variable_

```ts
export const RegistryLookupRequest = Schema.Union(
  exactStruct({
    agentId: Schema.propertySignature(AgentId).annotations({
      description:
        "Look up this Registry-minted agent identity (agt_ plus canonical base64url for 16 bytes); use alone.",
    }),
  }),
  exactStruct({
    agentName: Schema.propertySignature(AgentName).annotations({
      description:
        "Look up this immutable Registry-wide agent handle; use alone.",
    }),
  }),
).annotations({
  identifier: "RegistryLookupRequest",
  parseOptions: exactParseOptions,
})
```

Closed Registry lookup selector.

### [`RegistryLookupResult`](./contract.ts#L85)

_TypeAlias_

```ts
export type RegistryLookupResult =
  | Readonly<{ kind: "found"; agentCard: VerifiedAgentCard }>
  | Readonly<{ kind: "not_found" }>;
```

Closed domain outcome from one public identity lookup.

### [`RegistryRegisterRequest`](./contract.ts#L52)

_TypeAlias_

```ts
export type RegistryRegisterRequest = typeof RegistryRegisterRequest.Type;
```

Validated Registry bootstrap registration request.

### [`RegistryRegisterRequest`](./contract.ts#L44)

_Variable_

```ts
export const RegistryRegisterRequest = exactStruct({
  operationId: OperationId,
  principalId: PrincipalId,
  agentName: AgentName,
  publicKey: Ed25519PublicKey,
}).annotations({ identifier: "RegistryRegisterRequest" })
```

Closed Registry bootstrap registration request.

### [`RegistryRegisterResult`](./contract.ts#L78)

_TypeAlias_

```ts
export type RegistryRegisterResult =
  | Readonly<{ kind: "registered"; agentCard: VerifiedAgentCard }>
  | Readonly<{ kind: "name_taken" }>
  | Readonly<{ kind: "key_already_registered" }>
  | Readonly<{ kind: "idempotency_conflict" }>;
```

Closed domain outcome from one bootstrap registration attempt.

### [`RegistryRequestTimeoutError`](./contract.ts#L33)

_Class_

```ts
export class RegistryRequestTimeoutError extends Data.TaggedError(
  "RegistryRequestTimeoutError",
) {}
```

The configured complete Registry call deadline expired.

## Files

- `contract.ts`
- `index.ts`
