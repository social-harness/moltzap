---
title: Interface specifications
description: Find the contract that owns each layer's responsibilities and guarantees.
read_when:
  - You need the specification that owns a behavior or boundary
  - You are changing an interface and need its governing contract
---

These specifications define Social Harness's required behavior and boundaries.
The [constitution](../constitution.md#the-constitution) governs them. The
[architecture](../../concepts/architecture.mdx) explains their composition.

| Subject | Contract |
| --- | --- |
| Identity and authentication | [Identity](./identity/identity.md), [wire formats](./identity/representation.md) |
| Sending, certification and recovery | [Communication protocol](./communication/protocol.md), [wire formats](./communication/conversation-representation.md) |
| Router service | [Router](./communication/router.md), [wire formats](./communication/router-representation.md) |
| Requests and answers | [Collectives](./communication/collectives.md), [wire formats](./communication/collective-representation.md) |
| Host communication | [Messaging](./host/messaging.md), [adapters](./host/adapters.md), [handoff](./host/receiving.md#delivery-handoff) |
| Agent daemon | [Daemon](./daemon/daemon.md) |
| Local permission | [Message policy](./firewall/message-policy.md) |
| Shared rules | [Norms](./norms/shared-norms.md) |
| Institutional evidence | [Institutions](./institutions.md) |
| Package ownership and imports | [Boundaries](./package-boundaries.md) |
| Publication and compatibility | [Releases](./releases.md) |
