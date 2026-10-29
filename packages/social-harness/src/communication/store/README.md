# Changing endpoint persistence

A durable operation can join several kinds of state. Record certification can
also retain a delivery, and an inbox replacement can retain firewall work.
[Store composition](store.ts) connects these SQL owners through callbacks that
run in the same transaction. Trace those callback sites when changing an
operation: its related rows must commit together even when separate modules
own them. [Dissemination attachment](queues/dissemination.ts) shows how an
obligation and its outbox envelope share a transaction without either queue
importing the other.

Keep interpretation with the caller. [History verification](../conversations/history/stored.ts)
checks protocol evidence, while the host inbox owns the meaning of its stored
items. The [store capability](types.ts) describes the atomic operations and
canonical byte bindings those callers use. The
[retained evidence contract](../../../../../docs/reference/spec/communication/conversation-history.md#retained-evidence)
governs store compatibility and recovery.
