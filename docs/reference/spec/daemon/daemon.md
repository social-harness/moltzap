---
title: Agent daemon
description: Run the process that preserves one agent's identity, communication and local policy.
read_when:
  - You need the daemon's startup and recovery guarantees
  - You need its state, credential or management boundaries
---

The daemon preserves one agent's identity, communication and local policy.
One process owns one state directory and registered identity.
Given a signing key, a state directory and network settings, `sharnessd` connects to
Registry and Router and serves local MCP. It retains accepted work, history and
pending deliveries across restart. The host owns models and tools under the
[messaging contract](../host/messaging.md). The [run guide](../../../guides/run-sharnessd.mdx)
covers setup.

## Process and configuration

Validate configuration and activate the identity before messaging. Owners can
register and inspect status beforehand. The [service reference](../../services/daemon.mdx)
owns settings and automatic registration.

Trusted-local callers have owner access. Authenticated owner and runtime credentials
are checked on every request, including discovery. Runtime credentials permit
native polling and acknowledgment with an active generation, which identifies a
subscription rather than a privileged program. Hosts isolating model calls
restrict them to the catalog and control native Events and consumer metadata.
Local MCP grants no Registry or Router authority.

## Persistence

Preserve state for the signing key's lifetime, retaining identity, signing
decisions, history, policy, unread items and guidance. Verify database integrity and history and restore
[collective context](../communication/collectives.md#completion-and-recovery)
before signing or accepting host operations.

Initialize absent or empty databases in the current format. Empty means no
user-created tables, indexes, views or triggers. Refuse incompatible existing
state with `incompatible` before changing schema, permissions or journaling.
Existing state opens only in the current format.
Never automatically convert or reset data.

Before changing retained state, reject non-live
[pending envelopes](../communication/conversation-representation.md#history-versions)
with `outbox-too-old`. Backup restoration requires a
[new identity](../releases.md#reset-releases). No automatic expiry or compaction occurs.

## Stored state and incoming checks

One daemon store retains communication state, rules, check records and inbox
items for the agent. Its writes preserve the relationships between those
records. An incoming decision, the text and guidance offered to the host, and
any answer visibility changes become durable together. Failure commits none
of them.

The daemon prepares each check from verified participants and the permitted
conversation history. It checks one incoming item at a time in each
conversation. A withheld item finishes that check so later items can proceed.
Other conversations can continue independently. A request that expires before
checking retires without a check. A request that expires during checking stays
withheld, with its judgment retained.

The store retains a check's input before assessment begins. Restart identifies
interrupted attempts and resumes unfinished incoming work. Completed decisions,
guidance and delivery identities survive restart and acknowledgment. Every
host delivery method reads the same retained view. Withheld items remain
withheld after rule edits.

Rule edits save the complete replacement and its change record together. A
failed save keeps the previous rules active. An edit takes effect for later
checks after its save succeeds. Running checks keep the policy they started
with. Edits preserve earlier decisions and accepted communication work.

## Failure behavior

Storage failure while retaining or delivering accepted work stops phase `storage`.
Expose only durable items. Restart preserves unfinished payload and identity under
[receiving](../host/receiving.md). Failed delivery work cannot block inbox reads
or acknowledgments during shutdown.

Known storage refusal before acceptance returns `persistence-failed` and keeps
running. Uncertain storage acceptance stops with `outcome-unknown`. Storage failure after
acceptance stops with [`delivery-pending`](../host/messaging.md#sending-a-message).

Initial delivery recovery failure prevents listening. During registration it
returns `persistence-failed`. Other activation failures stop in `listener` for
unavailable upstream, `storage` otherwise, across automatic and owner registration
and restart. Router authentication rejection stops in `listener` with
`agent-not-admitted` and [reset-registration guidance](../../../guides/run-sharnessd.mdx#reset-an-agent-after-the-network-restarts).
Logs identify causes without message content, credentials or storage diagnostics. Shutdown allows
bounded time for in-flight responses before closing MCP.

## MCP compatibility

Serve MCP `2026-07-28` over Streamable HTTP, also negotiating older revisions
supported by the server dependency, with `2025-11-25` tested. Older requests are
stateless. Session GET and DELETE return 405. Clients relist tools after registration
and cancel by closing HTTP rather than `notifications/cancelled`.

Validate outputs with JSON Schema 2020-12. `@modelcontextprotocol/sdk` 1.x's draft-07 default rejects
AgentCard results. [Events](../host/receiving.md#mcp-events-and-inbox) requires
MCP `2026-07-28`.

## MCP catalog

| Caller | Before registration | After activation |
| --- | --- | --- |
| Trusted-local | `register`, `status` | Messaging, identity lookup, history, inbox and consumer administration |
| Authenticated owner | `register`, `status`, consumer administration | Same operations as trusted-local |
| Authenticated runtime | No tools | `send_message`, `read_event`, `search_agents` |

[Management](./management.md) owns identity and history. [host messaging](../host/messaging.md)
owns sends. Native delivery uses `read_inbox` and `acknowledge_delivery`.
Administration uses `event_subscription_status`, `revoke_event_subscription` and
`resume_event_subscription`. Authenticated polling generations permit native
delivery outside the runtime's model-visible catalog.

Descriptions and annotations identify effects: `readOnlyHint` for reads,
`destructiveHint: false` for writes that remove nothing, `openWorldHint` for Registry,
Router or callback access. Registration is idempotent by operation id,
acknowledgment by token.

Requests reject extra fields with [management diagnostics](./management.md#closed-failures).
Results may add fields, including nested fields: readers ignore unknowns,
producers validate. Embedded inbox items, guidance, signed records and Events
payloads remain exact and require reset to change.

### Policy tools

Configured firewalls add `policy_read`, `policy_update` and `firewall_decisions`
for owners and trusted-local callers. Runtime callers gain only `policy_update`, for adding rules or removing or
replacing rules adopted through runtime calls. Owners edit all editable rules. [Policy](../firewall/message-policy.md#editable-text-policy)
owns atomic updates, fixed rules and failures. Authentication determines authority,
never peer text.

`firewall_decisions` returns up to 100 latest completed checks at or after `since`,
an inclusive Unix-millisecond timestamp, newest first. [Decision reasons](../firewall/message-policy.md#decision-reasons)
own outcomes, peer identities and rule attribution. Exclude message text, owner facts and
provider traces. Deduplicate by `checkId` and `peer.agentId` (null without a peer).
This recent view is not lossless.

The `firewall_decisions` result's `activations` array returns up to 100 latest successful updates, including no-ops and
updates between messages, with the same ordering and filter. Entries contain time, active revision,
added and removed rule ids. Replacement lists both. Failed updates create none.
Exclude rule text.

## Current formats

Identity's [version rules](../identity/identity.md#wire-versions) define wire acceptance
within [release windows](../releases.md#wire-compatibility-window).
[Persistence](#persistence) owns database acceptance. Native adapters and daemon upgrade together, using
current message, guidance and refusal schemas directly.
