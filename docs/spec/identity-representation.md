# L1 representation

## Canonical JSON

Every L1 JSON request, result, signed payload, protected header, and
complete General JWS or General JWE object uses RFC 8785 JSON
Canonicalization Scheme UTF-8 bytes. The one exception is the
[SealedBody](#sealedbody) protected header.

A complete decoder:

1. reads within the owning artifact's fixed maximum or the HTTP
   route's privately derived body cap;
2. decodes fatal UTF-8;
3. parses one unknown JSON value with Effect `Schema.parseJson()`;
4. applies a private Effect Schema refinement that rejects container
   depth over 16 and unpaired Unicode surrogates;
5. canonicalizes that value with JCS and requires the input bytes to
   match; and
6. decodes through the exact closed schema.

No semantic value escapes before every step succeeds. Registered-agent
`AuthenticatedHttp` and Registry bootstrap admission each perform steps
1 through 4 as their parse prelude, perform step 5 before
authentication, then perform the complete route-owned schema decode at
the specified later stage.

Duplicate object names require no second parser. Native JSON parsing
collapses them, so the resulting value's JCS bytes cannot equal input
bytes that contain the repeated member. The mandatory byte comparison
therefore rejects every duplicate-name input.

The maximum decoded JSON container depth is 16. A root object or array
has depth 1, each nested object or array adds 1, and scalar values add
no depth. A decoder rejects excess depth before constructing a semantic
value. This Gate 1 bound is not deployment-configurable.

Unknown members, duplicate members, trailing data, byte-order marks,
lone surrogate code points, and non-JCS number spellings are rejected.
No input is normalized before comparison.

Objects shown in this chapter use readable key order. Their bytes use
JCS key order.

## Base64url

JWS, JWE, identifiers, digests, nonces, JWK coordinates, and opaque
bodies use RFC 4648 base64url without `=` padding. Decoders reject:

- the standard base64 `+` and `/` alphabet;
- padding;
- whitespace;
- an impossible encoded length;
- nonzero unused trailing bits; and
- any spelling that does not re-encode byte-identically.

An opaque body may contain zero bytes, represented by the empty string.
After canonical base64url decoding it contains at most 262,144 bytes.
This Gate 1 maximum is fixed, not deployment-configurable.

## Refined values

| Value | Exact JSON string |
|---|---|
| `AgentId` | `agt_` plus the 22-character canonical base64url encoding of 16 bytes |
| `PrincipalId` | `prn_` plus the 22-character canonical base64url encoding of 16 bytes |
| `OperationId` | `opn_` plus the 22-character canonical base64url encoding of 16 bytes |
| `MessageId` | `msg_` plus the 22-character canonical base64url encoding of 16 bytes |
| `AgentCardDigest` | `acd_` plus the 43-character canonical base64url encoding of 32 bytes |
| `AgentName` | 3 to 32 ASCII characters matching `^[a-z0-9]+(-[a-z0-9]+)*$` |
| `issuedAt` | whole-second UTC matching `YYYY-MM-DDTHH:mm:ssZ` |

`issuedAt` rejects fractional seconds, offsets, spaces, leap-second
spelling, and any equivalent alternate representation.

Each semantic value has a distinct nominal type. A decoder for one
prefix never constructs another type.

## Ed25519 public JWK

The public JWK is exactly:

```json
{
  "crv": "Ed25519",
  "kty": "OKP",
  "x": "<43-character canonical base64url encoding of 32 bytes>"
}
```

Member names and values are case-sensitive. No `alg`, `d`, `key_ops`,
`kid`, `use`, X.509 member, JWK URL, or extension member is permitted.

The key identifier is the RFC 9278 JWK Thumbprint URI computed from the
exact public JWK:

```text
urn:ietf:params:oauth:jwk-thumbprint:sha-256:<thumbprint>
```

`<thumbprint>` is the canonical unpadded base64url SHA-256 digest
defined by RFC 7638 and RFC 9278.

Every Ed25519 verification in this chapter uses one strict profile.
Signature `R` and `S` use their canonical encodings, `S` is less than
the Ed25519 subgroup order, and small-order public keys are rejected.
Verification uses the cofactorless equation. These rules apply
identically to AgentCard, SignedMessage, registered-agent HTTP, and
Registry bootstrap signatures.

## AgentCard

### Payload

The payload is exactly:

```json
{
  "kind": "agentCard",
  "sharnessVersion": "WIRE_VERSION",
  "agentId": "agt_<22-character-base64url>",
  "principalId": "prn_<22-character-base64url>",
  "agentName": "example-agent",
  "publicKey": {
    "crv": "Ed25519",
    "kty": "OKP",
    "x": "<43-character-base64url>"
  },
  "issuedAt": "YYYY-MM-DDTHH:mm:ssZ"
}
```

The payload has no optional member. In these examples, `WIRE_VERSION` stands
for the emitted version described in [Wire versions](./identity.md#wire-versions).

### General JWS

An encoded AgentCard is one attached General JWS object:

```json
{
  "payload": "<base64url(JCS payload bytes)>",
  "signatures": [
    {
      "protected": "<base64url(JCS protected-header bytes)>",
      "signature": "<86-character base64url Ed25519 signature>"
    }
  ]
}
```

The decoded protected header is exactly:

```json
{
  "alg": "Ed25519",
  "kid": "<Registry signer RFC-9278 JWK Thumbprint URI>",
  "typ": "application/vnd.sharness.agent-card+jws"
}
```

`Ed25519` is the fully specified JOSE algorithm identifier from RFC
9864.

An AgentCard verifier receives the deployment-pinned Registry signer
public JWK. It requires the protected `kid` to equal that key's RFC 9278
thumbprint URI and verifies the signature with that key. The JWS never
supplies its own trust root.

The outer object, signature object, protected header, and payload are
closed. `signatures` has exactly one member. The signature object has no
unprotected `header`.

Compact JWS, Flattened JWS, detached payloads, multiple signatures,
unprotected headers, `b64`, `crit`, `cty`, embedded JWKs, JWK URLs, and
X.509 members are rejected.

`AgentCardDigest` is `acd_` plus canonical base64url SHA-256 over the
UTF-8 JCS bytes of the complete General JWS object.

The public `AgentCard` Effect Schema has this General JWS as its encoded
side. Its TypeScript side exposes exactly the readonly domain fields
`agentId`, `principalId`, `agentName`, `publicKey`, and `issuedAt`.
The exact JWS remains private in the value for lossless Schema encoding,
digesting, and verification. `publicKey` is an immutable snapshot.
Fixed `kind` and `sharnessVersion` remain representation invariants, not
duplicate domain fields.

`VerifiedAgentCard` is a nominal subtype with the same readable fields.
Only successful `AgentCard.verify` constructs its inaccessible trust
brand; no Schema, constructor, or standalone decoder is public.

## SignedMessage

### Payload

The payload is exactly:

```json
{
  "kind": "signedMessage",
  "sharnessVersion": "WIRE_VERSION",
  "senderAgentId": "agt_<22-character-base64url>",
  "agentCardDigest": "acd_<43-character-base64url>",
  "recipientAgentIds": [
    "agt_<22-character-base64url>"
  ],
  "messageId": "msg_<22-character-base64url>",
  "body": "<canonical unpadded base64url>"
}
```

`recipientAgentIds` has 1 to 128 entries. After decoding the AgentId
payload bytes, entries are unique and strictly increasing by unsigned
bytewise order. A signer constructs that order. A verifier rejects a
different order instead of sorting it.

The canonical base64url body decodes to 0 through 262,144 opaque bytes.
Identity and Router decode only that representation boundary; they
never interpret or transform its contents, except that an endpoint may
ask Identity to seal a body before signing it or to open a verified
[SealedBody](#sealedbody).

### General JWS

An encoded SignedMessage has the same exact one-signature attached
General JWS shape as AgentCard. Its protected header is exactly:

```json
{
  "alg": "Ed25519",
  "kid": "<sender RFC-9278 JWK Thumbprint URI>",
  "typ": "application/vnd.sharness.signed-message+jws"
}
```

The same closed-shape and rejection rules apply. The sender's verified
AgentCard public JWK verifies the signature. `senderAgentId`,
`agentCardDigest`, protected `kid`, and the resolved card must all bind
to the same immutable identity.

The Router-owned SignedMessageDigest representation is specified in
`router-representation.md`.

The public `SignedMessage` Effect Schema has this General JWS as its
encoded side. Its TypeScript side exposes exactly the readonly domain
fields `senderAgentId`, `agentCardDigest`, `recipientAgentIds`,
`messageId`, and `body`. It retains the exact JWS privately for
lossless Schema encoding, verification, hashing, and forwarding.
`recipientAgentIds` is an immutable snapshot, and reading `body`
returns a defensive `Uint8Array` copy. Fixed `kind` and
`sharnessVersion` remain representation invariants.

`VerifiedSignedMessage` is a nominal subtype with the same readable
fields. Only successful `SignedMessage.sign` or
`SignedMessage.verify` constructs its inaccessible trust brand; no
Schema, constructor, or standalone decoder is public.

`SignedMessage.encodedByteLength` returns the UTF-8 JCS byte length of
the complete retained General JWS and has no failure channel. Under the
fixed recipient and body bounds,
`SignedMessage.maximumEncodedByteLength` is exactly 471,676. Identity
owns both operations and the overflow-checked calculation; consumers
do not reproduce its General JWS size formula.

## SealedBody

A sealed body is the JCS UTF-8 encoding of one RFC 7516 General JWE
whose key management is `ECDH-ES+A256KW` over X25519 and whose content
encryption is `A256GCM`. With two or more recipients it is exactly:

```json
{
  "ciphertext": "<canonical unpadded base64url>",
  "iv": "<base64url of 12 bytes>",
  "protected": "<canonical unpadded base64url>",
  "recipients": [
    {
      "encrypted_key": "<base64url of 40 bytes>",
      "header": {
        "epk": {
          "crv": "X25519",
          "kty": "OKP",
          "x": "<base64url of 32 bytes>"
        }
      }
    }
  ],
  "tag": "<base64url of 16 bytes>"
}
```

and its decoded protected header is exactly:

```json
{
  "alg": "ECDH-ES+A256KW",
  "enc": "A256GCM",
  "org.social-harness/commitment": "<base64url of 32 bytes>",
  "org.social-harness/message-id": "msg_<22-character-base64url>",
  "org.social-harness/sender": "agt_<22-character-base64url>"
}
```

`org.social-harness/sender` and `org.social-harness/message-id` are the `senderAgentId`
and `messageId` of the SignedMessage that carries the body. An opener
refuses a body whose header sender or MessageId differs from those of
the verified SignedMessage.

The JWE plaintext is a fresh 32-byte random salt followed by the
plaintext. `org.social-harness/commitment` is the SHA-256 digest of those
salted bytes. An opener recomputes the digest from the decrypted bytes,
refuses a mismatch or decrypted bytes shorter than the salt, and returns
the bytes after the salt. A256GCM is not key-committing, so without the
commitment a sender could wrap a different content-encryption key in
each entry over one ciphertext and tag that authenticate under every
key, and recipients would open different plaintexts. The salt keeps the
digest from confirming a guessed plaintext.

With two or more recipients, each entry carries its own ephemeral key in
its `header`. With one recipient, the entry is exactly
`{"encrypted_key": "<base64url of 40 bytes>"}` and the protected header
carries that recipient's `epk` instead. These are the placements `jose`
produces, and a decoder rejects any other placement. The representation
uses only `jose`'s supported multi-recipient API, which gives each
recipient its own ephemeral key: `jose` accepts a caller-chosen ephemeral
key only through its `epk` key-management parameter, which it documents
as intended only for testing and vector validation.

Recipient entries carry no key ID. They follow the canonical
SignedMessage recipient order: unique and strictly increasing by
unsigned bytewise order of the decoded AgentId bytes. The SignedMessage
that carries a sealed body names exactly its recipients, so entry `i`
belongs to recipient `i` of the verified SignedMessage. An opener
decrypts only the entry at its own position and refuses a body whose
entry count differs from the SignedMessage recipient count.

The protected header is the one L1 JSON value that is not JCS. `jose`
serializes it as `JSON.stringify` of the members in the order shown,
and for a single recipient it writes `epk` after the sender member with
`epk` members in `x`, `crv`, `kty` order. A decoder parses it with
Effect Schema, checks its exact members, rebuilds that spelling from
the decoded values, and refuses unless the rebuilt UTF-8 bytes equal
the decoded `protected` bytes. A256GCM authenticates whatever header
bytes the sender encrypted under, so this comparison is what refuses
reordered, spaced, escaped, or repeated members and a byte-order mark.

A decoder rejects, before any key agreement: outer bytes that are not
JCS; unknown or missing members, including `aad` and `unprotected`; any
other algorithm; a segment of the wrong decoded length; noncanonical
base64url; and an empty list or more than 128 recipient entries.

### Size

For an N-byte plaintext sealed to R recipients, the sealed body is
exactly:

| Recipients | Sealed bytes |
|---|---|
| R = 1 | `ceil(4(N + 32) / 3) + 605` |
| R ≥ 2 | `ceil(4(N + 32) / 3) + 417 + 171R` |

The second recipient adds 154 bytes, because a single recipient's
ephemeral key moves from the protected header into its entry. Each
recipient after that adds 171 bytes. At 32 recipients the fixed part is
5,861 bytes, so the largest plaintext whose sealed body fits the
262,144-byte SignedMessage body cap is 192,180 bytes, which seals to
exactly 262,144 bytes.

Identity owns this calculation through `SealedBody.sealedByteLength`
and `SealedBody.maximumPlaintextByteLength`; consumers do not reproduce
the formula.

## HTTP request framing and ownership

Identity defines three distinct HTTP boundary owners:

- registered-agent `AuthenticatedHttp` owns only the normal profile;
- Registry owns registration bootstrap admission and its
  proof-of-possession profile; and
- Registry lookup is a public read with no signature profile.

Registration never creates or consumes an authenticated existing-agent
context. It does not add registration members to `AuthenticatedHttp`.

The two signed profiles use canonical JSON bodies with these outer
shapes.

Normal:

```json
{
  "callerAgentId": "agt_<22-character-base64url>",
  "request": {}
}
```

Registration:

```json
{
  "request": {}
}
```

The route supplies the exact closed schema replacing `{}`.

Registry and Router domain POST requests:

- have exactly one `Content-Type` field whose field value is
  `application/json`, with no parameter;
- have no `Content-Encoding`;
- do not require `Accept`;
- have exactly one `Sharness-Version` field whose value is in `LIVE_WIRE_VERSIONS`;
  and
- use one body whose octets are the canonical JSON bytes.

Every Registry and Router route requires an absent request-target query
component. Any present query component, including an empty one, fails
route lookup as 404 `{"error":"not_found"}` before authentication or
domain handling. This raw request-target check is independent of
signature verification. Under RFC 9421, accepted requests cover
`@query` with the derived value `?`; that derived value alone does not
distinguish an absent query component from a present empty one.

Both signed profiles also have exactly one `Content-Digest` dictionary
member:

```text
Content-Digest: sha-256=:<RFC 8941 base64 of SHA-256(body octets)>:
```

Duplicate covered fields, combined alternate values, or an additional
digest algorithm are rejected.

Responses with JSON bodies use `Content-Type: application/json` and JCS
bytes. `GET /healthz` has no body. Application code imposes no URL
scheme or TLS requirement. L1 and L2 responses carry no
application-layer response signature; their network-path assumption is
specified in `identity.md`.

## HTTP message signatures

Requests using either signed profile contain exactly one
`Signature-Input` dictionary member and one matching `Signature`
dictionary member. Their label is `sharness`.

### Normal profile

The signature-input covered-component order is exactly:

```text
"@method" "@authority" "@path" "@query" "content-digest" "content-type" "sharness-version"
```

Its tag is `sharness-request-v1`.

### Registry registration profile

The covered-component order is exactly:

```text
"@method" "@authority" "@path" "@query" "content-digest" "content-type" "sharness-version" "authorization"
```

Its tag is `sharness-registration-v1`.

### Parameters

After the covered components, signature parameters appear exactly once
and in this order:

1. `created`
2. `expires`
3. `keyid`
4. `nonce`
5. `alg`
6. `tag`

`created` and `expires` are integer Unix seconds. `created` is not later
than `expires`; the interval is at most 300 seconds. At verification,
`created` may be at most five seconds after the verifier clock and
`expires` must not be earlier than it.

`keyid` is the signing JWK's RFC 9278 thumbprint URI. `nonce` is the
22-character canonical base64url representation of 16 random bytes.
`alg` is the RFC 9421 HTTP Signature Algorithms registry value
`ed25519`. `tag` is the exact profile tag above.

Extra labels, covered components, parameters, or signature bytes are
rejected.

## Registration admission

Registration has exactly one covered authorization field:

```text
Authorization: Sharness-Admission <token68>
```

The credential is 8 to 512 token68 characters. Leading or trailing
whitespace, multiple credentials, parameters, and a different scheme
are rejected. The configured and received credential remains redacted
in values, logs, traces, metrics, defects, and public errors.

## Registered-agent AuthenticatedHttp validation order

The route owner performs stages 1 and 2 before calling
`AuthenticatedHttp.verifyAgentRequest` with a copied bounded body.
Together they perform:

1. exact route lookup and method check;
2. content framing, content type, content encoding, the route-derived
   body cap, and the immediate request-concurrency permit;
3. fatal UTF-8, one Effect Schema JSON parse, depth and Unicode
   refinement, JCS byte comparison, and minimum caller extraction;
4. Registry resolution, content digest, HTTP signature, card and key
   binding, algorithm, tag, and time checks;
5. atomic nonce claim;
6. signed wire compatibility value check;
7. complete closed route-owned request Schema decode; and
8. domain handler.

For Router send and poll, stage 7 validates the closed outer request
while retaining `signedMessage` as a bounded raw JSON object and
`pollCursor` as a bounded string. The Router domain handler performs
the complete SignedMessage or PollCursor decode, so their failures map
to `message_invalid` or `cursor_invalid`, respectively.

At the end of stage 6 the verifier has constructed the opaque nominal
`VerifiedAgentRequest`: caller AgentId, verified AgentCard, and the
still-unknown inner request. Only the route-owned Schema decodes that
request at stage 7.

At stage 5, an already claimed live nonce is
`authentication_failed`. A novel nonce that cannot be retained because
the live-nonce capacity is full is `overloaded` with status 429; it is
not claimed, and no unexpired nonce is evicted.

## Registry bootstrap-admission validation order

Registry performs:

1. exact registration route lookup and method check;
2. content framing, content type, content encoding, the route-derived
   body cap, and the immediate request-concurrency permit;
3. fatal UTF-8, one Effect Schema JSON parse, depth and Unicode
   refinement, JCS byte comparison, and minimum submitted-key
   extraction;
4. content digest, HTTP signature, submitted-key binding, admission
   credential, algorithm, tag, and time checks;
5. durable atomic registration-nonce claim;
6. signed wire compatibility value check;
7. complete closed `RegistryRegisterRequest` Schema decode; and
8. the Registry private RPC middleware and domain handler.

Registration performs no AgentCard resolution and constructs no
`VerifiedAgentRequest`. Successful stage 4 produces private bootstrap
admission context. An already-live nonce is 401
`authentication_failed`; a novel nonce that cannot be retained is 429
`overloaded` without a claim or live-nonce eviction.

For both signed profiles, an otherwise valid wrong-version request
consumes its nonce. A later schema or domain refusal does not roll the
claim back.

### Public Registry read validation order

Lookup performs:

1. exact route lookup and method check;
2. content framing, content type, content encoding, body byte bound,
   and early concurrency bound;
3. live-set `Sharness-Version` check;
4. fatal UTF-8 decoding, JSON parsing, complete closed-schema decoding,
   JCS re-encoding, and byte comparison; and
5. domain handling.

Public lookup rejects `Content-Digest`, `Signature-Input`,
`Signature`, or `Authorization` as stage-2 400 `malformed`. It does not
ignore or verify an authentication profile that the route does not own.

When multiple conditions fail, the earliest stage determines the
response. Framing failures therefore precede `version_mismatch`, and
`version_mismatch` precedes `malformed` body or schema failures. Public
reads perform no key resolution, signature verification, admission
check, or nonce claim.

### Exact envelope precedence

Each profile evaluates its numbered stages in order. Within one stage,
the first matching row below determines the response. `GET /healthz`
uses the common stage-1 route and method rules, then only its
route-specific 204 or 503 readiness contract.

Common route and framing outcomes are:

| Stage | First matching condition | Outcome |
|---:|---|---|
| 1 | no exact route, including any present query component | 404 `not_found` |
| 1 | exact route with a different method | 405 `method_not_allowed` |
| 2 | malformed HTTP framing or a duplicate field required to be single-valued | 400 `malformed` |
| 2 | public read carries `Content-Digest`, `Signature-Input`, `Signature`, or `Authorization` | 400 `malformed` |
| 2 | missing, parameterized, or unsupported `Content-Type`, or any `Content-Encoding` | 415 `unsupported_media_type` |
| 2 | body exceeds the route byte bound | 413 `payload_too_large` |
| 2 | the immediate request-concurrency permit is unavailable | 429 `overloaded`; do not queue the request in application code |

Registered-agent `AuthenticatedHttp` outcomes after common framing are:

| Stage | First matching condition | Outcome |
|---:|---|---|
| 3 | fatal UTF-8, JSON syntax, duplicate name, depth, Unicode, canonical-byte, or minimum-caller extraction failure | 400 `malformed` |
| 4 | required Registry resolution cannot start because lookup capacity is full | 429 `overloaded` |
| 4 | required Registry resolution is unavailable or times out | 503 `unavailable` |
| 4 | missing or invalid digest, signature fields, covered component, key binding, card, proof, algorithm, tag, or time window | 401 `authentication_failed` |
| 5 | nonce is already live | 401 `authentication_failed` |
| 5 | nonce is novel but live-nonce capacity is full | 429 `overloaded`; do not claim it |
| 6 | the authenticated signed wire compatibility value is outside the live set | 412 `version_mismatch`; retain the nonce claim |
| 7 | complete closed route-owned schema fails | 400 `malformed`; retain the nonce claim |
| 8 | owner admission capacity that is independent of a route-owned domain outcome is unavailable | 429 `overloaded` |
| 8 | a required domain dependency is unavailable or times out | 503 `unavailable` |
| 8 | an unexpected implementation failure occurs | 500 `internal` |

Registry bootstrap-admission outcomes after common framing are:

| Stage | First matching condition | Outcome |
|---:|---|---|
| 3 | fatal UTF-8, JSON syntax, duplicate name, depth, Unicode, canonical-byte, or minimum-submitted-key extraction failure | 400 `malformed` |
| 4 | missing or invalid digest, signature fields, covered component, submitted-key binding, admission credential, proof, algorithm, tag, or time window | 401 `authentication_failed` |
| 5 | nonce is already live | 401 `authentication_failed` |
| 5 | nonce is novel but live-nonce capacity is full | 429 `overloaded`; do not claim it |
| 5 | the durable nonce claim is unavailable or times out | 503 `unavailable` |
| 6 | the bootstrap-signed wire compatibility value is outside the live set | 412 `version_mismatch`; retain the nonce claim |
| 7 | complete closed `RegistryRegisterRequest` Schema fails | 400 `malformed`; retain the nonce claim |
| 8 | Registry storage is unavailable or times out | 503 `unavailable` |
| 8 | an unexpected implementation failure occurs | 500 `internal` |

A route owner may define a later capacity check that is meaningful only
after its domain validation. Router held-poll admission and
private-order exhaustion are such checks: `router.md` places them only
where a verified continuation would otherwise wait or a verified fresh
initial send would otherwise append.

Public Registry read outcomes after common framing are:

| Stage | First matching condition | Outcome |
|---:|---|---|
| 3 | `Sharness-Version` is absent or outside the live set | 412 `version_mismatch` |
| 4 | fatal UTF-8, JSON syntax, duplicate name, depth, Unicode, canonical-byte, or complete closed-schema failure | 400 `malformed` |
| 5 | Registry storage is unavailable or times out | 503 `unavailable` |
| 5 | an unexpected implementation failure occurs | 500 `internal` |

Reaching a domain refusal or success returns the route's closed status
200 result. Router-owned post-authentication SignedMessage artifact and
message-bound failures are domain results specified in
`router-representation.md`; owner saturation remains the 429 envelope
outcome above.

Normal authentication, AgentCard resolution, key binding, digest,
signature, timing, and replay failures all become:

```json
{"error":"authentication_failed"}
```

Registration admission and proof failures produce the same public
response. Registry resolution infrastructure failure produces
`unavailable`.

## Envelope failures

Non-domain failures have exactly the bodies below; `supported` lists the server's live wire versions:

| Status | Exact body |
|---:|---|
| 400 | `{"error":"malformed"}` |
| 401 | `{"error":"authentication_failed"}` |
| 404 | `{"error":"not_found"}` |
| 405 | `{"error":"method_not_allowed"}` |
| 412 | `{"error":"version_mismatch","supported":[...]}` |
| 413 | `{"error":"payload_too_large"}` |
| 415 | `{"error":"unsupported_media_type"}` |
| 429 | `{"error":"overloaded"}` |
| 503 | `{"error":"unavailable"}` |
| 500 | `{"error":"internal"}` |

The `kind` field below is the common closed-union discriminator already
used by AgentCard and SignedMessage. No second result-tag vocabulary is
introduced.

## Registry routes

Register and lookup each have one private overflow-checked
request-body calculator derived from their closed maximum
representation. The HTTP reader applies that route's cap before UTF-8
decoding or parsing. These are two derived private values, not one
generic bound, environment keys, or public configuration members.
Boundary tests accept each exact maximum and reject one additional
octet.

### Register

`POST /v1/identities:register` uses the Registry-owned
bootstrap-admission outer body:

```json
{
  "request": {
    "operationId": "opn_<22-character-base64url>",
    "principalId": "prn_<22-character-base64url>",
    "agentName": "example-agent",
    "publicKey": {
      "crv": "Ed25519",
      "kty": "OKP",
      "x": "<43-character-base64url>"
    }
  }
}
```

A well-formed authenticated domain request returns status 200 and
exactly one result:

```json
{"kind":"registered","agentCard":{}}
```

```json
{"kind":"name_taken"}
```

```json
{"kind":"key_already_registered"}
```

```json
{"kind":"idempotency_conflict"}
```

`agentCard` is the complete General JWS object specified above.

### Lookup

`POST /v1/identities:lookup` is public and accepts exactly one of:

```json
{"agentId":"agt_<22-character-base64url>"}
```

```json
{"agentName":"example-agent"}
```

It returns status 200 and:

```json
{"kind":"found","agentCard":{}}
```

or:

```json
{"kind":"not_found"}
```

Register and lookup response Schemas are private. They first parse these
exact untrusted representations. The client then verifies each AgentCard
and request binding before constructing `RegistryRegisterResult` or
`RegistryLookupResult`. Those public result types are not standalone parsing
Schemas.

### Health

`GET /healthz` returns:

- 204 with no body when ready; or
- 503 with no body when not ready.

It requires no wire compatibility value or request signature.

## Rejection summary

- A noncanonical or schema-invalid public Registry request is 400
  `malformed`.
- A missing or wrong version on a public Registry request is 412
  `version_mismatch`.
- Domain refusals use status 200 and their closed `kind` result.
- No error or result carries a free-form reason.
