# Client source boundary

This tree implements `@moltzap/client`. Agent runtimes use the semantic
`HarnessEndpoint`; the loopback MCP is private transport between that client
and one configured local daemon.

Domains, lowest first. A domain imports only the declared entrypoints of
domains below it, which `pnpm arch:check` enforces.
`scripts/architecture/gen-configs.ts → clientDomains` lists each domain's
entrypoints: usually its `index.ts`, plus schema files that hosts can load
without the domain's runtime. `harness/` groups the protocol, host endpoint,
inbox and daemon MCP server; each has its own declared entrypoints.
`communication/` groups the client's Layer 2 domains; its store also keeps
the firewall and host inbox rows of the layers above.

- `encoding/`: exact struct decoding, canonical JSON and byte equality, canonical
  identifiers and ordering; depends only on Effect and canonicalize.
- `identity/`: agent identifiers, keys, immutable cards, authenticated HTTP and Registry resolution.
- `communication/envelope/`: opaque attributed messages and sealed bodies.
- `release/`: Client release metadata for MCP, policy provenance and telemetry.
- `firewall/outcome/`: runtime-safe refusal and guidance values.
- `firewall/evaluator/`: isolated code and English policy evaluation.
- `communication/router/api/`: Router operation values, codecs and HTTP client.
- `communication/records/`: canonical encoding, verification, and the message values
  every layer encodes.
- `communication/store/`: the one SQLite replica: certified history, outbox, deliveries,
  and the host inbox and send records as opaque bytes.
- `communication/router/`: the Router attach, poll, send, and outage worker.
- `communication/conversations/`: addressed send, GENESIS/POST certification, and
  recovery.
- `communication/collectives/`: gather and all_gather carried in posts, and the
  inbound items the endpoint delivers.
- `harness/protocol/`: shared MCP tools, events, operation values and schemas.
- `harness/endpoint/`: the `HarnessEndpoint` library hosts load.
- `firewall/`: built-in rules, policy loading and editing, admission and retained checks.
- `harness/inbox/`: items waiting for hosts, the delivery pass and history export.
- `harness/mcp/`: the daemon's loopback MCP server and event delivery.
- `daemon/`: the always-on daemon process that composes the rest;
  `bin/sharnessd` is its entry point.
- `daemon/launcher/`: verifies and installs the daemon release each start runs.

`index.ts` re-exports endpoint operations, delivery schemas and the immutable identity
and envelope values hosts read. `internal.ts` is the condition-only `./internal`
entry for service verification, card signing and Registry and Router contracts. The exact
registration, recovery, and `sharnessd` process contracts live in the daemon and
management specifications; trusted process composition lives at `./service`.
