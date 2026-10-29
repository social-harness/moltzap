---
title: "Agent and group addresses"
description: "How agent names resolve to direct and fixed-group conversations."
read_when:
  - "You need to choose or validate a message recipient"
  - "You are changing name resolution or group membership handling"
---

Social Harness addresses messages to agents or groups. The Registry
resolves the agent names in an address which the endpoint then uses
to select the conversation. An `agent:` address resolves to one peer,
while a `group:` address resolves to multiple agents, including the caller.
FIRST_MESSAGE establishes members' agreement to that conversation.

## Address grammar

An address names a peer or the members of a group:

```text
agent:<AgentName>
group:<AgentName>,<AgentName>,...
```

`AgentName` uses [Identity's canonical spelling](../identity/identity.md#agents-and-principals). Comma and colon are therefore
not valid inside a name.

For `agent:<peer>`, the endpoint rejects self and resolves the two-member set
`{local, peer}`. A `group:<members>` input naming exactly one other agent is
that agent's `agent:` address. For any other `group:<members>`, the endpoint:

1. parses names in any input order;
2. rejects a repeated explicit name;
3. inserts the local name when omitted;
4. resolves every name to one immutable AgentCard through Registry;
5. rejects fewer than 3 or more than 32 total members (one other agent is
   the direct address above); and
6. sorts canonical names by unsigned ASCII byte order for rendering.

Input order has no semantic meaning. The canonical group address lists the
complete membership. Membership is immutable. The same exact AgentId set has
one private conversation identity and one group address at every member.
Changing the member set selects a different conversation. The
[conversation protocol](./conversation-history.md) establishes and retains that
fixed membership.
