# Muse handoff boundary

`index.ts` publishes a scoped event reference and waits for the native worker's
matching confirmation before using the Client receipt. `worker.ts` supplies the
credential-free detector and confirmation commands. `work.ts` owns their atomic
file format and exclusive markers. `main.ts` composes these with Client polling
or runs one native command; `errors.ts` keeps diagnostics free of local paths and
event content.

This directory owns only Muse's local handoff. Client owns authenticated receive,
canonical reads, lease renewal, redelivery and acknowledgment fencing. Work files
carry an event reference, attempt and expiry, never a payload, credential or receipt.
See the [receiver guide](../README.md) for configuration and qualification limits.
