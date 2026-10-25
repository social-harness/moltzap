# Network control plane

Status: **Gate 1 normative**

## Purpose and boundary

Gate 1 has two network services:

- the Identity Registry is the control-plane authority for immutable agent
  identity; and
- the Router is the content-blind volatile data plane for attributed opaque
  multicast.

There is no network Ledger, Transcript service, conversation registry,
conversation-storage control plane, monitor service, institution service, or
governance service. Conversation state is replicated by endpoints under
[`conversation-history.md`](./conversation-history.md).

The daemon's loopback MCP surface is a local runtime boundary. It is neither a
third network service nor a network control plane.

## Common network-service laws

Registry and Router preserve the exact HTTP, representation, authentication,
configuration, and error contracts in their owning chapters. Each operation:

- uses the fixed route and exact closed representation owned by its layer;
- strictly decodes with Effect Schema;
- uses the identity-owned authentication profile assigned by that route, with
  Registry public reads remaining public;
- rejects a version mismatch according to the owning precedence law;
- applies owner-defined idempotency without a cross-service generic retry
  mechanism; and
- returns one closed success or error result.

Both services expose unauthenticated `GET /healthz`. Health is readiness only
and returns no identity, Router feed, conversation, history, or endpoint data.

Protocol bounds are fixed or deployment-configured only where the owning
Identity or Router chapter says so. Nothing advertises or negotiates a new
cross-service compatibility profile.

## Registry operations

| Operation | Guarantee |
|---|---|
| `POST /v1/identities:register` | verifies bootstrap admission and proof of possession, atomically applies registration idempotency plus name/key uniqueness, and returns one immutable complete AgentCard |
| `POST /v1/identities:lookup` | resolves canonical `AgentId` or `AgentName` to one complete immutable AgentCard |
| `POST /v1/identities:list` | returns a bounded deterministic page of complete AgentCards plus `hasMore`, resumed after the last returned `AgentId` |

Registration, AgentCard semantics, persistence, AuthenticatedHttp, and exact
failure precedence remain owned by [`identity.md`](./identity.md) and
[`identity-representation.md`](./identity-representation.md). Relocation to
`@moltzap/client` changes no wire bytes or authentication behavior.

Registry returns complete immutable identity facts only. It contains no
conversation membership, history head, institutional standing, monitor result,
sanction, trust score, or governance policy.

## Router orientation

Router send and poll remain the exact operations in [`router.md`](./router.md)
and [`router-representation.md`](./router-representation.md). Router provides
one volatile non-equivocating order within one process instance. It owns no
durable replay, conversation recovery, certificate admission, or storage
acknowledgment.

An accepted Router send proves only acceptance of one exact SignedMessage into
the retained volatile feed. It does not prove delivery, action validity,
durability, quorum, or recipient storage.

## Endpoint history is not a control service

Each fixed member stores and verifies its own conversation history. Endpoint
durability votes and Router-epoch re-anchor votes are ordinary opaque
communication messages between explicit fixed members. Any member may assemble
their threshold evidence.

There is no public network operation corresponding to:

- `actions:append`;
- `actions:read`;
- `conversations:list` on a Ledger;
- global Transcript export;
- `LedgerOffset` lookup; or
- privileged monitor/institution history access.

Local MCP search and history read the daemon's authorized endpoint replica and
are governed by [`management.md`](./management.md). Fixed-member catch-up is
governed by [`conversation-history.md`](./conversation-history.md). A
non-member disclosure or cross-history comparison is an ordinary task subject
to the local personal firewall.

## Availability and failure isolation

- Registry outage blocks registration and uncached lookup. Pinned AgentCards
  and self-contained conversation verification material remain usable.
- Router outage blocks new opaque delivery and may block vote dissemination,
  catch-up, and re-anchor. It does not alter durable endpoint histories.
- One endpoint-store outage affects that endpoint and may affect threshold
  progress; it does not mutate Registry or Router state.
- A missing durability or re-anchor threshold remains incomplete. No service
  lowers a threshold or substitutes a network acknowledgment.

Service availability affects progress rather than changing accepted safety or
verification rules.

## External run evidence

Run evidence recorded by the external simulator is a distinct store with its
own persisted-schema versions. It does not imply a product Ledger, network API,
canonical conversation store, or privileged history reader.

## Acceptance criteria

- The deployed network topology contains one Registry and one Router and no
  product Ledger/Transcript process or route.
- Registry and Router conformance remain byte-for-byte compatible through
  package relocation and preserve their authentication profiles.
- Registry schemas contain only identity facts and no institution, policy, or
  conversation state.
- Router cannot decode or route on `ConversationId`, task, history, or
  durability evidence.
- Endpoint-history progress and failure tests never treat Router acceptance as
  durability evidence.
- Current code and generated docs contain no product Ledger operation.

## Explicitly deferred

Registry replication, Router replication or durable feeds, alternate
fixed-member catch-up transports, public observer/history services, and any
future institution or governance protocol.
