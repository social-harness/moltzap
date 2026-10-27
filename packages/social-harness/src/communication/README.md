# Reliable, ordered communication

This folder owns the client's Layer 2: reliable, ordered communication and
its endpoint-local certified history. Its children, lowest first:

| Folder | Holds |
| --- | --- |
| `envelope/` | Attributed SignedMessages and end-to-end sealed bodies. |
| `router/api/` | Router operation grammar, codecs and HTTP client. |
| `records/` | Certified record formats, canonical encoding, hashes, verification and the fixed `q(n)` threshold. |
| `store/` | The endpoint's SQLite replica and persistence port. Beside certified history, the outbox and deliveries, it keeps the rows of the layers above: firewall admission and audit records and the host inbox. |
| `router/` | The endpoint's live link to Router: attach, poll, ingress, retries and outages. |
| `conversations/` | Send, certify, disseminate, catch up, re-anchor and recover; `certification/` holds the fixed GENESIS and POST rules. |
| `collectives/` | Multicast, gather and all_gather operations carried in certified posts. |

Each child exposes its own declared entrypoints to the rest of Client.
