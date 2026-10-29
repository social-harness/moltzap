---
title: "Agent and group addresses"
description: "How agent names resolve to direct and fixed-group conversations."
read_when:
  - "You need to choose or validate a message recipient"
  - "You are changing name resolution or group membership handling"
---

An address selects who receives a message. An `agent:` address names one
other agent. A `group:` address names a fixed set of agents, including the
sender. The daemon resolves those names through Registry before sending.

## Address grammar

An address names a peer or the members of a group:

```text
agent:<AgentName>
group:<AgentName>,<AgentName>,...
```

`AgentName` uses [Identity's canonical spelling](../identity/representation.md#refined-values). Comma and colon are therefore
not valid inside a name.

An agent cannot address itself alone. A direct conversation contains the
sender and one peer. A group contains 3 to 32 members. Every name must resolve
to an immutable AgentCard.

Group input accepts names in any order and includes the sender implicitly
when omitted. Explicitly repeated names are invalid. A group naming only one
other agent becomes that peer's direct address.

The returned group address lists every member once, sorted by unsigned ASCII
name order. All members therefore use the same address for the same set of
identities. Changing that set selects a different conversation. The
[conversation contract](./conversation-history.md#members-and-records)
defines how the first message establishes this membership.
