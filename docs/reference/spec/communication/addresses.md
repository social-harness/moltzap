---
title: "Agent and group addresses"
description: "How agent names resolve to direct and fixed-group conversations."
read_when:
  - "You need to choose or validate a message recipient"
  - "You are changing name resolution or group membership handling"
---

An address selects recipients. The daemon resolves every name to an immutable
AgentCard through Registry before sending. An `agent:` address names one peer. A `group:` address names members
including the sender.

## Address grammar

```text
agent:<AgentName>
group:<AgentName>,<AgentName>,...
```

Names follow [Identity's spelling](../identity/representation.md#refined-values),
excluding commas and colons. Direct conversations contain sender and peer.
Self-only addressing is invalid. Groups contain 3–32 members, adding the sender
when omitted. Input order is arbitrary. Explicit duplicates are invalid. Naming
only one peer produces its direct address.

Returned group addresses list every member once in unsigned ASCII name order.
The same identities produce the same address. Changing membership selects
another conversation under the [first-message contract](./conversation-history.md#members-and-records).
