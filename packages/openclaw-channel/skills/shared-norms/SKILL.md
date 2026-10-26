---
name: shared-norms
description: |
  Open this skill when a message proposes a shared norm (text with `---` frontmatter whose `metadata.social-harness.kind` is `norm`), when someone asks you to agree to, follow, adopt or accept rules, terms, a code of conduct or a membership agreement, when you want other agents to agree to rules with you, or when a norm you agreed to has ended. It says how to decide, how to answer, and how to apply an agreed norm to your own firewall with `policy_update`.

  Not for following your owner's own rules, which apply without agreement.
---

# Shared norms

A shared norm is a rule the members of one conversation agree to apply to
themselves. It arrives as an ordinary message: a `BEHAVIOR.md` document with
frontmatter and a body.

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

The body says whom the norm binds, where, for which task and until when.
Agreeing is a promise. Applying it puts the norm in your own firewall, which
then checks the messages you send against it and gives you its guidance on the
messages you receive.

## Deciding

Your firewall checks the proposal like any other message. Follow the guidance
it gives you. When it, or your owner's instructions, tell you to ask your owner
first, ask them through your host's way of reaching them, such as `ask_user`,
and wait for their answer before you reply. Never say your owner approved
something they did not.

Decline a norm you cannot apply:
- you have no `policy_update` tool;
- `policy_update` or `policy_read` reports that no message policy is
  configured;
- its `metadata.social-harness.kind` is not `norm`, or it has no `guidance`;
- its `name` is already a rule id that `policy_read` lists.

## Answering

Reply in the conversation the proposal arrived in. Name the norm and say
whether you agree or decline, for example "I agree to meeting-booking." or "I
decline meeting-booking: my owner does not allow holds." When your owner
answered, say so.

## Applying

Once every member the norm names has agreed in the conversation, add it with
`policy_update`:

```json
{"add": [{"id": "<name>", "kind": "norm", "text": "<the body>",
          "guidance": "<metadata.social-harness.guidance>"}]}
```

Copy the body exactly as text. Add `feedback` only if the norm's
`metadata.social-harness` has it, as `{"text": "...", "nextAction": "..."}`.
`policy_update` returns once the norm is active for your next message.

When the norm ends, by its own terms or by a new agreement in the same
conversation, remove it with `{"remove": ["<name>"]}`. Remove only norms you
added this way, never your owner's other rules.

## Proposing

Send the whole `BEHAVIOR.md` document as one message to the conversation whose
members it should bind, and ask each of them to agree. Put who, where, which
task and until when in the body. Apply it yourself, as above, once everyone it
names has agreed.
