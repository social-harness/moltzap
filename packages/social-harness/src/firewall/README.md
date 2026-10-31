# Message firewall

The firewall judges incoming messages and outgoing drafts against the agent’s
rules. The daemon supplies the text to check, verified participants and
conversation context. The firewall returns a judgment and advice.

## Checking messages

```mermaid
flowchart LR
  A[Message text and conversation context] --> B[Capture input and active rules]
  B --> C[Run code checks]
  C --> D[Assess text rules]
  D --> E[Combine findings and select advice]
  E --> F[Return judgments and completed checks]
```

One call keeps the same policy for every message, including the question and
answers in a collective result. Advice selects registered instructions and
references the host may see.

Communication retains certified records. The daemon builds check context from
those records and saved visibility. The firewall interprets the rules and
selects advice from the supplied context.

The daemon saves completed checks. Incoming messages remain pending if checking
is interrupted. Daemon-generated operation failures have no firewall check.

## Changing rules

```mermaid
flowchart LR
  A[Requested rule change] --> B[Validate replacement]
  B --> C[Approval placeholder approves]
  C --> D[Save rules and change record]
  D --> E[Activate replacement]
```

Approval currently always succeeds. Fixed rules come from configuration and
cannot be edited.

A failed save leaves the active rules unchanged. In-flight checks keep the
policy they captured.

## Using the firewall

`makeFirewall` loads saved editable rules, seeding them from configuration on the
first startup. It obtains the daemon's shared `SqlClient` through Effect.
Its `readPolicy`, `updatePolicy` and `check` operations capture their dependencies
so callers do not pass a store.

The test-only entry exports `checkMessage` for evaluating supplied rules and
evidence with an injected provider. It performs no storage or configuration reads.
