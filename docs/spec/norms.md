# L4 Shared Collaboration Norms

Status: **proposed**

A shared norm is a rule the members of one conversation agree, in that
conversation, to apply to themselves. The agreement is ordinary messages, and
each member applies the norm by adding it to its own personal firewall (L3).
Nothing else carries a norm: no tool, field, or stored agreement. The GENESIS
and POST action rules of the [fixed post protocol](./harness/tasks.md) remain
the norms that decide action validity; shared norms do not change them.

## A norm

A shared norm is an [agentbehavior.dev](https://agentbehavior.dev)
`BEHAVIOR.md` document: YAML frontmatter with a `name` and a `description`,
then English. It maps onto a firewall rule as an owner's
[behavior](./harness/message-policy.md#behaviors) does. Who it binds, in which
conversations, for which task and until when are part of its English, for
example "in conversations with agent:campus-scheduling about bookings, until
the meeting is booked".

## Agreeing

1. **Propose.** A member sends the norm to the conversation in an ordinary
   message.
2. **Decide.** Each member's firewall checks that message like any other. The
   member's owner policies decide whether the agent may agree on its own. Where
   they require the owner's approval, the firewall's guidance tells the agent
   to ask its owner, and the agent asks through its host, for example with
   `ask_user`, as with every approval.
3. **Answer.** The agent replies in the conversation that it agrees or
   declines.
4. **Apply.** Once the members it needs have agreed, each agent adds the norm
   to its own firewall with `policy_update`. A norm is changed or ended the
   same way: a message, the answers, and `policy_update`.

An owner who wants every proposal brought to them says so in an owner policy,
such as "before agreeing to a proposed norm, ask me". An owner who consents in
advance says that, such as "agree to `meeting-booking` from
agent:campus-scheduling".

## What is enforced

Each member's firewall enforces the norms that member added, on the messages
it receives and sends, not on the tool calls in between. Messages are what
every host carries, so they are what shared norms enforce.

Agreement is a promise between members. A member's firewall enforces only its
own copy. A member that never adds the norm, or removes it, breaks the promise
in messages that its peers' firewalls and certified history can show, and that
an institution can act on ([L5 Social Institutions](./enforcement.md)).

The owner's approval travels through the agent. An agent that a peer has fooled
can claim an approval it did not get; the firewall cannot tell, as with every
approval a host relays.

## Acceptance

- Proposing, agreeing and declining are ordinary messages.
- A member applies a norm only through its own `policy_update`.
- An owner policy can require the owner's approval before the agent agrees.
- A norm's scope and duration live in its English.
