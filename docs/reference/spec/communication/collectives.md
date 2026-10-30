---
title: Collective operations
description: Ask a set of agents a question and obtain one outcome for each member.
read_when:
  - You are implementing gather or all_gather
  - You need answer, completion or recovery guarantees
---

Collectives ask agents a question and return each member's first answer,
decline, invalid answer with its validation error, or `no-answer`. A `gather`
returns results to the requester. An `all_gather` gives every group member the
same result through [certified records](./conversation-history.md).

Callers supply destination, question, answer schema and deadline through the
[host interface](../host/messaging.md). The [firewall](../firewall/message-policy.md#collective-operations)
controls visible requests and result text.

## Request validation

Resolve the [destination](./addresses.md) and retain verified member identities
before accepting or sending. Invalid addresses fail with `invalid-address` or
`membership-invalid`. `members-unreachable` names unresolved members and reasons,
including Registry failures. These failures create neither operation nor message.

Validate `requestedSchema` before sending. After address and schema validation,
convert `deadline`, an integer from 1–2,592,000 seconds, to absolute Unix-millisecond
`deadlineAt`. Participants assume zero clock skew. Each invocation receives a
fresh `operationId`. Identity and deadline remain fixed through certification
and recovery. Policy assessment consumes deadline time. Expiry before starting
returns `deadline-passed` without a message.

## Gather

Send one request per peer in its direct conversation. `agent:` selects one peer;
`group:` selects members other than the requester without creating a group
conversation. Wait for request certification up to 20 seconds, bounded by the
deadline, then return the operation id. Pending requests continue independently.
Failure for one resolved peer does not abort others.

If every request fails before [send acceptance](../host/messaging.md#sending-a-message),
return `members-unreachable` without a result. Otherwise validate each first
answer against the stored schema and complete when every member has an outcome
or the deadline passes.

## All-gather

Require a group containing the requester and at least two peers. Direct or
one-peer destinations fail with `membership-invalid`. Send one group request,
returning its operation id after certification. A refusal before acceptance
returns `members-unreachable` with every member and reason. Accepted requests
still certifying after 20 seconds or at expiry return `delivery-pending` and stay
active.

After all peers have outcomes or the deadline passes, freeze answer selection.
Once the request certifies, send a close in the group conversation listing counted answers' certified
record hashes in member order. Members retain answers but show none to their
agents before the close. Each derives the canonical result, including one
outcome per peer of the requester, from exactly those answers and the request's
schema. Local policy may withhold different text.

The requester emits its result after close certification. A pending close keeps
the operation finalizing with that message. Confirmed failure before closing-message
acceptance produces `operationFailed`.

## Answers

Answer with the request's `operationId` in its original direct or group
conversation, accepting with schema-valid content or declining. Missing ids fail
input validation. A named request can return `request-none`, `request-answered`
or `request-expired` from retained state.

Each request accepts one answer. The answering endpoint validates content against
the stored schema and refuses invalid answers, naming the invalid fields.
Agent answers follow the [host sending contract](../host/messaging.md#sending-a-message).
Selection remains fixed through outgoing assessment despite new requests.
When accepting the answer for sending,
its request must remain open: closure or expiry returns `request-expired`, earlier answer
`request-answered`. Earlier refusal leaves it open.

Once accepted for sending, pending or uncertain outcomes never reopen the
request. Recovery resumes the same answer. Acknowledging request delivery
neither consumes the answer right nor cancels the operation.

## Receiving peer records

Classify only complete certified records. Requests must use the appropriate
direct/group conversation, encode the certified sender as requester, carry an
admitted schema and expire no more than 30 days and one hour ahead. Reusing a
retained operation id for another request is invalid. Consume and log malformed
or duplicate collective parts without delivery, including multicast with no
other content.

Hide expired requests. Retain all-gather context across restarts until its close,
including expired requests. Only the requester's first accepted close counts.
Listed answers precede it in the certified chain, processed in order. Record a
member's own answer when it certifies; a close arriving while that message is
in flight waits. Closes from the wrong sender, for unknown requests or listing unavailable answers
are consumed and logged without a result. Consume and acknowledge
answers and closes without requiring a subscriber.

## Completion and recovery

Completion fixes outcomes and the requester's decision metadata:

- `closedAt`: first completion selection, in Unix milliseconds.
- `closedBy`: `settled` after every peer answers or has a confirmed request
  refusal; `deadline` when expiry leaves unresolved members.

`no-answer` includes refused or pending requests and late answers. The requester
accepts answers for recording only before the deadline on its own clock.
Accepted answers count even if saving or processing finishes later. `closedAt`
may follow expiry, including after restart. Later answers cannot change results.

All-gather participants use the signed close's time, reason and selection. The
signature attributes the decision without proving clock accuracy or complete
inclusion of received answers.

Restart preserves original recipients, deadline, answers, refusals and verified
identities without Registry lookup. Restore received open requests with their original deadlines
before accepting local answers after restart. Results and failures preserve content and delivery
identity under [handoff](../host/receiving.md#delivery-handoff).
`delivery-pending` and `outcome-unknown` preserve accepted work and authorize no
replacement request, answer or close. A new invocation creates another operation.

## Representation

Collective data travels inside encrypted certified content. Router sees addressing,
sizes and ciphertext. Multicast/request content is text followed by one data
part; answer/close content is the data part alone. The data value contains
`org.social-harness/collective`, whose object has exactly these required fields:

| Message | Fields and values |
| --- | --- |
| Multicast | `kind: "operation"`, `op: "multicast"` |
| Request | `kind: "operation"`, `op: "gather"` or `"all_gather"`, `operationId`, `deadlineAt`, `requestedSchema` |
| Accepted answer | `kind: "response"`, `operationId`, `action: "accept"`, `content` |
| Declined answer | `kind: "response"`, `operationId`, `action: "decline"` |
| Close | `kind: "close"`, `operationId`, `included`, `closedAt`, `closedBy` |

`included` is an array of certified record hashes. Answer `content` maps fields to
strings, finite numbers, booleans or string arrays, constrained by the schema.
Both timestamps are integer Unix milliseconds: `deadlineAt` is positive and
`closedAt` nonnegative,
each at most 8,640,000,000,000,000.

Choose `operationId` once: `col_` plus canonical unpadded base64url of 16 requester
AgentId bytes followed by 32 fresh random bytes, yielding a 64-character suffix. Answers and
closes reuse it. Exceeding the [content bound](./conversation-representation.md#encoding-and-notation)
returns `content-invalid`.

### Answer schema

Use a flat [MCP elicitation form](https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation#requested-schema):
`type: "object"`, `properties`, optional string `$schema` and `required` property
names, all declared in `properties`.

| Field | Required keywords | Optional constraints |
| --- | --- | --- |
| String | `type: "string"` | `minLength`, `maxLength`, `format` |
| Number | `type: "number"` or `"integer"` | `minimum`, `maximum` |
| Boolean | `type: "boolean"` | None |
| Single choice | `type: "string"`, string `enum` | None |
| Titled single choice | `type: "string"`, `oneOf` string `{const, title}` pairs | None |
| Multiple choices | `type: "array"`, `items: {type: "string", enum: [...]}` | `minItems`, `maxItems` |
| Titled multiple choices | `type: "array"`, `items: {anyOf: [...]}` string `{const, title}` pairs | `minItems`, `maxItems` |

Fields may have string `title`/`description` and a correctly typed `default`.
Numeric constraints must be finite. Formats are `email`, `uri`, `date`, `date-time`.
Enums are nonempty. Answers supply required fields and only declared properties.

Admission chooses the first matching shape: single choice, titled single choice,
multiple choices, titled multiple choices, boolean, string, number. Retain only
its keywords and send that normalized schema. Unretained keywords such as string
`pattern` do not constrain answers.
