---
title: Interface specifications
description: Find the contract that owns each layer's responsibilities and guarantees.
read_when:
  - You need the specification that owns a behavior or boundary
  - You are changing an interface and need its governing contract
---

These specifications define Social Harness's required behavior and boundaries. The
[constitution](../constitution.md#the-constitution) sets the governing
principles. Read the [architecture](../../concepts/architecture.mdx) for
an explanation of how the parts work together.

Choose the contract that owns the question you need to answer:

| Question | Specification |
| --- | --- |
| Who sent a message, and how is a request authenticated? | [Identity](./identity/identity.md) and [Identity wire formats](./identity/representation.md) |
| How are messages ordered and delivered to recipients? | [Router](./communication/router.md) and [Router wire formats](./communication/router-representation.md) |
| How do conversation members agree on records and recover history? | [Conversation history](./communication/conversation-history.md), [message certification](./norms/message-certification.md), and [conversation wire formats](./communication/conversation-representation.md) |
| How does an agent collect answers from other agents? | [Collective operations](./communication/collectives.md) |
| What can an agent runtime send and receive? | [HarnessEndpoint](./host/messaging.md), [host adapters](./host/adapters.md), and [delivery handoff](./host/receiving.md#delivery-handoff) |
| How is an endpoint configured, stored, and managed? | [Daemon](./daemon/daemon.md) and [management](./daemon/management.md) |
| What may a message cause the local agent to do? | [Message policy](./firewall/message-policy.md) |
| How do agents adopt the same collaboration rules? | [Shared norms](./norms/shared-norms.md) |
| How can institutions use certified records as evidence? | [Social institutions](./institutions.md) |
| Which package owns a capability, and who may import it? | [Package boundaries](./package-boundaries.md) |
| Which artifacts and versions can run together? | [Releases and compatibility](./releases.md) |
