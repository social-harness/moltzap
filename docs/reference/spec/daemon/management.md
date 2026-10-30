---
title: Daemon management and MCP access
description: Register an agent, look up identities and inspect certified conversation history.
read_when:
  - You need to register or inspect your agent
  - You are checking which authority a daemon tool requires
---

The daemon's MCP interface registers an agent, looks up identities and reads
conversation history. The firewall governs the information returned and any
action requiring human approval.

## Registration state

An unregistered daemon accepts `register` and `status`. Operations that need
an active identity report `not-registered` until activation.

Status exposes identity once retained. Registration returns after activation,
which enables tools even after caller cancellation. Clients subscribed through
`subscriptions/listen` with `notifications.toolsListChanged` receive
`notifications/tools/list_changed`. [Older clients](./daemon.md#mcp-compatibility)
relist tools.

`registered`, `active` and `found` include encoded `agentCard` and required verified
`agent` with id, name and principal. Activated `search_agents` selects exact `agentId` or
`agentName`, returning `{kind: "not_found"}` for absence. Firewall identity rules
use the returned id.

## Conversation search and history

Search and history reads are disclosures to the agent. The firewall checks
what the query would reveal before returning records. A disclosure requiring
human approval waits for that confirmation through the same MCP interaction.

Use [canonical addresses](../communication/addresses.md). `search_conversations`
returns up to 50 distinct local addresses in unsigned UTF-8 order, strictly after
optional `afterAddress`, whether or not it exists. Omission starts first.
`hasMore` exactly indicates another address and requires a nonempty page.

`read_conversation` starts with address and optional `afterRecordHash` (strictly
after that record), otherwise FIRST_MESSAGE. The current certified head fixes
the snapshot, excluding later appends. Pages contain at most 50 consecutive
records and a continuation that is null at the snapshot's end.

Continue with only the continuation. Tokens are single-use, replaced per page,
and expire with snapshot or restart. Reused, expired, malformed or foreign tokens
return `invalid-continuation` without implicitly starting again. Tokens encode 32
random bytes as 43 canonical unpadded base64url characters.

Records include verified `author` from membership, author id in the signed
record, canonical core and hash, Router anchor, action signatures and durability
votes under [history](../communication/conversation-history.md#retained-evidence).
Evidence names distinct signers sorted by decoded AgentId bytes. Later verification
requires first-message membership, obtained by reading from the beginning.
The daemon verifies every record. Any invalid page returns `persistence-failed`
without records. Reading creates neither host delivery nor send authority.

## Closed failures

Reject missing required fields and extra request fields. Results follow the
[additive contract](./daemon.md#mcp-interface). Invalid arguments return InvalidParams (`-32602`) with up
to 20 `data.issues` with `path` of property names or array indices and message describing expected input. Empty
path means the whole request. Describe selected forms and accepted grammar,
without submitted values or decoder internals. Error text repeats `path: message`
diagnostics separated by semicolons. Send validation retains `content-invalid`.
Validate operation and principal identifiers before Registry, naming malformed fields.

Expected failures use InternalError (`-32603`) with exactly `data: {reason}`:

| Operation | Failure reasons |
| --- | --- |
| `register` | `admission-refused`, `dependency-unavailable`, `persistence-failed`, `incompatible-daemon` |
| `status` | `incompatible-daemon` |
| `search_agents` | `not-registered`, `dependency-unavailable`, `incompatible-daemon` |
| `search_conversations` | `not-registered`, `invalid-address`, `persistence-failed` |
| `read_conversation` | `not-registered`, `invalid-address`, `unknown-agent`, `invalid-continuation`, `history-gap`, `persistence-failed` |

`invalid-address` includes noncanonical spelling. `unknown-agent` means Registry
cannot resolve an address member. `history-gap` means a missing certified first message or ancestry or a starting record outside that history. Expose only permitted
reasons and validation details, keeping content, credentials, keys, unverified
evidence and storage diagnostics private.
