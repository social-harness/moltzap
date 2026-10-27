# Messaging certification

This directory certifies posts. It selects the Router-ordered proposal at
each predecessor, signs and collects action and durability evidence, and
promotes a record once its certificates reach quorum. When a verified POST
record whose action certificate meets `q(n)` names another proposal at a
locked predecessor, it releases that lock and locks the record's action
without signing it. It also resumes sending the action-certified records
that the store still owes to peers.

Start with `index.ts`. It accepts Router and recovery ingress, resumes folds
at startup and as each conversation recovers, and re-exports the dissemination
resume and the evidence-to-fold match `../startup.ts` uses. `evidence.ts`
routes a stable evidence message to the fold it names and verifies it.
`dissemination.ts` re-queues each durable dissemination obligation. Both are
private to this directory; the engine binds the operations other phases start
through `EngineRuntime.phases`.
