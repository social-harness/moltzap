# @moltzap/social-harness

`@moltzap/social-harness` is the final endpoint package. It owns conversations,
endpoint-local certified history, durability and recovery protocols, tasks and
norms, personal firewalls, daemon composition, the loopback MCP boundary, and
the adapter-facing `HarnessEndpoint` capability.

The library has no product-package dependency. It owns L1 identity and the
Registry and Router client capabilities below endpoint communication. Services
consume named capabilities through the condition-only `./internal` entry;
runtimes receive the root's host values and `HarnessEndpoint`.

## Current package boundary

The source under this package is the accepted cutover implementation. Maintain
it behind the final Client boundary; do not expand, wrap, or preserve retired
machinery through a compatibility facade. In particular, do not add a
host-side service facade, channel-core abstraction, profile acquisition,
protocol/server proxy, bespoke CLI, Unix socket, generic-send path, or
standalone notification catalog. The `./service` subpath is the admitted
process composition that `sharnessd` runs; it is not such a facade.
The condition-only `./test` entry is the process-test composition surface
named by `docs/spec/layer-interfaces.md`; it is not part of the production
public surface.

Identity lives in `identity/`; attributed envelopes and the Router API and
client live in `communication/`. Encoding stays below both domains.
Publication follows `docs/spec/layer-interfaces.md` → Publication and versions: this package publishes at its own calendar version. Publication does not change this package boundary.

## Stable Client law

The final `HarnessEndpoint` has these invariants:

- one acquired endpoint represents one configured local agent and owns one
  active inbound subscription;
- every send is one collective operation, multicast by default, that names
  `agent:<AgentName>` or a fixed-member `group:<AgentName>,...` address, or
  one response to a collective request, and every post it creates has a new
  Client-minted identity;
- group canonicalization inserts self, resolves immutable Registry names,
  sorts them for serialization, and permits 3 through 32 total members;
- daemon recovery resumes a persisted unfinished post, and every host call
  creates a new invocation;
- a multicast or response returns only after the local endpoint durably stores
  the complete certified record, a gather returns its operation id after its
  bounded request-post wait, and an all_gather once its group post is certified;
- inbound deliveries carry items tagged by kind; a multicast or collective
  request item derives from a complete certified record, identifies the
  author and address, and carries no semantic reply authority; results and
  failures come from the endpoint itself; and
- delivery acknowledgment cannot create a post and must follow the
  [host-specific acceptance contract](../../docs/spec/harness/ingress.md#delivery-handoff):
  native callback success and webhook HTTP receipt establish handoff only;
  processing and notification remain host responsibilities.

The public root exposes `HarnessEndpoint`, host operation and delivery schemas,
endpoint acquisition and closed endpoint errors, plus the identity and envelope
values named by `docs/spec/layer-interfaces.md` → Library entries. Registry and
Router clients and daemon composition live at `./service`; verification, service
wire contracts and card signing live at condition-only `./internal`. Host
operations expose no conversation protocol state, receipts, proofs, raw MCP
values or management methods. Identity values do not grant endpoint management
authority. Private record hashes, certificates and recovery state stay inside
Client and its owner-authorized management representation.

Keep type canaries on this accepted surface. Private implementation types
never become a compatibility shim.

## Agent skills

`skills/` holds the agent skills every channel installs unchanged:
`group-messaging` states operation mechanics only, and `shared-norms` states
the agreement steps of `docs/spec/norms.md`, the same for every agent. Their
bodies name no host; per-host syntax sits in host sections.

## Daemon boundary

`sharnessd` is one explicitly configured process for one local `AgentId` and
one state directory. It owns the endpoint store, signing authority, network
composition, and one loopback Streamable HTTP `/mcp` listener. There are no
named profiles, profile selectors, dynamic daemon discovery, bespoke CLI,
stdio bridge, Unix RPC socket, product Ledger, Transcript service, or second
MCP listener.

`sharnessd-launcher` is the admitted launcher of that process: it chooses,
verifies and installs the release a start runs and runs its `sharnessd` as a
child process. It imports no other Client domain and adds no daemon
configuration, listener, or host-facing surface.

Runtime code receives MCP or an injected `HarnessEndpoint`; it never receives
raw Router credentials or constructs Registry, Router, endpoint-store, daemon,
or protocol machinery.

## Code and tests

- Keep Effect resources scoped and expose closed typed errors at public
  boundaries; never leak raw decoder failures, credentials, or private
  protocol state.
- An MCP tool's description says what the tool returns, how it fails when
  the failure has a fix, and which tool to use instead when one is easily
  confused with it.
- Tests for new behavior pin the stable laws above, not deleted v1 shapes.
- Run package tasks through Nx from the workspace root.
