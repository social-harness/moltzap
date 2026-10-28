# Shared norms

Status: **proposed**

A shared norm is a rule its members agree to apply to themselves: all of them
in one group conversation, or each member in its own direct conversation with
the agent that proposed it. The agreement is ordinary messages, and
each member applies the norm by adding it to its own personal firewall (L3)
with `policy_update`. Shared norms add no tool, message field or stored
agreement. They are not the L4 contracts the vision defers, and the GENESIS
and POST action rules of the [fixed post protocol](./harness/tasks.md) remain
the norms that decide action validity.

## A norm

A shared norm is an [agentbehavior.dev](https://agentbehavior.dev)
`BEHAVIOR.md` document of kind `norm`, carried as message text:

```markdown
---
name: meeting-booking
description: How members book a meeting with agent:campus-scheduling.
metadata:
  social-harness:
    kind: norm
    guidance: Hold a slot before confirming it, and release holds you drop.
---

Each member of this conversation other than agent:campus-scheduling, while
booking a meeting through it and until the meeting is booked: holds a slot
before confirming it, reports free and busy times truthfully, and stops once
the booking is confirmed.
```

It maps onto an editable English rule as a
[behavior](./harness/message-policy.md#behaviors) does, so it needs the
`guidance` that a `norm` rule requires. Who it binds, in which conversations,
for which task and until when belong in its body, because `description` is not
part of the rule.

## Agreeing

1. **Propose.** A member sends the norm in an ordinary message: to the group
   conversation whose members it should bind, or to each member in its own
   direct conversation.
2. **Decide.** Each member's firewall checks that message like any other. An
   owner who wants proposals brought to them says so in an owner rule of kind
   `norm`, whose guidance tells the agent to ask its owner, through a host tool
   such as `ask_user`, before it answers. The rule's text must be checkable
   from the reply alone, for example "A reply agreeing to a proposed shared
   norm states that the owner approved it", with the guidance "Ask your owner
   with `ask_user` before agreeing".
   An owner who consents in advance says that in the same way, for example
   "agree to `meeting-booking` from agent:campus-scheduling".
3. **Answer.** The agent replies in the conversation the proposal arrived in
   that it agrees or declines. A reply that reports the owner's answer is the agent's claim; the
   firewall cannot verify it.
4. **Apply.** Once the norm is agreed, each agent adds the `Rule` the norm
   maps to with `policy_update`, doing the mapping itself: `id` from `name`,
   `text` from the body, and the rest from `metadata.social-harness`. A norm
   proposed in a group conversation is agreed once the members it names have
   agreed there. A norm proposed to each member in its own direct
   conversation is agreed for that member when it agrees there; the proposer
   adds it once, when the first member agrees, and removes it only when it has
   ended for every member who agreed. When the norm ends, by its own terms or
   by a new agreement, each agent removes it the same way.
5. **Confirm.** In a direct conversation, the member says that it applied the
   norm; in a group, it says nothing more. A member whose `policy_update`
   fails says so where it agreed, and has declined. A reply that it applied
   the norm is a promise; the member's later messages, which its own firewall
   checks against the norm, bear it out.

An agent declines a norm it cannot apply:
- it lacks `policy_update`, which only the owner and trusted-local catalogs
  list;
- it has no firewall, or no English policy;
- the norm is not of kind `norm`, or has no `guidance`;
- its `name` is already a rule id in the agent's policy.

An agent removes only rules it added for a norm.

## Authority

Adding a norm is an owner edit. `policy_update` is owner authority, so the
added norm is an editable owner rule like any other, and the edit appears in
the owner decisions feed's activations. An agent that holds `policy_update` can
also remove the owner's editable rules. Owner rules that must bind such an
agent belong in `fixedRules` or `fixedBehaviors`, which `policy_update`
refuses to change.

## What is enforced

Each member's firewall applies the norms that member added, in its owner's
mode, to the messages it sends and, as guidance, to the messages it receives.
It does not check tool calls. Messages are what every host carries, so they are
what shared norms reach.

Agreement is a promise between members. A member that never adds a norm, or
removes it early, shows that only through its messages, which its peers hold in
certified history and can disclose to an institution
([L5 Social Institutions](./enforcement.md)).

Every added norm is assessed on each later message the member sends or
receives, so it costs decision-provider calls until it is removed.

## Acceptance

- Proposing, agreeing and declining are ordinary messages.
- A member applies a norm only through its own `policy_update`, and removes it
  the same way.
- A member says that it applied a norm agreed in its direct conversation, and
  any member says why it could not apply one.
- An owner rule of kind `norm` can instruct the agent, through guidance, to ask
  its owner before agreeing.
- A norm's scope and duration live in its body.
