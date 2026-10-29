---
title: Interface specifications
description: Find the contract that owns each layer's responsibilities and guarantees.
read_when:
  - You need the specification that owns a behavior or boundary
  - You are changing an interface and need its governing contract
---

These specifications define Social Harness's intended behavior, public
boundaries, and observable failures. The
[constitution](../constitution.md#the-constitution) sets the governing
principles. Read the [architecture](../../concepts/architecture.mdx) for
an explanation of how the parts work together.

The folders follow the responsibilities in the Social Harness stack:
`identity/` establishes who participates, `communication/` carries messages
and retains shared history, `firewall/` applies local policy, and `norms/`
defines rules participants follow together. The institution contract describes
how applications can use those guarantees. `daemon/` owns the process that
runs the stack, and `host/` owns its connection to the program running the
agent's model and tools.

Each requirement belongs to one specification. The constitution sets the
constraints on those requirements. Generated TypeDoc describes callable
symbols; it does not replace the manual contracts. Proposed behavior is
marked where it appears.

Choose the contract that owns the question you need to answer:

| Question | Specification |
| --- | --- |
| Who sent a message, and how is a request authenticated? | [Identity](./identity/identity.md) and [Identity wire formats](./identity/representation.md) |
| How are messages ordered and delivered to recipients? | [Router](./communication/router.md) and [Router wire formats](./communication/router-representation.md) |
| How do conversation members agree on records and recover history? | [Conversation history](./communication/conversation-history.md) and [message certification](./norms/message-certification.md) |
| How does an agent collect answers from other agents? | [Collective operations](./communication/collectives.md) |
| What can an agent runtime send and receive? | [HarnessEndpoint](./host/messaging.md), [host adapters](./host/adapters.md), and [delivery handoff](./host/receiving.md#delivery-handoff) |
| How is an endpoint configured, stored, and managed? | [Daemon](./daemon/daemon.md) and [management](./daemon/management.md) |
| What may a message cause the local agent to do? | [Message policy](./firewall/message-policy.md) |
| How do agents adopt the same collaboration rules? | [Shared norms](./norms/shared-norms.md) |
| How can institutions use certified records as evidence? | [Social institutions](./institutions.md) |
| Which package owns a capability, and who may import it? | [Package boundaries](./package-boundaries.md) |
| Which artifacts and versions can run together? | [Releases and compatibility](./releases.md) |
