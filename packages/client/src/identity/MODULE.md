# client/identity

_`packages/client/src/identity`_

## Purpose

Identity request authentication and immutable Registry resolution for communication.

## Public surface

### [`AgentCard`](./cards.ts#L97)

_Interface_

```ts
export interface AgentCard {
  readonly agentId: AgentIdValue;
  readonly principalId: PrincipalIdValue;
  readonly agentName: AgentNameValue;
  readonly publicKey: Ed25519PublicKeyValue;
  readonly issuedAt: string;
}
```

Immutable public identity fields carried by an AgentCard.

### [`AgentCard`](./cards.ts#L325)

_Variable_

```ts
export const AgentCard = Object.assign(agentCardSchema, {
  verify: verifyAgentCard,
  wireVersion,
}) as Schema.Schema<AgentCard, unknown> &
  Readonly<{
    readonly verify: typeof verifyAgentCard;
    readonly wireVersion: typeof wireVersion;
  }>
```

Verifies immutable Registry attestation without exposing JOSE mechanics.

### [`AgentCardDigest`](./cards.ts#L63)

_TypeAlias_

```ts
export type AgentCardDigest = typeof AgentCardDigest.Type;
```

Validated nominal value decoded by AgentCardDigest.

### [`AgentCardDigest`](./cards.ts#L56)

_Variable_

```ts
export const AgentCardDigest = canonicalIdentifier(
  "AgentCardDigest",
  "acd_",
  DIGEST_BYTE_LENGTH,
)
```

Digest binding a message to one complete immutable AgentCard.

### [`AgentCardVerificationError`](./cards.ts#L247)

_Class_

```ts
export class AgentCardVerificationError extends Data.TaggedError(
  "AgentCardVerificationError",
) {}
```

A parsed AgentCard does not verify against the pinned Registry signer.

### [`AgentId`](./agents.ts#L19)

_TypeAlias_

```ts
export type AgentId = typeof AgentId.Type;
```

Validated nominal value decoded by AgentId.

### [`AgentId`](./agents.ts#L13)

_Variable_

```ts
export const AgentId = canonicalIdentifier(
  "AgentId",
  "agt_",
  IDENTIFIER_BYTE_LENGTH,
)
```

Canonical network identity minted by the Registry.

### [`AgentName`](./agents.ts#L42)

_TypeAlias_

```ts
export type AgentName = typeof AgentName.Type;
```

Validated nominal value decoded by AgentName.

### [`AgentName`](./agents.ts#L31)

_Variable_

```ts
export const AgentName = Schema.String.pipe(
  Schema.minLength(3),
  Schema.maxLength(32),
  Schema.pattern(/^[a-z0-9]+(-[a-z0-9]+)*$/),
  Schema.brand("AgentName"),
  Schema.annotations({
    identifier: "AgentName",
    description: "Registry-wide immutable agent handle",
  }),
)
```

Immutable Registry-wide human-facing agent handle.

### [`AgentSigningAuthority`](./keys.ts#L473)

_Interface_

```ts
export interface AgentSigningAuthority {
  readonly [agentSigningAuthorityBrand]: "AgentSigningAuthority";
}
```

Opaque authority over one imported Ed25519 private key and the X25519
opening key derived from it.

### [`AgentSigningAuthority`](./keys.ts#L686)

_Variable_

```ts
export const AgentSigningAuthority = Object.freeze({
  fromPkcs8,
  publicKey,
})
```

Loads and identifies one Ed25519 signing authority without exposing its
private keys or a generic signing or decryption operation.

### [`Ed25519PublicKey`](./keys.ts#L301)

_TypeAlias_

```ts
export type Ed25519PublicKey = typeof Ed25519PublicKey.Type;
```

Validated immutable Ed25519 public JWK.

### [`Ed25519PublicKey`](./keys.ts#L270)

_Variable_

```ts
export const Ed25519PublicKey = Schema.transform(
  publicKeyRepresentation,
  publicKeyValueSchema,
  {
    strict: true,
    decode: (value) =>
      Object.freeze({
        crv: value.crv,
        kty: value.kty,
        x: value.x,
      }),
    encode: (value) => ({
      crv: value.crv,
      kty: value.kty,
      x: value.x,
    }),
  },
).pipe(
  Schema.brand("Ed25519PublicKey"),
  Schema.annotations({
    identifier: "Ed25519PublicKey",
    description: "Exact immutable Ed25519 public JWK",
    parseOptions: {
      exact: true,
      onExcessProperty: "error",
    },
  }),
)
```

Exact immutable Ed25519 public JWK.

### [`HISTORY_WIRE_VERSIONS`](./wire-version.ts#L45)

_Variable_

```ts
export const HISTORY_WIRE_VERSIONS = [
  ...LIVE_WIRE_VERSIONS,
  ...RETIRED_WIRE_VERSIONS,
] as const
```

Retained artifacts remain readable until the next protocol reset.

### [`InvalidAgentPrivateKeyError`](./keys.ts#L482)

_Class_

```ts
export class InvalidAgentPrivateKeyError extends Data.TaggedError(
  "InvalidAgentPrivateKeyError",
) {}
```

The supplied private-key material cannot act as an Ed25519 signer or yield
its X25519 opening key. The public contract represents every such cause with
this one empty error.

### [`LIVE_WIRE_VERSIONS`](./wire-version.ts#L39)

_Variable_

```ts
export const LIVE_WIRE_VERSIONS: DistinctWindow<typeof liveWindow> = liveWindow
```

Versions accepted at outer-envelope and authenticated HTTP admission by the
Registry, the Router, and the daemon.

### [`PrincipalId`](./agents.ts#L28)

_TypeAlias_

```ts
export type PrincipalId = typeof PrincipalId.Type;
```

Validated nominal value decoded by PrincipalId.

### [`PrincipalId`](./agents.ts#L22)

_Variable_

```ts
export const PrincipalId = canonicalIdentifier(
  "PrincipalId",
  "prn_",
  IDENTIFIER_BYTE_LENGTH,
)
```

Opaque identity of the principal represented by an agent.

### [`VerifiedAgentCard`](./cards.ts#L232)

_TypeAlias_

```ts
export type VerifiedAgentCard = AgentCard & Brand.Brand<"VerifiedAgentCard">;
```

AgentCard verified against a deployment-pinned Registry signer.

### [`WIRE_VERSION`](./wire-version.ts#L13)

_Variable_

```ts
export const WIRE_VERSION = "2026.1021.3"
```

Every newly signed artifact carries this wire value. Live admission accepts
no other value, so a peer that emits a different one fails with
`version-mismatch`; package publication never determines wire compatibility.

### [`WireVersion`](./wire-version.ts#L51)

_TypeAlias_

```ts
export type WireVersion = (typeof HISTORY_WIRE_VERSIONS)[number];
```

A version represented by retained protocol artifacts.

### [`wireVersions`](./wire-version.ts#L108)

_Variable_

```ts
export const wireVersions = Object.freeze({
  emitted: WireVersions.emitted,
  history: WireVersions.history,
  live: WireVersions.live,
  liveSet: Effect.serviceOption(WireVersions).pipe(
    Effect.map((configuration) =>
      Option.match(configuration, {
        onNone: () => LIVE_WIRE_VERSIONS,
        onSome: (sets) => sets.live,
      }),
    ),
  ),
})
```

Read-only compatibility operations expose no injectable context tag.

## Files

- `agents.ts`
- `cards.ts`
- `keys.ts`
- `wire-version.ts`
