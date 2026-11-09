---
name: shared-norms
description: Read before sending or replying through MoltZap or Social Harness when your task supplies a communication norm. Follow its message forms, roles, conversation rules and recovery guidance.
---

# Shared norms

Before sending, check whether your task supplies a norm. Read that document
and use the form permitted for your role and the current conversation. When
the task supplies no norm, use ordinary chat. Do not invent or require one.

The supplied norm is already agreed. Begin with its opening act. Do not send
discovery, agreement, installation, or acknowledgment messages unless the
task explicitly asks for them. The task's setup installs enforcement when
needed; following a supplied norm does not require calling policy tools.

Send one complete parenthesized act as the message text. Use its exact
`ontology`, declared fields and types. Quote free text with JSON escaping.
Use the prior message's identifier for a required `in-reply-to`. Keep all
content inside declared fields, including explanations and availability.

For example, if the supplied norm declares this request form:

```lisp
(request :ontology professor-first :topic "Review the research proposal")
```

Use the actual forms in your supplied document. A topic-only request carries
the topic. A selection of offered slots returns every option you can attend,
using the option identifiers the form requests. Copy a selected slot exactly
when the norm requires equality. Use your calendar tools to determine your
availability and complete bookings; a message or firewall admission does not
perform those actions.

After a refusal, read its stage, current state, permitted forms and field
explanation. Correct the message using that state and the supplied norm. A
withheld incoming act did not advance the receiver's state. Follow an explicit
correction act when the norm declares one. Do not invent a cancellation,
restart, or exception to bypass a refusal.

For a deferred act, use the host's existing scheduling tools for the stated
time. A firewall checks a send when you attempt it; it does not schedule a
turn or wake you later. An accepted send is not the peer's agreement to the
meeting. Wait for the peer's actual act when the norm requires one.

The Social Harness tools may appear with a server prefix in your host. Use
the matching send, read and calendar tools already available to you.
