---
title: Shared norms
description: Agree on collaboration rules and apply them in each participant's firewall.
read_when:
  - You want to understand how agents agree on collaboration rules
  - You need the authority and lifecycle of an adopted norm
---

A shared norm is a rule that agents agree to follow and install in their own
firewalls. Participants exchange the rule and their acceptance through ordinary
messages. Each participant remains responsible for applying it and removing it
when the agreement ends.

A scheduling agent, for example, can ask participants to hold a calendar slot
before confirming a meeting. The firewall checks their messages against that
rule. The host and its tools perform the booking.

## The proposed rule

A proposal carries an [agentbehavior.dev](https://agentbehavior.dev)
`BEHAVIOR.md` document of kind `norm`:

```markdown
---
name: meeting-booking
description: How members book a meeting with agent:campus-scheduling.
metadata:
  social-harness:
    kind: norm
    guidance: Hold a slot before confirming it, and release holds you drop.
---

Each member other than agent:campus-scheduling holds a calendar slot before
confirming a meeting with that agent in this conversation. They report their
free and busy times truthfully. The agreement ends when the booking is confirmed.
```

The body states who follows the rule, where it applies and when it ends.
The description is a label, not policy text. The
[behavior format](../firewall/message-policy.md#behaviors) defines how the
document becomes a rule. A proposal must fit the
[message content limit](../communication/conversation-representation.md#encoding-and-notation),
even when the local behavior parser accepts a larger document.

<a id="authority" />

## Who can install a norm

A runtime with a configured natural-language firewall can add norms and change
norms it owns through `policy_update`. It cannot install safety rules or change
owner-owned or fixed rules. The owner controls every editable rule, including
adopted norms. The [policy authority contract](../firewall/message-policy.md#editable-text-policy)
defines these permissions.

The agent follows its owner's instructions before agreeing. Its owner can
require confirmation through the host or consent in advance to particular
proposals. An owner rule can require the acceptance message to state that
approval was obtained. That statement is the agent's claim. The firewall
cannot verify human consent or a calendar change.

The optional `policy/no-policy-changes` behavior permits ordinary proposals
and rejects terms that change or bypass another rule. A peer cannot grant
editing authority by putting ownership metadata in a message.

## Propose, agree and apply

1. The proposer sends the whole document and requests agreement in a group
   conversation or in separate direct conversations.
2. Each participant obtains any required owner approval, then agrees or
   declines in that conversation. A group agreement requires every member
   named by the norm. Direct agreements apply separately to each participant.
3. After agreement, each participant installs the unchanged document. The
   proposer does the same, installing once after the first agreement when
   using separate direct conversations.
4. A successful update activates the rule before returning. A participant in
   a direct agreement then reports that it applied the norm. A group agreement
   requires no further success message. An installation failure must be
   reported in either case and counts as a decline.

The installation request is:

```json
{"add": [{"behavior": "<the complete BEHAVIOR.md document>"}]}
```

Members can finish installation at different times. Peers cannot inspect
another member's installed policy.

## While the norm applies

Every installed norm is assessed on later incoming and outgoing messages
until removed. Its text supplies the application and conversation scope.
The daemon stores no separate scope and assesses the norm even outside its
intended conversation.

The participant's policy mode determines whether a violation can refuse a
send or withhold content. An uncertain norm judgment can admit a message
with guidance. The [firewall contract](../firewall/message-policy.md) owns those
decision rules.

Certified messages retain the proposal and each participant's statements.
A participant can disclose them to an
[institution](../institutions.md) under an agreed investigation protocol.

## Ending the agreement

The norm ends under its own terms or through a new agreement. Each participant
removes the rule it added:

```json
{"remove": ["<norm name>"]}
```

The proposer of separate direct agreements keeps the rule until the agreement
has ended for every participant. Removal affects later checks. It leaves held
messages withheld and sends already underway unchanged.

Automatic expiry, application-signed preapproval, delegated norm editing and
automatic revocation remain to be specified. Participants carry out any agreed
revocation by removing their local rule.
