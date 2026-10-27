# Conversations

This folder owns fixed-member conversations: resolving `agent:` and `group:`
addresses, binding a send's intent, Router-ordered proposal selection,
GENESIS/POST certification, durable dissemination, and recovery.

`index.ts` declares the engine contract (`EndpointEngine`, its errors, and the
pending-message value) and composes the endpoint engine. The service builds the
engine through it and also takes `verifyStoredMembership`, the one verifier of
a stored membership row, and `readStoredHistory`, the stored-history reader the
owner tools page through. Collectives and delivery import only its types.
Other domains read the entrypoints `address.ts` (Registry resolution of an
address and the canonical group address of a fixed membership), `errors.ts`
(closed send, listen, and acknowledgment errors) and `message.ts` (inbound
messages) directly, so they never load the engine.

Inside the engine, `runtime/index.ts` is the kernel: the dependencies an
engine is built from and the state every phase reads. It is deliberately a
single-file folder entrypoint, because every phase depends on it and it
depends on no phase. `history/` builds the durable records a fold certifies
and reads stored history back, and `startup.ts` rebuilds the engine's state
from the store when the engine starts.
The phases are `send.ts`, `certification/` (certification, evidence routing,
and the dissemination resume), `recovery/` (recovery runs and catch-up) and
`reanchor/` (Router-restart re-anchor). A phase starts work in another phase
through `EngineRuntime.phases`, which `index.ts` supplies, or through the
called phase's entrypoint. Recovery starts each re-anchor run with the
`ReanchorRunPort` it builds, then passes the run its votes, completed
re-anchors and ready positions; catch-up adopts a member's completed re-anchor
(`applyCompletedReanchor`); and `send.ts` reads the recovery fence a send
waits behind (`pendingRecoveryFence`). Phases never import each other's
internals.

`outbox.ts` builds the `EngineOutbox` port; only `index.ts` imports it.
`retry-markers.ts` records the `retry.pending` and `retry.settled` spans that
bracket long waits; the phases and the outbox import it, and `index.ts`
re-exports it for delivery's checks and the endpoint's webhook retries.
