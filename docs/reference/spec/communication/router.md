---
title: Router
description: How signed messages reach their recipients in a shared order.
read_when:
  - You need routing, ordering, or recovery guarantees
  - You are implementing a Router or its client
---

Router assigns signed messages one shared order and lets each recipient read
the messages addressed to it. A sender submits a message. Recipients poll for
their part of the feed. Router returns the signed bytes unchanged.

Retention is bounded and lasts only for the current Router process. Endpoints
own [durable conversation history](./conversation-history.md), including
recovery when they miss messages or the Router restarts.

## Trust and visibility

The protocol assumes one correct Router that gives recipients a consistent
order. A malicious Router that presents conflicting histories violates that
assumption. Deployment must protect unsigned Router responses against any
network-path tampering included in its threat model.

Router verifies each sender and the signed addressing. It leaves the body
uninterpreted. Endpoints encrypt conversation traffic for its members, so
Router sees addressing and sizes while recipients can read the content.
Router does not enforce that encryption.

Every send and poll authenticates one registered agent using the
[service request contract](../identity/identity.md#authenticated-service-requests).
Router resolves the caller's card when it has no verified cached copy.
A known caller can continue during a Registry outage. An unfamiliar caller
must wait for Registry resolution. Recipients need no Router-side lookup.

## Sending a message

A send supplies the expected Router instance, a signed message and either
`initial` or `retry` mode. An instance identifies one Router process lifetime.
The endpoint learns it by polling without a cursor.

After authenticating the request, Router checks the expected instance. A
mismatch returns `router_restarted` with the current instance before examining
the message. Otherwise, the signed sender must match the authenticated caller,
and the message must satisfy Identity's signature and representation rules.

Router accepts a new message only when it can append it to the feed. It
acknowledges after the message is visible to polls. The returned digest confirms
the exact bytes accepted. Conversation certificates provide the separate
evidence of member agreement and durable storage.

### Initial and retry

Router identifies a submission by its sender AgentId and EnvelopeId. The mode
determines how an already retained submission is handled:

| Mode | Retained submission | Result |
| --- | --- | --- |
| `initial` | Absent | Append the message and return `accepted`. |
| `initial` | Present, including identical bytes | Return `idempotency_conflict`. |
| `retry` | Present with identical bytes | Return the original `accepted` result. |
| `retry` | Present with different bytes | Return `idempotency_conflict`. |
| `retry` | Absent or evicted | Return `retry_identity_unknown`. |

A retry never appends a message. Eviction releases the submission identity,
so a later initial send can append the same bytes again. A recipient may
therefore see duplicate messages. Endpoints follow the
[envelope retry rules](./conversation-representation.md#router-envelopes-and-retries)
and deduplicate protocol evidence.

## Retention

All recipients share one feed and its count and byte limits. A message counts
once regardless of its recipient count. Accepting new messages evicts the
oldest entries as needed to remain within both limits.

The order advances only when Router appends a message. Its maximum position
is fixed by the [cursor format](./router-representation.md#pollcursor).
Appending at that final position succeeds, then makes health unready.
Further new appends return `overloaded`. Retained retries and polls still
work. Instance, message and retry-identity checks keep their normal precedence.

## Polling

A poll authenticates its recipient and supplies an optional opaque cursor.
A successful batch contains the current instance, messages in feed order,
and a cursor for continuation. The endpoint verifies every message before
accepting the batch and advancing its cursor.

The cursor records where scanning stopped. Router keeps no per-recipient
acknowledgment or continuation state. Retrying a cursor can repeat a batch.
Disconnecting, cancelling or timing out a request does not advance it.

### Starting without a cursor

A poll without a cursor immediately returns an empty batch and a cursor at
the current tail. It establishes where future polling begins and identifies
the Router instance. Retained messages before that point require endpoint
history recovery.

### Continuing from a cursor

Router scans after the cursor through a consistent snapshot of the feed.
It advances past messages for other recipients and returns addressed
messages in order, up to the configured count and response-size limits.
It stops before a message that would exceed the response limit so the next
poll can retrieve it.

If no addressed message is available, Router holds the request for up to
25 seconds. A message arriving as polling starts must either appear in the
scan or wake the held request. Only one held poll per agent is allowed, also
subject to the process-wide limit. The request releases its capacity when
it completes or ends.

### Rejected cursors and feed gaps

An invalid cursor returns `cursor_invalid` without revealing the current
Router instance. This includes tampering, a cursor for another caller or
instance, a future position, or invalid encoding.

A valid cursor returns `feed_gap` when its position precedes the most recently
evicted entry. Equality is safe. The response contains the current instance
and no partial batch. Traffic for other recipients can cause this gap because
retention is shared.

## Recovery

After a feed gap, an endpoint verifies its stored history and asks conversation
members for missing records. It resumes from a verified head under the
[conversation recovery rules](./conversation-history.md#catch-up-and-router-restart).

Restart discards the Router feed and changes its instance and cursor key.
Old cursors become invalid, and old-instance sends return `router_restarted`.
Endpoints obtain a new cursor, recover their conversations, and agree on
replacement anchors before sending new proposals. Already certified history
remains verifiable.

Each request stands alone. Closing a long poll changes no agent identity,
membership or accepted conversation work.

## Limits and failures

The [wire contract](./router-representation.md) owns exact routes, fields,
encodings, body limits and failure precedence. Router returns:

- `message_invalid` for an invalid signed message, including its sender
  binding, signature, recipients or size.
- `overloaded` when request, nonce, lookup, held-poll or append capacity is
  unavailable. A nonce refused for capacity is not consumed.
- `unavailable` when a required uncached Registry lookup fails or times out.

Invalid messages are rejected as a whole. Retention eviction affects whole
messages, and capacity pressure never evicts an unexpired accepted nonce.
Nonce replay protection lasts for the Router instance. Instance checks fence
old sends after restart.

The [Router service reference](../../services/router.mdx) lists settings and
health behavior. The generated [API reference](../../../guides/contributing.mdx#documentation)
describes client failures and caller options.
