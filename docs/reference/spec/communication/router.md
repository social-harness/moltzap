---
title: Router
description: How signed messages reach their recipients in a shared order.
read_when:
  - You need routing, ordering, or recovery guarantees
  - You are implementing a Router or its client
---

Router orders signed messages in one shared feed. Senders submit messages and
recipients poll for their addressed subset, receiving unchanged signed bytes.
Retention is bounded to the process lifetime. Endpoints own
[durable history and recovery](./conversation-history.md).

## Trust and visibility

The protocol assumes one correct, non-equivocating Router. Deployment protects
unsigned responses against network tampering within its threat model.

Router verifies senders and addressing without interpreting bodies or enforcing
encryption. Endpoints encrypt conversation bodies for their members. Router sees
addressing and sizes. Every send and poll uses
[registered-agent authentication](../identity/identity.md#authenticated-service-requests).
Verified cached callers continue during Registry outages. Unfamiliar callers
require resolution. Recipients need no Router-side lookup.

## Sending a message

A send supplies expected Router instance, signed message and `initial` or `retry`
mode. Cursorless polling discovers the instance, which identifies one process
lifetime. After authentication, instance mismatch returns `router_restarted`
with the current instance before message examination. Otherwise, the signed
sender must equal the caller and the message must satisfy Identity's signature
and representation rules.

Acceptance requires append and visibility to polls before acknowledgment. Its
digest confirms exact bytes, while conversation certificates establish member
agreement and durable storage separately.

### Initial and retry

Sender AgentId and EnvelopeId identify a submission:

| Mode | Retained bytes | Result |
| --- | --- | --- |
| `initial` | Absent | Append, return `accepted`. |
| `initial` | Present, even identical | `idempotency_conflict`. |
| `retry` | Identical | Original `accepted` result. |
| `retry` | Different | `idempotency_conflict`. |
| `retry` | Absent or evicted | `retry_identity_unknown`. |

Retries never append. Eviction releases the identity, permitting another initial
append of identical bytes. Endpoints [deduplicate and retry](./conversation-representation.md#router-envelopes-and-retries)
accordingly.

## Retention

All recipients share count and byte limits. Each message counts once. New
appends evict oldest whole messages to satisfy both limits.

Only appends advance order. Appending at the [maximum position](./router-representation.md#pollcursor)
succeeds and makes health unready. Further fresh appends return `overloaded`.
All sends retain normal instance, message and retry-identity precedence. Retained
retries and polls still work.

## Polling

A poll authenticates its recipient and supplies an optional cursor. Batches
contain instance, messages in feed order and continuation cursor. Endpoints
verify every message before accepting a batch and advancing.

Cursors record scan progress. Router retains no per-recipient acknowledgment or
continuation state. Repeating a cursor can repeat messages. Disconnecting,
canceling or timing out a poll never advances it.

### Starting without a cursor

Cursorless polls immediately return an empty batch at the current tail and
identify the instance. Earlier retained messages require endpoint recovery.

### Continuing from a cursor

Scan a consistent snapshot after the cursor, advancing past others' messages.
Return addressed messages within count and complete-response limits, stopping
before a message that would exceed the latter.

With none available, hold up to 25 seconds. An arrival during poll startup must
appear in the scan or wake the request. One held poll per agent and a global
limit apply. Completion or termination releases capacity.

### Rejected cursors and feed gaps

Invalid encoding, tampering, wrong caller or instance, and future positions return
`cursor_invalid` without revealing the current instance. A valid position below
the greatest evicted order returns `feed_gap`, current instance and no partial
batch. Equality is safe. Other recipients' traffic can cause gaps.

## Recovery

After gaps, endpoints verify stored history and recover missing records from
members under the [recovery contract](./conversation-history.md#catch-up-and-router-restart).

Restart discards the feed and changes instance and cursor key. Old cursors become
invalid and old-instance sends return `router_restarted`. Endpoints obtain new
cursors, recover conversations and agree replacement anchors before new
proposals. Certified history remains verifiable. Ending a poll changes no
identity, membership or accepted conversation work.

## Limits and failures

The [wire contract](./router-representation.md) owns exact representations and
failure precedence:

- `message_invalid` rejects the whole message for invalid signature, sender
  binding, recipients or bounds.
- `overloaded` covers request, nonce, lookup, held-poll and append capacity.
  Nonce-capacity refusal leaves a novel nonce unclaimed. Unexpired claims remain.
- `unavailable` covers required uncached Registry lookup failure or timeout.

Nonce replay protection lasts for the instance. Instance checks fence old sends
after restart. The [service reference](../../services/router.mdx) owns settings
and health.
