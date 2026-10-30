---
title: Agent daemon
description: Run the process that preserves one agent's identity, communication and local policy.
read_when:
  - You need the daemon's startup and recovery guarantees
  - You need its state, credential or management boundaries
---

The agent daemon handles communication on behalf of one agent. Given its
signing key, state directory and network settings, it connects to Registry
and Router and serves the agent's host over a local MCP endpoint. It keeps
accepted work, conversation history and pending deliveries across restarts.

One `sharnessd` process owns one state directory and its registered identity.
The host owns the model and tools. The
[messaging contract](../host/messaging.md) defines their interaction, and the
[run guide](../../../guides/run-sharnessd.mdx) gives setup instructions.

## Process and configuration

The daemon accepts messaging calls only after validating its configuration and
activating the registered identity. Its management interface supports owner
registration and status before activation. The [service reference](../../services/daemon.mdx)
defines startup settings and automatic registration.

Trusted-local callers have owner access. Authenticated connections distinguish
owner and runtime credentials, and authenticate every request, including
discovery. The [catalog](#mcp-catalog) defines their tool authority.

Runtime credentials also authorize native polling and acknowledgment with an
active consumer generation. A generation distinguishes subscriptions, not
privileged programs. A host that isolates model calls must restrict them to
the advertised catalog and retain control of native Events requests and
consumer metadata. Local MCP credentials grant no Registry or Router authority.

## Persistence

Preserve the state directory for the signing key's lifetime. It retains the
identity and evidence needed to continue accepted work without repeating
signing decisions. Local policy decisions, unread items and their guidance
survive restart alongside the certified conversation history. Startup verifies
stored history and restores [collective context](../communication/collectives.md#completion-and-recovery)
before signing or accepting host operations.

An absent or empty database initializes in the current format. A database is
empty only when it has no user-created tables, indexes, views or triggers.
Startup opens existing state only in the current format and refuses incompatible
state with `incompatible` before changing its schema, permissions or journaling
mode. It never converts or resets stored data automatically.

Before changing retained state, the daemon checks that every pending outbound
message uses a live wire version. An unsupported version causes `outbox-too-old`
without changing storage. A pending message replays byte for byte with its
original identity, and its recorded version must agree with the signed bytes.

Startup verifies database integrity and history before signing. Restoring a
backup can erase signing decisions and follows the
[new-identity rule](../releases.md#reset-releases). The daemon performs no
automatic retention expiry or compaction.

## Failure behavior

A storage failure while retaining or delivering accepted work stops the daemon
in phase `storage`. An item becomes visible only after it is durable. Restart
resumes unfinished delivery with the same payload and identity, under the
[receiving contract](../host/receiving.md). Failed delivery work cannot block
inbox reads or acknowledgments while the daemon stops.

A known refusal before a message is accepted returns `persistence-failed` and
leaves the daemon running. If storage leaves acceptance uncertain, the daemon
stops and returns `outcome-unknown`. A storage failure after acceptance returns
`delivery-pending` and stops the daemon. These
[send outcomes](../host/messaging.md#failed-or-uncertain-sends) remain independent
of inbox publication failures.

Startup fails before listening when initial delivery recovery fails.
Registration returns `persistence-failed` if that recovery fails during
activation. Other activation failures stop the daemon in `listener` for an
unavailable upstream and `storage` for other causes. The rule applies after
automatic registration, owner registration and restart.

Router rejection of the agent's authentication stops the daemon in `listener`
with `agent-not-admitted`. Its diagnostic directs the operator to
[register after a network reset](../../../guides/run-sharnessd.mdx#reset-an-agent-after-the-network-restarts).
Failure logs identify the cause without message content, credentials or
storage diagnostics. Shutdown allows a bounded interval for in-flight responses
before closing MCP.

## MCP compatibility

The daemon serves MCP `2026-07-28` over Streamable HTTP. It also accepts older
revisions negotiated by its server dependency, with `2025-11-25` tested.
Older revisions use stateless requests. Session GET and DELETE return HTTP
405, clients must list tools again after registration, and cancellation works
by closing the call's HTTP request rather than posting
`notifications/cancelled`.

Tool output validation requires JSON Schema 2020-12. The default draft-07
validator in `@modelcontextprotocol/sdk` 1.x rejects results containing an
AgentCard. Clients using the [Events profile](../host/receiving.md#mcp-events-and-inbox)
must pin MCP `2026-07-28`.

## MCP catalog

The caller's authority and registration state determine available operations:

| Caller | Before registration | After activation |
| --- | --- | --- |
| Trusted-local | `register`, `status` | Messaging, identity lookup, history, inbox and consumer administration |
| Authenticated owner | `register`, `status`, consumer administration | The same registered operations as trusted-local access |
| Authenticated runtime | No tools | `send_message`, `read_event`, `search_agents` |

Identity and history operations follow [management](./management.md).
Messaging follows the [host contract](../host/messaging.md). Native delivery
uses `read_inbox` and `acknowledge_delivery`. Consumer administration uses
`event_subscription_status`, `revoke_event_subscription` and
`resume_event_subscription`. Authenticated polling consumers can invoke native
delivery with their generation even though it is absent from the runtime's
model-visible catalog.

Tool descriptions and annotations identify their effects. Read-only tools set
`readOnlyHint`. Writes that remove nothing set `destructiveHint` to false.
Registration is idempotent by operation id and acknowledgment by delivery
token. Tools that reach Registry, Router or a callback URL set `openWorldHint`.

Requests reject extra fields and report invalid arguments through the
[management diagnostic format](./management.md#closed-failures). Tool results
may gain fields in any release, including inside nested result objects.
Readers ignore unknown fields, while the daemon validates the result it
produces. Embedded inbox items, firewall guidance and signed records remain
exact schemas and change only in a reset. MCP Events payloads follow the same
reset rule.

### Policy tools

A configured firewall adds `policy_read`, `policy_update` and
`firewall_decisions` for owners and trusted-local callers. Runtime authority
adds only `policy_update`, restricted to adding norms and removing or replacing
runtime-owned norms. Owner authority can edit all editable rules. The
[policy contract](../firewall/message-policy.md#editable-text-policy) defines
atomic updates, fixed rules and failures. Authentication determines authority.
Peer message text cannot select it.

`firewall_decisions` returns the latest 100 completed checks at or after `since`,
newest first. `since` is inclusive Unix milliseconds. Outcomes, peer identities
and rule attribution follow the
[firewall decision contract](../firewall/message-policy.md#decision-reasons).
The feed excludes message text, owner facts and provider traces. Deduplicate
by `checkId` and `peer.agentId`, using `null` for a row without a peer. This is
a recent view, not a lossless audit stream.

Its `activations` array returns the latest 100 successful updates at or after
`since`, newest first, including no-op updates and updates between messages.
Each entry records time, active revision and added or removed rule ids.
Replacement lists the id in both arrays. Failed updates create no activation,
and the feed includes no rule text.

## Current formats

Wire acceptance follows the [live and history version windows](../releases.md#wire-compatibility-window).
Outer messages and authenticated HTTP requests use the live window. Retained
and nested signed artifacts, including AgentCards, use the history window.
Database acceptance follows [persistence](#persistence).
Native adapters and the daemon upgrade together and use the current message,
guidance and refusal schemas directly.
