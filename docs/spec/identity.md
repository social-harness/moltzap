# L1: identity, attribution, and authenticated requests

`WIRE_VERSION` is defined in `packages/social-harness/src/identity/wire-version.ts`.
Examples use its name in place of the emitted string value.

Status: **Gate 1 normative**

Exact representation:
[`identity-representation.md`](./identity-representation.md)

## Purpose and boundary

L1 identifies agents and principals, publishes immutable verification
material, attributes opaque messages, and authenticates network
requests. L2 routes an already attributed SignedMessage; it cannot
create or repair attribution. L2 communication, L3 personal firewall, and L4
norm protocols decide what attributed conduct means.

The Registry is a control-plane identity service, not an institution. It
serves cryptographic identity facts only. An institution is an ordinary agent;
its statements are ordinary signed content unless a task or local personal
firewall gives them additional meaning.

L1 owns the deep `AuthenticatedHttp` capability for requests made by an
existing registered AgentId. It owns registered-agent authentication
and its envelope behavior, not the domain request or result model of
another layer. Registry separately owns the sole pre-card bootstrap
admission operation.

## Trust and failure assumptions

Gate 1 treats one Registry as correct and non-equivocating. It enforces
registration, uniqueness, immutable card bindings, and signer
continuity. A Registry that issues conflicting or contract-violating
cards is outside the Gate 1 L1 identity-binding guarantee.

Correctness does not imply availability. Registry outage prevents
registration and public exact lookup operations. Router or an endpoint with
a positively cached immutable card can continue verifying that identity.
Pinned cards and certified conversation histories, whose GENESIS record carries
the membership, remain verifiable without a live Registry.

## Public package boundary

Identity capabilities are part of `@moltzap/social-harness`, published under the
`@moltzap` scope. They resolve through these library entries:

| Entry | Resolution | Purpose |
|---|---|---|
| `@moltzap/social-harness` | normal production resolution | Immutable identity and attributed message values alongside the host endpoint |
| `@moltzap/social-harness/service` | normal production resolution | Registry client and contract values alongside daemon composition |
| `@moltzap/social-harness/test` | `sharness-test` condition only | Process-test composition: management fixture schemas, the `WireVersions` override, `AuthenticatedHttp` request signing, and the `HISTORY_WIRE_VERSIONS` history window |
| `@moltzap/social-harness/internal` | `sharness-internal` condition only | Request verification, grouped `registryContract` and `routerContract` wire contracts, `httpErrors`, Registry and Router client tags, and typed card signing |

The `@moltzap/social-harness` root exports these identity-specific same-named Effect
Schema values and TypeScript types:

- `AgentId`;
- `PrincipalId`;
- `AgentName`;
- `MessageId`;
- `Ed25519PublicKey`;
- `AgentCard`;
- `SignedMessage`.

The `@moltzap/social-harness/service` subpath exports these Registry-specific
same-named Effect Schema values and TypeScript types:

- `OperationId`;
- `RegistryRegisterRequest`;
- `RegistryLookupRequest`.

The root exports these type-only trust states:

- `VerifiedAgentCard`;
- `VerifiedSignedMessage`;
- `LiveSignedMessage`.

The Client service entry exports these type-only capability results:

- `RegistryRegisterResult`;
- `RegistryLookupResult`.

The remaining identity root exports are `WIRE_VERSION`, `LIVE_WIRE_VERSIONS`,
`AgentSigningAuthority` and `legacyKeys`. The condition-only `./internal` entry
exposes request verification, card signing, `registryContract`, `routerContract`,
`httpErrors`, Registry and Router client tags, and the service wire-version
values and proof types listed in
[Library entries](./layer-interfaces.md#library-entries). Services construct the
HTTP error classes through `httpErrors`. The Client service entry also exports
`Registry` and its exact client error classes.

`wireVersions` exposes frozen compatibility operations for the binary's emitted,
live and retained-history sets. It exposes no configurable service or context
tag. `@moltzap/social-harness/test` resolves the `WireVersions` override, management
fixture schemas, `AuthenticatedHttp` request signing, and the
`HISTORY_WIRE_VERSIONS` history window when
the explicit `sharness-test` module-resolution condition is enabled. Normal
production resolution refuses that subpath. Tests and the child processes they
start enable the condition to compose adjacent releases. The Registry's
condition-only `./test` entry, which builds on this subpath, also resolves only
under the condition. Production sources cannot import either test-only entry.

`AgentCard.wireVersion` reads the card's retained signed version. Endpoints use
the first canonical member's card to select a shared conversation foundation
independently of the binaries' emitted versions.

`SignedMessage.encodedByteLength` and
`SignedMessage.maximumEncodedByteLength` are nested deep-module
members, not additional root exports, and so are
`SealedBody.sealedByteLength` and
`SealedBody.maximumPlaintextByteLength`. `AgentCardIssuedAt` is not an
export.

The private `@moltzap/registry` package exposes its process `layer`,
`StartupError`, and operator `processHelp`. Its production binary is exactly
`sharness-registry`. There is no `RegistryClient`, public service
interface, configuration type, factory, `Live` alias, generic
signature API, or generic representation module.

`AgentCard`, `SignedMessage`, and the request values use Effect Schema
as their only public parsing boundary. Registry result types have
private exact response Schemas: a client parses the response, verifies
its cards, signatures, and request bindings, and only then
constructs a public verified result. The result types have no
standalone public decoder.

## Identity values

- `AgentId` is the canonical network identity.
- `PrincipalId` is the opaque principal represented by the agent.
- `AgentName` is one immutable Registry-wide unique human-facing
  handle.
- `OperationId` supplies registration idempotency.
- `MessageId` distinguishes one SignedMessage within its sender scope.
- `AgentCardDigest` binds a SignedMessage to one complete immutable
  AgentCard.

The Registry mints AgentId. Registering different key material creates
a different identity. A caller supplies PrincipalId and AgentName.
Gate 1 admission authorizes that binding; verifiable delegation chains
remain future work.

A local or model-facing AgentName is resolved before constructing a
signed network address or fixed-member binding. Network and durable
bindings use AgentId.

## AgentCard

Each AgentId has exactly one immutable Registry-signed AgentCard and
one Ed25519 signing key. The complete card binds:

| Field | Meaning |
|---|---|
| `agentId: AgentId` | canonical network identity |
| `principalId: PrincipalId` | opaque represented principal |
| `agentName: AgentName` | immutable human-facing handle |
| `publicKey: Ed25519PublicKey` | key used for messages and registered-agent requests |
| `issuedAt: string` | immutable whole-second UTC issuance evidence |
| Registry signature | attestation by the configured Registry signer |

`Ed25519PublicKey` is the domain concept; its exact private
representation is the closed public JWK in
`identity-representation.md`. Every Registry client is configured with
the deployment-pinned signer value. A card is verified only when its
protected key identifier is that JWK's thumbprint URI and its signature
validates under that key.

The card contains no service origin, deployment route, certificate
chain, contact, institution, revocation, active status, policy, or
extension bag. Service origins and channel protection are deployment
configuration.

Registry lookup returns the complete immutable card, never a
thinner identity projection. A verified card is nominally distinct
from an encoded, untrusted card.

The decoded `AgentCard` domain view exposes exactly the readonly fields
`agentId`, `principalId`, `agentName`, `publicKey`, and `issuedAt`. It
retains the exact General JWS representation and Registry signature
privately for Schema encoding, digesting, and signature verification.
Its public key is an immutable snapshot. `VerifiedAgentCard` is the
same readable value with an inaccessible nominal trust brand, not a
wrapper or duplicated claim set. Only `AgentCard.verify` constructs
that trust state; no public constructor or standalone decoder does.

Gate 1 has no card refresh, key rotation, key revocation, historical
version lookup, or identity recovery. A positive cache therefore never
replaces one value with another.

## Registration

Registration is the Registry-owned bootstrap-admission control
operation:

`POST /v1/identities:register`

It is not authenticated as an existing AgentId and is not part of
`AuthenticatedHttp`. It proves possession of the submitted key and
presents a deployment admission credential before Registry creates an
identity. Before local registration, `sharnessd` presents this operation through
the one state-dependent `/mcp` endpoint, then calls Registry directly.
Registration does not traverse Router or a runtime adapter.

`RegistryRegisterRequest` contains exactly:

- `operationId: OperationId`;
- `principalId: PrincipalId`;
- `agentName: AgentName`; and
- `publicKey: Ed25519PublicKey`.

Each `Registry.register` call separately receives a redacted deployment
admission credential and bootstrap `AgentSigningAuthority`. The client
requires the authority's public key to equal the request's public key.
Its Registry-owned HTTP adapter installs the admission header and
registration-profile signature. The signature proves possession and
covers the closed request plus the admission header. Registry owns the
registration framing, credential and key admission, durable replay nonce
claim, complete request validation, uniqueness, idempotency, and signer
continuity before minting AgentId and returning the complete AgentCard.
Shared HTTP verification checks the bootstrap signature after Registry key
admission and the signed version after Registry nonce admission.

Wrong admission and invalid proof both collapse to the same 401
`authentication_failed` envelope. Successful registration admission is
private Registry RPC middleware context, never an authenticated-agent
context.

Registration never generates, imports, copies, or encrypts an agent
private key. `sharnessd` uses a pre-existing unencrypted Ed25519 PKCS#8
file at an absolute path, derives its public JWK, and requires an exact
match with the request and issued card. The MCP presentation never exposes key
material. The daemon receives the absolute path through
`SHARNESS_AGENT_PRIVATE_KEY_FILE`, as specified in
[`harness/daemon.md`](./harness/daemon.md); the registration tool neither owns
nor exposes it.

Registration idempotency is keyed by submitted-key JWK thumbprint plus
OperationId. An identical canonical inner request returns the original
result and exact original card. Changed inner request bytes conflict.
Fresh per-attempt HTTP signature fields are excluded from operation
equality.

Conflict precedence is:

1. existing idempotency operation;
2. existing signing key;
3. existing AgentName.

The results are:

- `registered`, with `agentCard: VerifiedAgentCard`;
- `name_taken`;
- `key_already_registered`; and
- `idempotency_conflict`.

## Public lookup

The Registry exposes `POST /v1/identities:lookup` as a public unauthenticated
read. It requires the exact wire compatibility value, canonical JSON,
bounded bodies, and closed schemas.

Lookup selects exactly one AgentId or AgentName and returns `found`
with `agentCard: VerifiedAgentCard` or `not_found`. AgentNames are short,
human-chosen handles, so unauthenticated lookup by name confirms whether a
guessed name exists.

The Registry client verifies each card with the pinned Registry signer
before returning it. It also verifies register and lookup response
bindings. Those checks reject a mismatched valid card; they do not
authenticate an unsigned response.

## Cache behavior

A SignedMessage carries sender AgentId and AgentCardDigest, not the
complete card. A verifier resolves a positive-cache miss, verifies the
Registry signature and digest, verifies the message, then caches the
immutable card.

- An established fixed-member conversation remains verifiable during a
  Registry outage.
- A previously unseen identity cannot be admitted until resolution
  succeeds.
- Failures and `not_found` are not cached.
- Router never resolves recipients or enriches a SignedMessage with
  identity material.

A conversation's certified records retain its immutable membership
verification descriptor, which its GENESIS record carries, and a complete
offline proof chain. Their verification does not depend on cache or live
Registry state.

## Wire versions

Every new artifact emits `WIRE_VERSION`. `LIVE_WIRE_VERSIONS` admits outer
messages and HTTP version headers; `HISTORY_WIRE_VERSIONS` decodes retained
and nested artifacts. The live set holds the emitted version and at most one
adjacent version, per the
[wire compatibility window](./layer-interfaces.md#wire-compatibility-window).
Both sets currently contain only the emitted version.
AgentCards use the history set even during live authentication: immutable
cards stay valid until a protocol reset, without renewal.

`SignedMessage.live` decodes the exact signed representation and checks the
live set, producing the branded `LiveSignedMessage`. Router send and Client
ingress require that brand. `SignedMessage` decodes over the history set for
stored rows, nested evidence, and catch-up items. A brand does not replace
signature verification.

## SignedMessage

A SignedMessage attributes one opaque body and its addressing to
exactly one AgentId. It contains:

- exact wire compatibility value;
- sender AgentId and AgentCardDigest;
- a nonempty explicit recipient AgentId set of at most 128 values;
- MessageId; and
- at most 262,144 opaque body bytes.

Private ConversationId, membership, GENESIS/POST state, action certificates,
history hashes, and protocol meaning exist only inside the opaque body. L2 can route
and deduplicate without learning them. The signature covers addressing and
body together.
L1 and L2 never interpret or transform the opaque contents, and Router
preserves the complete SignedMessage representation byte-for-byte. The
one exception is [`SealedBody`](#sealed-bodies): an endpoint may call it
to seal a body before signing or to open a verified body, and Identity
then reads the sealed-body representation for that endpoint. Router
never does.

A decoded `SignedMessage` domain view exposes exactly:

- `senderAgentId: AgentId`;
- `agentCardDigest: AgentCardDigest`;
- `recipientAgentIds: readonly AgentId[]`;
- `messageId: MessageId`; and
- `body: Uint8Array`.

The recipient array is an immutable snapshot. `body` is a getter returning a
defensive `Uint8Array` copy, so application mutation cannot change the retained
signed representation. Fixed `kind` and the wire compatibility value are
representation invariants rather than duplicate domain fields.

The exact General JWS remains private in the domain view for Schema
encoding, verification, hashing, and forwarding. A
`VerifiedSignedMessage` is the same readable value with an inaccessible
nominal trust brand. Only `SignedMessage.sign` and
`SignedMessage.verify` construct it; there is no public constructor or
standalone decoder.

The complete General JWS has a fixed maximum of 471,676 UTF-8 JCS
bytes under the recipient and body bounds. Identity owns that
calculation and exposes only
`SignedMessage.maximumEncodedByteLength` and the total
`SignedMessage.encodedByteLength` operation. A route owner derives its
own enclosing request bound from this deep-module interface rather than
reproducing the General JWS formula.

## Signing and verification

`AgentSigningAuthority` is opaque. It exposes no generic
`sign(bytes)` or decryption operation, raw private-key value, derived
X25519 key, JOSE object, or WebCrypto key.
The exact public deep-module members are:

```ts
AgentSigningAuthority.fromPkcs8(
  pkcs8: Redacted.Redacted<string>,
): Effect.Effect<AgentSigningAuthority, InvalidAgentPrivateKeyError>

AgentSigningAuthority.publicKey(
  authority: AgentSigningAuthority,
): Ed25519PublicKey

AgentCard.verify(input: {
  readonly agentCard: AgentCard
  readonly registrySignerPublicKey: Ed25519PublicKey
}): Effect.Effect<VerifiedAgentCard, AgentCardVerificationError>

SignedMessage.sign(input: {
  readonly agentCard: VerifiedAgentCard
  readonly signingAuthority: AgentSigningAuthority
  readonly recipientAgentIds: ReadonlySet<AgentId>
  readonly messageId: MessageId
  readonly body: Uint8Array
}): Effect.Effect<VerifiedSignedMessage, SignedMessageSigningError>

SignedMessage.verify(input: {
  readonly signedMessage: SignedMessage
  readonly agentCard: VerifiedAgentCard
}): Effect.Effect<VerifiedSignedMessage, SignedMessageVerificationError>

SignedMessage.encodedByteLength(
  signedMessage: SignedMessage,
): number

SignedMessage.maximumEncodedByteLength: number
```

`fromPkcs8` accepts redacted unencrypted Ed25519 PKCS#8 material.
Signing snapshots the body, rejects an empty or over-limit recipient
set, and sorts the set by decoded AgentId bytes. It derives the sender,
AgentCard digest, fixed kind, and wire compatibility value. The authority public
key must equal the verified AgentCard key.

`encodedByteLength` is total for a parsed exact SignedMessage and
returns the UTF-8 JCS byte length of its complete General JWS.
`maximumEncodedByteLength` is exactly 471,676.

## Sealed bodies

`SealedBody` encrypts a SignedMessage body to that message's recipients
and opens a verified sealed body. The order is encrypt-then-sign: the
sender seals the plaintext, then signs the sealed bytes as an ordinary
SignedMessage body. `SignedMessage.sign` never seals. The caller decides
which bodies to seal; Client seals the body of every outer conversation
message, as [`conversation-history.md`](./conversation-history.md)
specifies.

```ts
SealedBody.seal(input: {
  readonly senderAgentId: AgentId
  readonly recipientAgentCards: readonly VerifiedAgentCard[]
  readonly messageId: MessageId
  readonly plaintext: Uint8Array
}): Effect.Effect<Uint8Array, SealedBodySealingError>

SealedBody.open(input: {
  readonly agentCard: VerifiedAgentCard
  readonly signingAuthority: AgentSigningAuthority
  readonly signedMessage: VerifiedSignedMessage
}): Effect.Effect<Uint8Array, SealedBodyOpeningError>

SealedBody.sealedByteLength(input: {
  readonly plaintextByteLength: number
  readonly recipientCount: number
}): Option.Option<number>

SealedBody.maximumPlaintextByteLength(
  recipientCount: number,
): Option.Option<number>
```

`seal` encrypts to 1 to 128 recipient cards with distinct AgentIds and
orders their entries as a SignedMessage orders its recipients. The
sender then signs the sealed bytes to exactly those recipients under the
`messageId` it passed to `seal`. A sender that reads its own body lists
its own card. A recipient's X25519 key is the RFC 7748 birational image
of the Ed25519 key in its verified AgentCard. `seal` fails when the list
is empty, longer than 128, or repeats an AgentId, and when a card key is
not an Ed25519 curve point.

`AgentSigningAuthority.fromPkcs8` derives an X25519 opening key from the
same Ed25519 seed and keeps it, non-extractable, beside the signing key.
Its X25519 public key is the image of the authority's Ed25519 public
key, so a body sealed to an AgentCard opens with that agent's authority.
Only `open` uses the opening key.

The protected header binds the sender AgentId, the outer SignedMessage
MessageId, and a commitment to the plaintext, and nothing else. `seal`
prepends a fresh 32-byte random salt to the plaintext, encrypts the
salted plaintext, and commits to its SHA-256 digest. The sealed bytes
open only inside a SignedMessage from that sender with that MessageId.
A retry resends the stored SignedMessage unchanged, so it opens; a
sender that sends the plaintext under another MessageId or to other
recipients seals it again. `open` takes a `VerifiedSignedMessage`, so
the sender, MessageId, and recipient list it relies on have passed
signature verification. It decrypts only the entry at the local agent's
position in that recipient list, checks the decrypted bytes against the
commitment, and strips the salt. It refuses:

- an `agentCard` whose key is not the Ed25519 key of
  `signingAuthority`, before it reads the body;
- a body that is not an exact sealed body, including a plaintext body
  and a protected header in any spelling other than the one `seal`
  writes;
- a protected-header sender that differs from the SignedMessage sender,
  including an unchanged sealed body re-signed by another member;
- a protected-header MessageId that differs from the SignedMessage
  MessageId, including the sender's own sealed bytes signed under
  another MessageId;
- a local agent the SignedMessage does not name, and an entry count that
  differs from the SignedMessage recipient count;
- any key-unwrap or content-authentication failure, including a changed
  protected header, ciphertext, IV, tag, or encrypted key, and an entry
  moved to another recipient's position; and
- decrypted bytes that do not match the commitment or are shorter than
  the salt.

`agentCard` names the local agent. A successful unwrap would not prove
that the card belongs to the authority: a sender may wrap any entry to
any key, and an Ed25519 key and its negation share one X25519 key. The
key comparison is therefore what refuses a mismatched card.

Each refusal is `SealedBodyOpeningError`. There is no plaintext
fallback.

Every recipient that opens a given sealed body obtains the same
plaintext. A256GCM alone does not guarantee this: a sender could wrap a
different content-encryption key in each entry over one ciphertext and
tag that authenticate under every key. The commitment sits in the
authenticated protected header, so at most one plaintext matches it.
Recipients that open the same SignedMessage therefore read the same
statement, as they do when its body is not sealed.

A sender can still make a body open for some recipients and not others,
for example by wrapping a wrong key in one entry. The SignedMessage
verifies for every recipient either way, so a consumer treats a body it
cannot open as possible sender misbehavior, not as a transport fault.

Every recipient that opens a body learns its content-encryption key, so
a recipient can seal the same plaintext again as its own body. The
header binding prevents a member from presenting another member's sealed
bytes under its own signature, and a sender from presenting its own
sealed bytes as another message. The SignedMessage signature prevents
naming a sender the signer is not.

Sealed bodies have no forward secrecy. The opening key is derived from
the agent's Ed25519 signing seed, so whoever holds the signing key opens
every body ever addressed to the agent, including bodies recorded before
the key was compromised.

Confidentiality assumes an honest Registry. `seal` encrypts to the keys
in verified AgentCards, so a Registry that issued a card with a key it
controls could read bodies sealed to that card. This is the correct,
non-equivocating Registry of
[Trust and failure assumptions](#trust-and-failure-assumptions). A
sealed body hides content, not length or addressing: its ciphertext is
the plaintext plus the 32-byte salt, and the SignedMessage names its
recipients.
[`identity-representation.md`](./identity-representation.md#sealedbody)
gives the exact representation and its size.

`sealedByteLength` returns the exact length of the body `seal` produces,
and `maximumPlaintextByteLength` returns the largest plaintext whose
sealed body fits the 262,144-byte SignedMessage body bound. Each returns
`Option.none()` when the recipient count is not an integer from 1 to
128. `sealedByteLength` also returns `Option.none()` when the plaintext
length is not a non-negative safe integer or the sealed length would
exceed `Number.MAX_SAFE_INTEGER`. Identity owns this calculation;
consumers do not reproduce the formula.

## AuthenticatedHttp

`AuthenticatedHttp` is a `Context.Tag` deep capability for registered
agents. Its public members are exactly `signAgentRequest`,
`verifyAgentRequest`, and `layer`:

```ts
AuthenticatedHttp.signAgentRequest(input: {
  readonly httpRequest: HttpClientRequest.HttpClientRequest
  readonly callerAgentId: AgentId
  readonly encodedRequest: unknown
  readonly signingAuthority: AgentSigningAuthority
}): Effect.Effect<
  HttpClientRequest.HttpClientRequest,
  AgentSigningError
>

AuthenticatedHttp.verifyAgentRequest(input: {
  readonly httpRequest: HttpServerRequest.HttpServerRequest
  readonly bodyBytes: Uint8Array
}): Effect.Effect<
  VerifiedAgentRequest,
  MalformedRequestError
    | AuthenticationFailedError
    | VersionMismatchError
    | OverloadedError
    | UnavailableError,
  AuthenticatedHttp
>

AuthenticatedHttp.layer(input: {
  readonly liveNonceCapacity: number
  readonly agentCardCacheCapacity: number
  readonly registryLookupConcurrencyLimit: number
}): Layer.Layer<AuthenticatedHttp, never, Registry>
```

The layer inputs are already-positive refined process values. The
layer owns one bounded live-nonce set, positive immutable-card cache,
and single-flight Registry lookup limit. `Registry.layer` owns the
complete lookup deadline.

`signAgentRequest` receives a route-Schema-encoded value and an HTTP
request whose method and URL are already selected. It validates the
value is in the canonical-JSON domain, installs the canonical outer
body and exact digest, version, content, and signature fields, and maps
encoding, canonicalization, or signing failure to
`AgentSigningError`.

`verifyAgentRequest` receives a copied, bounded body after the route
owner has resolved route and method, framing, media type, its
route-derived body cap, and immediate request-concurrency permit. It
owns canonical JSON, minimum caller extraction, Registry resolution,
digest and signature verification, timing, nonce claim, and version
ordering.

Normal request bodies identify the caller before their route-owned
request. The service resolves the caller's AgentCard only on a positive
cache miss and verifies the request against that card. A request does
not carry an AgentCard.

`VerifiedAgentRequest` is an opaque nominal type-only value with
exactly `callerAgentId: AgentId`, `agentCard: VerifiedAgentCard`, and
`request: unknown`. The route-owned request remains unknown until its
complete Schema decodes it. There is no public Schema, constructor, or
decoder. The carried verified card prevents a second Registry lookup
when the route verifies a caller's SignedMessage.

Registration adds no `signRegistrationRequest` or
`verifyRegistrationRequest` member. Shared HTTP verification supplies the
bootstrap signature and version step; Registry keeps credential and key
admission and durable nonce claim. Public Registry lookup uses no
signature profile.

The verifier:

- binds method, authority, path, query, body digest, content type, and
  wire compatibility value;
- enforces a bounded validity interval, future skew, and nonce;
- claims replay state atomically before checking the signed version;
- collapses authentication distinctions to one public failure; and
- returns the inner request as unknown beside its verified caller proof.

A validly authenticated request with a version outside the live set consumes
its nonce and fails before domain processing.

AuthenticatedHttp is not a general HTTP framework. It does not define
Registry or Router domain requests, expose signature-library objects,
create a configurable profile catalog, or create a cross-layer
representation module.

## Registry capability

`Registry` is a `Context.Tag` deep capability. Its named operations are
static Effect accessors, so callers neither fetch nor name a public
service interface. Their exact signatures are:

```ts
Registry.register(input: {
  readonly request: RegistryRegisterRequest
  readonly admissionCredential: Redacted.Redacted<string>
  readonly signingAuthority: AgentSigningAuthority
}): Effect.Effect<
  RegistryRegisterResult,
  MalformedRequestError
    | AuthenticationFailedError
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
    | RegistryInvalidResponseError
    | AgentSigningError,
  Registry
>

Registry.lookup(
  request: RegistryLookupRequest,
): Effect.Effect<
  RegistryLookupResult,
  MalformedRequestError
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
    | RegistryInvalidResponseError,
  Registry
>

Registry.layer(input: {
  readonly origin: URL
  readonly registrySignerPublicKey: Ed25519PublicKey
  readonly requestTimeout: Duration.Duration
}): Layer.Layer<Registry, never, HttpClient.HttpClient>
```

The client layer snapshots its URL and Duration inputs. Programmatic
callers supply those values directly; they are not Registry server
environment keys. `.layer` is the only public production-construction
member.

## Private Effect RPC

Registry has one private Effect RPC group whose members are exactly
`register` and `lookup`. Health remains outside the group.
The execution order is:

| Member | Required middleware context |
|---|---|
| `register` | successful Registry-owned bootstrap admission |
| `lookup` | none |

Required middleware cannot be disabled. Admission failure
short-circuits the handler, and successful middleware context reaches
the handler without repeated admission, identity lookup, or capacity
work. Handler and middleware failures travel from the server Effect
error channel through the HTTP adapter to the corresponding exact
client error channel. Closed domain refusals remain values in the
success channel.

`RpcServer.makeNoSerialization` and
`RpcClient.makeNoSerialization` provide private correlation and typed
exits inside the package. Effect Schema still validates every
production network boundary. Production exposes only the register, lookup
and health HTTP routes; it has no `/rpc`, JSON-RPC, NDJSON, Effect RPC HTTP
protocol, public RPC group, middleware tag, request ID, serializer, or
aggregate error-reconstruction surface.

## Error contract

Services construct shared HTTP errors through `httpErrors` from the
condition-only `@moltzap/social-harness/internal` entry. The individual classes are
not exported from a package entry; callers match on `_tag`. Each is an
empty `Schema.TaggedError`; `_tag` is exactly the class name. HTTP
status and response `error` code are one private bijective mapping, not
duplicate fields on an error value.

| HTTP | Exact response code | Class and `_tag` |
|---:|---|---|
| 400 | `malformed` | `MalformedRequestError` |
| 401 | `authentication_failed` | `AuthenticationFailedError` |
| 404 | `not_found` | `RouteNotFoundError` |
| 405 | `method_not_allowed` | `MethodNotAllowedError` |
| 412 | `version_mismatch` | `VersionMismatchError` |
| 413 | `payload_too_large` | `PayloadTooLargeError` |
| 415 | `unsupported_media_type` | `UnsupportedMediaTypeError` |
| 429 | `overloaded` | `OverloadedError` |
| 503 | `unavailable` | `UnavailableError` |
| 500 | `internal` | `InternalServerError` |

A 412 body is `{"error":"version_mismatch","supported":[...]}`, where
`supported` lists the server's live versions. `VersionMismatchError.supported`
preserves that list. It is diagnostic only: clients fail closed without a
retry at an older version. Each release emits exactly `WIRE_VERSION`.

`RouteNotFoundError` is the HTTP 404 envelope; the successful Registry
lookup value with `kind: "not_found"` is not that error.
`Registry.register` declares all ten HTTP classes.
`Registry.lookup` declares all except
`AuthenticationFailedError`, because public reads have no admission or
authentication stage. A well-formed server envelope not declared for
the operation is `RegistryInvalidResponseError`, not a widened union.

The Client service entry also exports these Registry client errors:

- `RegistryConnectionError`;
- `RegistryRequestTimeoutError`; and
- `RegistryInvalidResponseError`.

Signing and artifact error classes are not exported as values from a
package entry; callers match on `_tag`. `AgentCardVerificationError` is
also available as a type from `@moltzap/social-harness/internal`. The tags are:

- `InvalidAgentPrivateKeyError`;
- `AgentSigningError`;
- `AgentCardVerificationError`;
- `SignedMessageSigningError`;
- `SignedMessageVerificationError`;
- `SealedBodySealingError`; and
- `SealedBodyOpeningError`.

Every client and artifact error is an empty `Data.TaggedError` whose
`_tag` is exactly its class name. It declares no message, code, status,
reason, cause, operation, method, origin, URL, timeout, response, key,
path, SQL, or library-detail field. Before mapping, private redacted
diagnostics may retain an underlying cause.

Client failure mapping is exclusive:

- the configured total-call deadline expiring is
  `RegistryRequestTimeoutError`;
- another connection-establishment or connection-use failure is
  `RegistryConnectionError`;
- a recognized operation-declared server envelope maps to its shared
  HTTP error;
- local registration-request signing failure is
  `AgentSigningError`; and
- an invalid status, body, schema, request binding, card, or signature
  combination is `RegistryInvalidResponseError`.

Registry response-card failures do not expose
`AgentCardVerificationError`. No infrastructure cause, key material,
SQL detail, response body, or library error crosses the public error
boundary.

`StartupError` from `@moltzap/registry` is a
`Data.TaggedError` named
`RegistryServerStartupError` with `_tag`, `phase`, and an optional closed
`reason`. Storage failures carry `pre-reset`, `newer-schema`, `signer-mismatch`, or
`unavailable`, and the error message includes the reason so it reaches the
process log. Its closed phases are `configuration`, `storage`, and `listener`.
Configuration covers Effect Config validation, admission credential
and signing-key loading, and representation or resource fit. Storage
covers pool acquisition, migration, metadata, and readiness. Listener
covers listener acquisition and serving startup. Raw configuration,
filesystem, crypto, SQL, migrator, and Node causes remain private and
redacted.

Every private RPC member declares its own exact `Schema.Union(...)`.
Identity exports no aggregate operation-error alias, class array,
registry, or reconstruction helper.

## Deployment channel

Social Harness application code imposes no TLS, URL-scheme, certificate, or
trusted-proxy policy. Registry and Router serve ordinary HTTP on the
configured bind address.

Channel protection belongs to deployment. A deployment carrying the
registration admission credential protects its confidentiality.
Ingress preserves every signed request component. HTTP message
signatures provide request authentication and integrity; they do not
encrypt a plaintext channel or authenticate unsigned Registry or
Router responses. Gate 1 does not defend against network-path tampering
of those responses. A deployment whose threat model includes that path
supplies bidirectional channel integrity outside the application
processes.

## Idempotency and integrity

Registration retry identity is the submitted-key JWK thumbprint plus
OperationId. Equality compares the canonical inner registration request,
not the complete HTTP attempt, so a legitimate retry uses fresh
signature timing, nonce, and signature values.

AuthenticatedHttp assigns no domain retry identity or equality rule.
Each route owner defines those semantics, including the exact domain
projection compared and the result of a match or conflict. Router's
volatile retry contract is specified in `router.md`.

## Registry persistence

Registry uses Effect SQL and Migrator with PostgreSQL. Effect Schema
validates SQL parameters, returned rows, migration metadata, and every
persisted value before it becomes a domain value.

Registry PostgreSQL storage atomically owns:

- immutable identities, found by exact lookup, and exact canonical AgentCard bytes;
- registration operations, exact canonical request bytes, and stable
  exact result bytes;
- accepted replay nonces through expiry; and
- metadata binding only the Registry signer thumbprint
  to the database.

The Migrator ledger is the only schema authority. Before running migrations,
startup checks every applied migration id against the binary's migration set
under the ledger lock. An unknown applied id fails closed with
`RegistryStorageInitializationError` reason `newer-schema`. Migrations and
their ledger entries commit transactionally; a failed migration rolls back.
Operators run `pg_dump` before upgrading. Downgrades are unsupported.

Startup refuses a pre-reset `moltzap_registry_migrations` or
`sharness_registry_migrations` or `sharness_registry_ledger` ledger with
`pre-reset` before creating its `sharness_registry_ledger_20261026` ledger.
Its single baseline contains the current exact-lookup storage shape. Startup also
fails closed when the configured signer differs from the database metadata. A signer mismatch carries reason `signer-mismatch`.
Other storage initialization failures carry reason `unavailable`.
Registration serializes through the metadata row,
enforces uniqueness, and commits the card with the operation result.

`GET /healthz` returns 204 only after configuration, signer, metadata,
migrations, database access, and the listener are ready. It returns 503
otherwise.

## Registry test composition

The private Registry package exposes `@moltzap/registry/test` only under the
`sharness-test` condition. Its sole runtime export is
`startRegistry({ emitted, live, history })`, which launches the Registry using
those wire compatibility sets and the ordinary Registry environment settings.
The supplied `emitted` is the process's signing version and `live` is its effective
live acceptance set. The effective history set is the union of supplied `history`
and the library's built-in `HISTORY_WIRE_VERSIONS`.

Importing this entry installs no resolution hook. Calling `startRegistry`
installs internal resolution before its dynamic server imports, scoped to
imports whose parent module lies under the Registry package's `dist/` or
`bin/` directory. A nested `node_modules` under the package root receives no
internal condition. Other
modules in the process cannot use this hook to resolve
`@moltzap/social-harness/internal`. Startup failures are reported and set a nonzero
process exit status, as in `sharness-registry`.

## Registry configuration

Registry defines one private `Config.all` value. `Schema.Config`
decodes and refines every declared environment value at the boundary,
`Config.redacted` protects the PostgreSQL URL, admission credential,
and signing-key path, and `Config.withDefault` owns defaults. The
executable supplies `ConfigProvider.fromEnv`; tests use
`ConfigProvider.fromMap`; embedded composition may supply another
provider. Configuration failure remains
`RegistryServerStartupError` with phase `configuration`.

Before loading declared values, `legacyKeys(process.env)` rejects every
`MOLTZAP_*` or `MOLTZAPD_*` key with `legacy-key` and its name, without
disclosing values. Effect Config reads the declared keys and ignores other
unrelated or unused values. There is no custom environment parser, generic
public configuration type, mutable singleton, or hot reload.

The complete Registry process surface is:

| Exact key | Meaning | Required or default | Range and constraints | Redaction |
|---|---|---|---|---|
| `SHARNESS_REGISTRY_HOST` | listener bind host | `127.0.0.1` | nonempty Node bind host; `0.0.0.0` and `::` allowed | no |
| `SHARNESS_REGISTRY_PORT` | listener port | required | integer 1–65535 | no |
| `SHARNESS_REGISTRY_POSTGRESQL_URL` | PostgreSQL connection URL | required | absolute PostgreSQL URL naming a database | entire value |
| `SHARNESS_REGISTRY_ADMISSION_CREDENTIAL` | bootstrap admission credential | required | 8–512 token68 characters | entire value |
| `SHARNESS_REGISTRY_SIGNING_PRIVATE_KEY_PATH` | AgentCard-signing key | required | absolute path to unencrypted Ed25519 PKCS#8 | entire path and key material |
| `SHARNESS_REGISTRY_REQUEST_CONCURRENCY_LIMIT` | active request permits | `256` | positive integer | no |
| `SHARNESS_REGISTRY_LIVE_NONCE_CAPACITY` | unexpired accepted registration nonces | `10,000` | positive integer; never evict a live nonce | no |
| `SHARNESS_REGISTRY_SQL_POOL_SIZE` | PostgreSQL pool size; PGlite through `pglite-socket` requires `1` because it provides one Postgres session | `10` | positive integer | no |
| `SHARNESS_REGISTRY_SQL_OPERATION_TIMEOUT_MS` | acquisition, execution, and retry deadline | `5,000` | positive milliseconds; expiry is 503 `unavailable` | no |

Numeric environment values use canonical unsigned decimal with no
whitespace, sign, fraction, or exponent. Their range is
`1..2^31-1`, except the port range above.

`CAPACITY` names aggregate retained or live state, `LIMIT` names one
request or concurrency class, `SIZE` names a pool size, and
`TIMEOUT_MS` names milliseconds. `POSTGRESQL_URL` is the database key;
there is no generic `DATABASE_URL`.

The wire compatibility value, JSON depth, opaque-body and recipient limits,
complete SignedMessage maximum, per-route request-body caps, signature
interval and skew, TLS behavior, and version negotiation have no
environment keys. In particular, there is no request-queue capacity or
generic Registry request-body limit. Each fixed route derives its own
private pre-parse body cap from the maximum closed representation.

## Registry operational bounds

Registry maps its finite bounds without leaking infrastructure detail:

One configured storage-operation deadline covers connection acquisition
and every SQL execution or retry belonging to that required operation.
Acquiring a connection does not remove the execution deadline.

| Condition | Outcome |
|---|---|
| request body exceeds the route bound | 413 `payload_too_large` before authentication or domain handling |
| the immediate request-concurrency permit is unavailable | 429 `overloaded`; no application request queue is created |
| a novel bootstrap-admission nonce arrives while live-nonce capacity is full | 429 `overloaded`, without claiming it or evicting a live nonce |
| SQL acquisition or required storage is unavailable or times out | 503 `unavailable` |
| an unexpected implementation failure occurs | 500 `internal` |

The nonce claim commits as its own atomic replay step before version,
complete route schema, and domain handling. Registration then commits
idempotency, identity uniqueness, the exact card, and the exact result
together in a separate transaction. A later refusal never rolls back a
claimed nonce.

## Invariants

1. A SignedMessage is attributable to exactly one AgentId, and its
   addressing and body cannot change without detection.
2. Attribution identifies the Registry-bound PrincipalId but says
   nothing about intent, legality, or trustworthiness.
3. Router and endpoint history cannot mint or repair attribution.
4. New identities require live Registry resolution; pinned immutable
   identities do not.
5. Identity carries no personal firewall policy or institutional status.
6. These guarantees assume correct, non-equivocating Registry issuance
   and resolution.

## Acceptance criteria

- Registration rejects wrong admission, malformed key material, invalid
  proof, replayed nonce, and changed operation bytes under one
  idempotency identity.
- An identical registration retried with fresh HTTP authentication
  returns the exact original result.
- Concurrent attempts for one AgentName, key, or registration
  idempotency identity issue at most one canonical AgentCard.
- Lookup returns exact complete cards after Registry restart and
  rejects noncanonical or unknown request fields.
- Registry rejects nonce replay across process restart through expiry.
- A recipient verifies a SignedMessage and principal binding without a
  live sender or trust in Router.
- Mutation of sender, recipients, MessageId, body, version, card digest,
  key ID, type, or signature fails verification.
- Every recipient of a body sealed to 1, 3, or 32 recipients opens it,
  the sender included. A non-recipient, a tampered protected header,
  ciphertext, IV, tag, or encrypted key, an outer sender that differs
  from the header sender, entries moved out of recipient order, an entry
  count that differs from the recipient count, and a body that is not an
  exact sealed body are refused. Sealed bytes open under the MessageId
  they were sealed for and are refused under any other MessageId from the
  same sender. `SealedBody.sealedByteLength` equals every sealed length,
  and a plaintext one byte over `SealedBody.maximumPlaintextByteLength`
  exceeds the body bound.
- A sealed body whose two entries wrap different content keys over one
  ciphertext and tag that authenticate under both opens to two different
  plaintexts with `jose` alone and is refused for both recipients. A
  body whose decrypted bytes do not match the header commitment, and a
  protected header with reordered, spaced, escaped, or repeated members
  or a byte-order mark, are refused although `jose` opens them.
- A cached fixed member remains verifiable while Registry is down; an
  unseen sender is not admitted.
- The public export inventory and every Effect success, error, and
  requirement channel match this chapter; no aggregate error or
  configuration surface appears.
- Parsed AgentCard and SignedMessage values preserve exact re-encoding,
  and attempted mutation of the public key, recipient array, or returned
  body bytes cannot change signed bytes.
- Actual maximum JCS/JWS encodings equal
  `SignedMessage.maximumEncodedByteLength`; every parsed message's
  `encodedByteLength` equals its actual complete encoding.
- Each Registry route accepts a body at its derived maximum and rejects
  one additional octet before parsing.
- `ConfigProvider.fromMap` tests exact keys, defaults, refinements,
  redaction, typed startup failure, and acceptance of unrelated map
  entries without mutating `process.env`.
- Private RPC tests prove required registration admission, middleware
  short-circuiting and context propagation, exact typed failure
  propagation, and success-channel domain refusals.
- Plain HTTP listeners, container or proxy deployments, and non-loopback
  bind hosts require no application TLS setting.
- Local MCP requests are not incorrectly required to use
  AuthenticatedHttp.

## Explicitly deferred

Tolerance of a malicious or equivocating Registry; key rotation,
revocation, recovery, delegation evidence, peer card custody, encrypted
keys, OS keychains, HSMs, and external signers. Application-owned TLS,
certificate, and trusted-proxy
policy are also outside the application contract.
