# Store

This private folder owns the daemon's one SQLite replica: schema
compatibility, transactions, and every SQL statement. Conversations keep verified
protocol history, pending deliveries, outbound Router envelopes, and recovery
snapshots here. The host inbox and event state are stored as opaque
canonical bytes, whose meaning `harness/inbox/` owns. The pending-delivery,
dissemination and outbox queues live in `queues/`.

Conversations, delivery, and the service use `index.ts`. Hosts read only the value
schemas in `types.ts`, so they never load the SQLite store. Storage modules do
not cross the public Client boundary.
