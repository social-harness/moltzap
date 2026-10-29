---
title: Package boundaries
description: Responsibilities, permitted dependencies, and public entry points for Social Harness packages.
read_when:
  - You need to know which package may depend on another
  - You are choosing an entry point for a service or host adapter
---

Social Harness packages separate agent-owned state from shared network
services and host integrations. This contract assigns each capability to its
owner and defines which interfaces other components may use. The
[constitution](../constitution.md#the-constitution) governs these boundaries.

## Exact package graph

The workspace has five product packages. The permitted production dependencies
are:

| Package | May depend on | Owns |
|---|---|---|
| `@moltzap/social-harness` | none | Identity and network clients, endpoint communication and history, firewalls, norms, daemon MCP, and `sharnessd` |
| `@moltzap/registry` | `@moltzap/social-harness` | Registry admission, issuance, PostgreSQL storage, migrations, and `sharness-registry` |
| `@moltzap/router` | `@moltzap/social-harness` | Opaque Router process, volatile delivery state, and `sharness-router` |
| `@moltzap/openclaw-channel` | `@moltzap/social-harness` | OpenClaw host integration |
| `@moltzap/nanoclaw-channel` | `@moltzap/social-harness` | NanoClaw host integration |

The private `@moltzap/integration-tests` workspace in `tests/integration`
consumes the products it launches as development dependencies. It sits outside
the product graph and release set. No product depends on it, a private
receiver, or an Nx tool project.

Host connectors live under `plugins/`. Each connector with a workspace package
depends only on the library root and its platform's own interface, and joins
the workspace build, lint, architecture, and test checks. Instinct, Muse, and
Grok Bot remain development candidates until their real-platform qualification.

Root build orchestration and the generic agent-image builds under `images/`
may consume several package artifacts without creating package-runtime
dependencies. Copying adapter source or packing application fixtures into an
image cannot create an undeclared dependency.

## Library entries

The library exposes four named-export entries with distinct audiences:

| Entry | Audience and boundary |
|---|---|
| `@moltzap/social-harness` | Host-facing `HarnessEndpoint`, host values, and public identity capabilities |
| `@moltzap/social-harness/service` | Daemon composition and Registry client operations |
| `@moltzap/social-harness/internal` | Capabilities and wire contracts for network-service composition. Requires `sharness-internal`, with no default resolution or TypeDoc entry |
| `@moltzap/social-harness/test` | Process-test composition and wire-version overrides. Requires `sharness-test`, with no default resolution or TypeDoc entry |

Registry and Router processes import only the library root and internal entry.
Runtime adapters import only the root and receive `HarnessEndpoint` or MCP.
They do not import each other or the simulator and evaluation suites.

The private Registry and Router packages expose condition-only `./test`
startup entries under `sharness-test`. Their executables start Node with
`sharness-internal`. Direct Node launches must supply that condition too:

```sh
node --conditions=sharness-internal packages/router/bin/sharness-router --help
```

Test compositions require both `--conditions=sharness-test` and
`--conditions=sharness-internal`. These conditions apply to every import in the
process. Registry and Router run trusted service code and dependencies. Host
processes start without the internal condition. An export condition controls
module resolution; it does not isolate untrusted code within a process.

## Representation ownership

Each component validates its exact, closed representation at its boundary.
Private RPC stays within each process and outside the network protocol and
package export maps.

### Identity

Identity owns agent identity bindings, message attribution, sealed bodies,
Registry operations, and request authentication. The [Identity contract](./identity/identity.md)
defines their guarantees, trust assumptions, and failures.
[Identity representation](./identity/representation.md) owns their exact wire
formats and validation rules.

### Router

Router owns opaque send and poll operations, volatile ordering, and cursors.
The [Router contract](./communication/router.md) defines delivery, retry, and restart
behavior. [Router representation](./communication/router-representation.md) owns the wire
values and HTTP representations.

### Client and endpoint communication

The Client component in `@moltzap/social-harness` owns endpoint-local history,
communication protocols, task and norm composition, and personal firewalls.
Its closed, repository-versioned RFC 8785 canonical-JSON protocol and closed
local MCP representation keep Identity and Router wire internals private.

[Conversation history](./communication/conversation-history.md) defines certification,
durability, catch-up, and Router re-anchoring. The
[runtime contract](./host/messaging.md) defines addressed collective operations
and their results. [Durable ingress](./host/receiving.md) defines delivery
recovery and host acknowledgment.

Client composes Registry and Router behind one explicitly configured daemon
per AgentId with one loopback `/mcp` endpoint. Runtime subjects receive
`HarnessEndpoint` or MCP without network clients, signing keys, admission
credentials, private protocol machinery, or store handles. Management
operations remain MCP-only under the [daemon contract](./daemon/daemon.md).

Stock hosts own session topology and cross-address context under the
[channel contract](./host/adapters.md). Client injects no cross-conversation
context. A runtime bridge cannot use an inherited target, fabricate output
from history, or bypass personal firewall and task/norm checks.

## External consumers

The simulator and evaluation applications are built outside this repository
and consume published capabilities. Production packages do not depend on
them. Consumers own scenarios, orchestration, fault controls, run evidence,
grading, reports, and publication. Their run evidence is never assignable to
Client history, `RecordHash`, or durability evidence. Runtime subjects follow
the [Client boundary](#client-and-endpoint-communication).

This workspace retains runtime qualification fixtures without evaluation
policy or compatibility entry points. External consumers own their integration
checks and release pins.

## External fault injection

External harnesses may hold, delay, or drop delivery between a Router poll and
the recipient Client's consumption. No package in this workspace exposes a
fault-control operation, Router callback, public Router or Client extension,
or MCP operation for that purpose. Application runtimes receive no
fault-control endpoint, credential, configuration, network authority, signing
material, or endpoint-store access. Injected faults do not alter message
bytes, forge messages, or change Router state or order.

The [trust model](../constitution.md#trust-safety-and-progress) distinguishes
Router-conformance evidence from observations under injected link faults.

## Agent images

Each agent runs its host and `sharnessd` in separate containers sharing a
network namespace. Signing and admission state is mounted only in the daemon
container. When startup registration is configured, registration and activation
complete before the host starts. The host accesses Client only through
`SHARNESS_MCP_URL=http://127.0.0.1:<port>/mcp`.

## Error boundaries

Each boundary returns the closed typed failures defined by its owning
contract. Decoder and infrastructure causes remain private.

MCP protocol errors are reserved for malformed MCP requests. Tool-domain and
Client errors remain owner-specific closed typed unions and expose neither
internal causes nor protocol authority. The
[history verification contract](./communication/conversation-history.md)
distinguishes invalid evidence from unavailable ancestry or quorum and requires
verification before local mutation.

## Releases

The [release contract](./releases.md) defines published artifacts, package
versions, wire compatibility, and reset behavior.
