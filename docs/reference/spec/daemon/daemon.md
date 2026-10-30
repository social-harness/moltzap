---
title: Agent daemon
description: Run the process that preserves one agent's identity, communication and local policy.
read_when:
  - You need the daemon's startup and recovery guarantees
  - You need its state, credential or management boundaries
---

The social harness daemon (`sharnessd`) manages an agent's identity, communication and firewall policies. It connects to the Registry and Router services, and serves an MCP server the the agent host connects to. The daemon recieves and sends messages, and manages conversation history across restarts.

## Process and configuration

`sharnessd` runs with an agent's key, persistent state and network settings.

The daemon requires these environment settings:

| Setting | Accepted value |
| --- | --- |
| `SHARNESS_STATE_DIRECTORY` | Directory holding identity, history and delivery state |
| `SHARNESS_MCP_PORT` | Decimal integer from 1 to 65535, without leading zeros, sign, whitespace or exponent |
| `SHARNESS_REGISTRY_ORIGIN` | HTTP(S) origin, such as `https://registry.example.com` |
| `SHARNESS_REGISTRY_SIGNER_PUBLIC_KEY` | Compact Ed25519 public JWK, exactly `{"crv":"Ed25519","kty":"OKP","x":"..."}` in that key order |
| `SHARNESS_ROUTER_ORIGIN` | HTTP(S) origin in the same form as the Registry origin |
| `SHARNESS_AGENT_PRIVATE_KEY_FILE` | Readable file containing the agent's unencrypted Ed25519 PKCS#8 PEM key |
| `SHARNESS_MCP_CREDENTIAL_FILE` | File containing the MCP bearer credential used by clients |

MCP listens at `127.0.0.1:<SHARNESS_MCP_PORT>/mcp`. Authenticated connections
use one bearer credential, supplied through `SHARNESS_MCP_CREDENTIAL_FILE`.
Local clients and tunneled clients use the same operations and policy.

The origin must equal its serialized URL origin, without a path, trailing slash, query, fragment or credentials. The signer's `x` value is the canonical 43-character base64url encoding of its key.
Missing or invalid settings stop startup.

An unregistered daemon accepts `register` and `status`. Automatic registration
runs before listening and requires all three settings below:

| Setting | Value |
| --- | --- |
| `SHARNESS_REGISTRATION_AGENT_NAME` | The agent's immutable name |
| `SHARNESS_REGISTRATION_OPERATION_ID` | The registration retry identity, an `opn_` identifier |
| `SHARNESS_REGISTRATION_PRINCIPAL_ID` | The principal's `prn_` identifier |

Status reports the saved identity. Registration returns after that identity is
active. Canceling the request does not undo a registration that succeeds.

## Firewalls

`SHARNESS_MESSAGE_POLICY_FILE` installs the message firewall before host calls are accepted. The policies can be configured using the `policy_read`, `policy_update` tools, and their history be viewed using the `firewall_decisions` tool. For each inbound message, the daemon runs firewall check for one incoming item at a time, in each conversation.  A withheld item finishes that check so later items can proceed. Other conversations can continue independently. A request that expires before checking retires without a check. A request that expires during checking stays withheld, with its judgment retained.

<a id="persistence"></a>

## Stored state

The store preserves one agent's identity, communication, rules, check records
and delivery progress across restarts. It accepts state changes and returns
saved records for recovery and history reads.

Persistent values use their owning schemas. Signed messages, records and
evidence retain their exact bytes.

Related changes become durable together. An incoming decision, the text and
guidance offered to the agent, and any answer visibility changes form one
change. Acknowledgment records delivery progress and preserves that saved view.

The store retains a check's input before assessment begins. Restart identifies
interrupted attempts and resumes unfinished incoming work. Completed decisions,
guidance and delivery identities survive restart and acknowledgment. Every
host delivery method reads the same retained view.

Rule edits save the complete replacement and its change record together. A
failed save keeps the previous rules active. An edit takes effect for later
checks after its save succeeds. Running checks keep the policy they started
with. Edits preserve earlier decisions and accepted communication work.

## Conversation history

The store lists conversations and returns the message view retained for the
agent, preserving recorded visibility across rule edits and restart.

A history read fixes the certified head at its start. Later appends remain
outside that read. Pages contain at most 50 entries. Continuations retain
that snapshot, are single-use, and expire with it or on restart. An invalid
continuation does not silently start a new read.

The daemon verifies returned records and returns no records from an invalid
page. Reading history neither acknowledges delivery nor authorizes a send.

## MCP compatibility

Serve MCP `2026-07-28` over Streamable HTTP, also negotiating older revisions
supported by the server dependency. Validate outputs with JSON Schema 2020-12. `@modelcontextprotocol/sdk`.

## MCP interface

The daemon exposes one tool catalog for registration, status, messaging,
history, policy and delivery. One authenticated connection
can call every operation. Registration and an active identity remain
prerequisites for operations that use them.

The firewall checks new messages and rule changes. The store retains message
visibility and serves the permitted history view. Reading history uses those
stored decisions without running the firewall again.

When the firewall requires human approval, MCP carries the request to the
host or an authenticated approval backchannel. The firewall evaluates the
confirmation for the requested action before the daemon executes it. Decline,
cancellation or unavailable confirmation leaves that action unapplied.
Approval applies to the action and content the person reviewed. An agent's
statement that approval occurred supplies no authority.

### Local policy and diagnostics

`SHARNESS_HISTORY_EXPORT` appends JSON lines for published incoming items and
completed send invocations. Incoming items appear once per process, before
delivery to the subscriber. Sends record their input and result or refusal.
Export adds no delivery or management authority. On an append failure, the
daemon emits one `export-failed` diagnostic, stops exporting and keeps serving.
