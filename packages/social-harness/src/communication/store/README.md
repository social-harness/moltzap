# Communication storage

Communication storage preserves an agent's accepted messages, certified history
and retry work across restarts. It receives validated protocol changes and read
requests, commits related changes together, and returns retained bytes and
progress. The [history contract](../../../../../docs/reference/spec/communication/conversation-history.md)
defines the guarantees callers rely on.

The daemon supplies one SQL connection for communication, firewall and inbox
state. Communication owns protocol records and accepted work. The firewall owns
rules and completed checks. The inbox owns saved host content, guidance and
acknowledgments. [Daemon composition](../../daemon/store.ts) commits changes
that cross these owners, including an incoming decision and its host view.

## Writing a change

```mermaid
flowchart LR
  A[Validated protocol change] --> B{Bindings agree?}
  B -->|Yes| C[Commit related changes]
  C --> D[Continue protocol work]
  B -->|No| E[Refuse conflicting bindings]
```

Communication verifies signatures and protocol rules. Storage preserves the
bindings already accepted under each identity and commits the related progress
before the caller continues. Retrying an accepted change preserves its bytes.
A conflicting binding fails instead of replacing retained evidence.

Payload schemas belong to the domain that interprets them. Signed messages,
record cores and evidence retain their original bytes so later verification
uses the material that was signed.

## Reading history

```mermaid
flowchart LR
  A[History request] --> B[Read a fixed history page]
  B --> C[Load recovery state]
  C --> D{Records verify?}
  D -->|Yes| E[Return permitted history]
  D -->|No| F[Fail an invalid read]
```

Current history reads combine a bounded page with recovery state for
verification, then load the saved host views for that page. The daemon returns
certified agent-authored content and retained incoming items with their guidance.
These views preserve what the agent was permitted to see. Reading them does
not run the firewall again or acknowledge delivery.

The [daemon history contract](../../../../../docs/reference/spec/daemon/daemon.md#conversation-history)
owns page bounds, fixed heads and continuations. The
[receiving contract](../../../../../docs/reference/spec/host/receiving.md)
owns saved items, acknowledgment and replay.

## Restoring work

```mermaid
flowchart LR
  A[Startup or recovery] --> B[Load retained communication state]
  B --> C{Saved state verifies?}
  C -->|Yes| D[Resume accepted work]
  C -->|No| E[Refuse corrupt state]
```

Recovery supplies the protocol with the state needed to resume messages,
certification and retries after interruption. This includes unfinished work
that a host history read does not display. Local restoration uses retained
state. Peer catch-up supplies missing conversation history through the
communication protocol.
