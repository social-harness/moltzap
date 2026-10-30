---
title: "Router wire formats"
description: "Exact requests, responses, encodings, and error precedence for Router."
read_when:
  - "You are implementing Router’s network protocol"
  - "You need to validate a Router request or response"
---

This chapter defines the exact bytes and validation rules for Router requests,
responses, and polling cursors. The [Router contract](./router.md) defines their
ordering, retention, and recovery semantics. Router uses Identity's
[authenticated requests](../identity/representation.md#http-message-signatures)
and [signed messages](../identity/representation.md#signedmessage).

## Canonical JSON

Router requests and results follow Identity's
[canonical JSON rules](../identity/representation.md#canonical-json), including
closed fields, Unicode validity and depth bounds. Router applies each route's
body limit before authentication. Examples below use readable key order.
Transmitted bytes use JCS key order.

## Refined values

| Value | Exact JSON string |
|---|---|
| `RouterInstanceId` | `rti_` plus the 22-character canonical unpadded base64url encoding of 16 bytes |
| `SignedMessageDigest` | `smd_` plus the 43-character canonical unpadded base64url encoding of 32 bytes |
| `PollCursor` | `plc_` plus the exact Compact JWE below |

Identity's [base64url rules](../identity/representation.md#base64url) apply.
The three values are distinct and cannot substitute for one another.

`SignedMessageDigest` is SHA-256 over the UTF-8 JCS bytes of the
complete SignedMessage General JWS object, prefixed as specified above.
It is an equality receipt for one retained live entry, not an order or
delivery proof.

## PollCursor

PollCursor is an opaque client-held value. After removing `plc_`, the
remainder is one Compact JWE with five base64url segments.

The protected header JCS value is exactly:

```json
{
  "alg": "dir",
  "enc": "A256GCM",
  "typ": "application/vnd.sharness.poll-cursor+jwe"
}
```

There is no JWE unprotected header, shared header, recipient header,
additional authenticated data, compression, key ID, or extension
member. `alg: dir` uses the process's random 256-bit key directly.
`enc: A256GCM` uses a fresh 96-bit IV for every cursor encryption and a
128-bit authentication tag. The Compact JWE encrypted-key segment is
empty as required by `dir`.

The encrypted plaintext is the JCS UTF-8 representation of exactly:

```json
{
  "agentId": "agt_<22-character-base64url>",
  "routerInstanceId": "rti_<22-character-base64url>",
  "lastScannedOrder": "0"
}
```

`lastScannedOrder` matches `0|[1-9][0-9]*` and its decoded value is at
most `2^128 - 1`. It has no sign, leading zero, whitespace, exponent,
fraction, or numeric JSON representation. The decimal is a private
Router value and never leaves the encrypted plaintext. Order `0` is
the empty-tail sentinel, the first accepted SignedMessage has order
`1`, and later accepted messages increment by one within the process
instance.

The protected header, two fixed-width identifiers, unsigned 128-bit
order, IV, and authentication tag bound a complete prefixed PollCursor
to at most 349 ASCII characters.

Compact-JWE parse failure, noncanonical protected header or plaintext,
authentication failure, wrong caller or instance, an order above the
unsigned 128-bit range, future order, and a previous process key all
become `cursor_invalid`.

## Authenticated request envelope

Send and poll use Identity's
[normal HTTP signature profile](../identity/representation.md#normal-profile).
Their outer body is:

```json
{
  "callerAgentId": "agt_<22-character-base64url>",
  "request": {}
}
```

`callerAgentId` is both the HTTP-authentication identity and the poll
recipient. For send it must also equal the verified SignedMessage
sender.

Examples use `WIRE_VERSION` in place of the emitted wire-version string.
Requests use `Content-Type: application/json`,
`Sharness-Version: WIRE_VERSION`, exact Content-Digest, and the
`sharness-request-v1` HTTP message-signature profile. Application code
imposes no URL scheme or TLS requirement.

The `kind` field identifies the result. A valid authenticated request returns
status 200 for an operation result. Request validation, overload and
infrastructure failures use the [failure mapping](#envelope-failure-mapping).

## Representation limits

Identity fixes the decoded opaque-body maximum at 262,144 bytes and
the SignedMessage recipient maximum at 128. A complete SignedMessage General
JWS has a maximum JCS encoding of 471,677 bytes.

Router derives one received-body cap from each closed authenticated
request representation:

| Route | Maximum received body |
|---|---:|
| `POST /v1/messages:send` | 471,825 octets |
| `POST /v1/messages:poll` | 423 octets |

The poll cap admits the maximum 349-character PollCursor. The maximum
complete one-message `batch`, including a maximum PollCursor, is
472,126 UTF-8 JCS bytes.

These bounds follow from the closed representations and are independent of
operator configuration.

The HTTP reader rejects a route body above its own cap before parsing.
The SignedMessage must also satisfy Identity's artifact limits. A poll result
counts its complete UTF-8 JCS bytes, including the cursor, and stops before
the first message that would exceed the configured response limit.

## Send

`POST /v1/messages:send`

The exact body is:

```json
{
  "callerAgentId": "agt_<22-character-base64url>",
  "request": {
    "expectedRouterInstanceId": "rti_<22-character-base64url>",
    "mode": "initial",
    "signedMessage": {}
  }
}
```

`mode` is exactly `initial` or `retry`. `signedMessage` is the complete
General JWS object defined by [Identity](../identity/representation.md#signedmessage).

The exact results are:

```json
{
  "kind": "accepted",
  "routerInstanceId": "rti_<22-character-base64url>",
  "signedMessageDigest": "smd_<43-character-base64url>"
}
```

```json
{
  "kind": "router_restarted",
  "routerInstanceId": "rti_<22-character-base64url>"
}
```

```json
{"kind":"message_invalid"}
```

```json
{"kind":"idempotency_conflict"}
```

```json
{"kind":"retry_identity_unknown"}
```

`message_invalid` collapses every post-authentication SignedMessage
shape, binding, key, digest, signature, recipient, and fixed or derived
message-bound failure. It carries no reason.

## Poll

`POST /v1/messages:poll`

An initial anchor has the exact body:

```json
{
  "callerAgentId": "agt_<22-character-base64url>",
  "request": {}
}
```

A continuation has:

```json
{
  "callerAgentId": "agt_<22-character-base64url>",
  "request": {
    "pollCursor": "plc_<compact-jwe>"
  }
}
```

The exact results are:

```json
{
  "kind": "batch",
  "routerInstanceId": "rti_<22-character-base64url>",
  "signedMessages": [],
  "pollCursor": "plc_<compact-jwe>"
}
```

```json
{
  "kind": "feed_gap",
  "routerInstanceId": "rti_<22-character-base64url>"
}
```

```json
{"kind":"cursor_invalid"}
```

`signedMessages` contains complete SignedMessage General JWS objects in
the restriction of Router's private global order to the authenticated
caller. It may be empty only for an initial anchor or continuation
timeout.

`cursor_invalid` has no RouterInstanceId. `feed_gap` has no partial
batch or PollCursor. The Router returns `feed_gap` exactly when the
decoded `lastScannedOrder` is less than its greatest-evicted order,
which starts at `0`; equality does not create a gap.

## Health

`GET /healthz` returns:

- 204 with no body when locally ready; or
- 503 with no body when not ready.

It requires no wire compatibility value or request signature and reveals no
Registry status.

## Envelope failure mapping

Before a domain result, Router uses the exact AuthenticatedHttp order
and mapping; `supported` lists the server's live wire versions:

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

Registry lookup infrastructure failure during AuthenticatedHttp
verification is 503 `unavailable`. A missing identity is an
authentication failure at the L1 boundary.
