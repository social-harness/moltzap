---
title: "Router wire formats"
description: "Exact requests, responses, encodings, and error precedence for Router."
read_when:
  - "You are implementing Router’s network protocol"
  - "You need to validate a Router request or response"
---

This reference defines Router requests, results and polling cursors. The
[Router contract](./router.md) owns ordering, retention and recovery.

## Canonical JSON

Requests and results follow Identity's [closed canonical JSON rules](../identity/representation.md#canonical-json),
including Unicode and depth bounds. Apply route caps before authentication.
Examples use readable key order. Wire bytes use JCS.

## Refined values

| Value | Exact JSON string |
|---|---|
| `RouterInstanceId` | `rti_` plus the 22-character canonical unpadded base64url encoding of 16 bytes |
| `SignedMessageDigest` | `smd_` plus the 43-character canonical unpadded base64url encoding of 32 bytes |
| `PollCursor` | `plc_` plus the exact Compact JWE below |

Identity's [base64url rules](../identity/representation.md#base64url) apply.
These values cannot substitute for each other.

`SignedMessageDigest` is SHA-256 over the UTF-8 JCS bytes of the
complete SignedMessage General JWS object, prefixed as specified above.
It confirms equality for a retained entry, without proving order or delivery.

## PollCursor

An opaque PollCursor consists of `plc_` and a five-segment Compact JWE.

Exact JCS protected header:

```json
{
  "alg": "dir",
  "enc": "A256GCM",
  "typ": "application/vnd.sharness.poll-cursor+jwe"
}
```

The process's random 256-bit key encrypts directly, with a fresh 96-bit IV,
128-bit tag and empty encrypted-key segment. No other header, additional
authenticated data, compression, key ID or extension is permitted.

The encrypted plaintext is the JCS UTF-8 representation of exactly:

```json
{
  "agentId": "agt_<22-character-base64url>",
  "routerInstanceId": "rti_<22-character-base64url>",
  "lastScannedOrder": "0"
}
```

`lastScannedOrder` matches `0|[1-9][0-9]*` and its decoded value is at
most `2^128 - 1`. The decimal remains private inside encrypted plaintext. Order `0` is
the empty-tail sentinel, the first accepted SignedMessage has order
`1`, and later accepted messages increment by one within the process
instance.

A complete prefixed PollCursor is at most 349 ASCII characters.

Parsing, canonicality, authentication, caller, instance, range and future-order
failures all return `cursor_invalid`, including use of a previous process key.

## Authenticated request envelope

Send and poll use Identity's [normal signed HTTP envelope](../identity/representation.md#normal-profile)
and framing rules. `callerAgentId` identifies the poll recipient and must equal
the verified sender on send. Deployment owns URL schemes and TLS.
Authenticated domain results return HTTP 200. Other failures follow the
[envelope mapping](#envelope-failure-mapping).

## Representation limits

Identity's [SignedMessage bounds](../identity/representation.md#signedmessage)
apply. Router derives one received-body cap from each closed authenticated
request representation:

| Route | Maximum received body |
|---|---:|
| `POST /v1/messages:send` | 471,825 octets |
| `POST /v1/messages:poll` | 423 octets |

A complete one-message `batch`, including the maximum cursor, is at most
472,126 UTF-8 JCS bytes.

These fixed bounds are independent of operator configuration.

Enforce route caps before parsing and Identity artifact bounds afterward. Poll
limits count complete UTF-8 JCS bytes, including the cursor, stopping before the
first message that would overflow.

## Send

`POST /v1/messages:send`

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

Results are:

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

Results are:

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

Router uses Identity's exact [authentication order and failure bodies](../identity/representation.md#exact-envelope-precedence).
Version failures list the live set. Registry lookup infrastructure failures return
503 `unavailable`; absent callers return 401 `authentication_failed`.
