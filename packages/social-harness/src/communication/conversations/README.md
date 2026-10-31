# Changing the conversation engine

The [engine composition](index.ts) verifies stored state before starting
protocol work. Its phases share the state and dependency contracts in
[runtime/index.ts](./engine-context.ts). Composition supplies cross-phase
operations so sending, certification, and recovery can cooperate without
importing each other's implementation details.

Protocol work queues signed messages for the [outbox](outbox.ts) to transmit.
Review gate lifetimes when adding a network wait: a Router send can observe a
restart and enter recovery on the same fiber. `outbox.ts` → `drain` explains
why its queue gate ends before transmission. The
[recovery barriers](recovery/barrier.ts) separate the run-wide fence from each
conversation's wait for a usable position. The
[communication protocol](../../../../../docs/reference/spec/communication/protocol.md)
owns quorum, certification, and recovery ordering.
