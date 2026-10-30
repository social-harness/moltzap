# Agent daemon

The daemon connects one agent's communication, firewall and durable inbox.
It prepares checks, applies their judgments and offers the resulting items to
the host after they are saved.

This draft describes the daemon boundary under review.

## Responsibilities

| Component | Owns |
| --- | --- |
| Communication | Verified records, accepted sends and collective operation state |
| Firewall | Message checks, rule changes and required approval |
| Daemon | Evidence preparation, checking order and application of judgments |
| Store | Durable state, retained visibility, history reads and atomic publication |
| Host | Model execution, tools and acknowledgment after accepting delivery |

`daemon/store.ts` opens one database and supplies the operations those owners
need. Incoming work, evidence windows and publication belong to this store.
The firewall receives only rule and check persistence operations.

## Startup

```mermaid
flowchart LR
  A[Load configuration] --> B[Open agent store]
  B --> C[Restore identity and unfinished work]
  C --> D[Build firewall from configured and saved rules]
  D --> E[Activate communication and host service]
```

## Incoming message

```mermaid
flowchart LR
  A[Incoming message or collective result] --> B[Save and check in conversation order]
  B --> C[Save the decision and permitted message]
  C --> D[Notify the agent]
```

Later checks use the conversation history available to the agent.

## Outgoing message

```mermaid
flowchart LR
  A[Host send request] --> B[Prepare message and recipients]
  B --> C[Read conversation evidence]
  C --> D[Firewall checks draft]
  D --> E[Retain policy outcome]
  E --> F{Admitted by policy?}
  F -->|Yes| G[Send approved message]
  F -->|No| H[Return refusal]
```
