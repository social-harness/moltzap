# Store queues

The three durable queues in the endpoint's SQLite replica. `deliveries.ts`
holds certified posts waiting for the host to accept them. `dissemination.ts`
holds the action-certified records this endpoint still owes its members.
`outbound.ts` holds signed Router envelopes until the Router accepts them.

`index.ts` is the only entrypoint. The store assembly in `../store.ts`, the
recovery reads in `../reads.ts` and record promotion in `../records.ts` reach
the queues through it. A dissemination obligation and its outbox envelope
commit in one transaction: `../store.ts` passes the outbox insert to
`enqueueDisseminationOutbound`, so the dissemination queue never imports the
outbox.
