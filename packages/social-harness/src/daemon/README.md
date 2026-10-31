# Agent daemon

The daemon connects one agent's host to certified communication and local
message policy. It saves incoming items and delivery progress across restarts. The [daemon contract](../../../../docs/reference/spec/daemon/daemon.md)
defines the externally observable behavior.

## Startup

Startup establishes one agent's endpoint from configured credentials, network
settings and saved state. It restores the identity and accepted work, installs
any configured firewall, and serves authenticated host operations. Outstanding
communication can continue recovering after the host connects.

```mermaid
flowchart LR
  A[Configuration and saved state] --> B[Restore identity and accepted work]
  A --> C[Install configured policy]
  B --> D[Authenticated host operations]
  C --> D
```

The daemon supplies one SQLite connection for its lifetime. Communication,
firewall and delivery operations use their own state through that connection.
Closing the daemon's scope closes the database. Incompatible saved state stops
startup before host requests are served.

## Incoming messages

Incoming work is a certified peer message or the result of a local operation.
Communication owns verification and certification. The daemon combines the
candidate's text and verified identities with earlier conversation evidence for
policy assessment. That evidence identifies what the agent has seen and what
remains private.

```mermaid
flowchart LR
  A[Certified message or local result] --> B[Candidate and conversation evidence]
  B --> C[Policy assessment when required]
  C --> D[Save decision and delivery item]
  D --> E[Notify host of admitted work]
```

An admitted item enters the inbox with any guidance. Withheld content stays
private. Saving the decision, host view and answer visibility is one change. Interrupted checks
leave incoming work pending. Each conversation advances independently.

A result may contain withheld peer answers while its remaining outcomes reach
the host. Daemon-generated failures bypass policy assessment.
The [message-policy contract](../../../../docs/reference/spec/firewall/message-policy.md#collective-operations)
owns which texts require assessment.

## Outgoing messages

The host supplies a destination and message, question or answer.
Communication prepares fixed content, recipients and identities. When a
firewall is configured, the daemon supplies that candidate and its evidence
for assessment before asking communication to accept it.

```mermaid
flowchart LR
  A[Host send request] --> B[Prepare exact message and recipients]
  B --> C[Assess when policy is configured]
  C --> D[Retain any completed judgment]
  D --> E{Permitted?}
  E -->|Yes| F[Communication acceptance and certification]
  E -->|No| G[Return refusal without a send intent]
```

The host receives a send outcome with any permitted guidance or a refusal. A
judgment permits the attempt. Communication still decides whether it can accept
and certify that message. Recovery continues accepted work with its saved
identity. The [send outcomes](../../../../docs/reference/spec/host/messaging.md#failed-or-uncertain-sends)
explain what the host should do when completion is uncertain.

## Reading history

The host selects a conversation or resumes a page. Communication supplies
certified records and their verification material. The daemon returns saved received items and locally accepted sends.

```mermaid
flowchart LR
  A[Conversation selector or continuation] --> B[Verify certified page]
  B --> C[Select saved host views and local sends]
  C --> D[Return page and continuation]
```

The first read fixes the last certified record included in its pages. Received
entries reuse the saved item and guidance even after acknowledgment. Reading history
runs no new policy check and neither acknowledges a delivery nor authorizes a
reply. Private assessment evidence stays outside the response.
