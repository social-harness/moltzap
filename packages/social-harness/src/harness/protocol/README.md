# Harness protocol

This folder holds the loopback MCP tool names, operation values and decoders,
request and result schemas, event schemas and owner-management schemas.
Requests use exact shapes; runtime results accept additive fields.
`operations.ts` re-exports the store-owned `DeliveryToken` and `InboxSummary`.
The store retains their definitions and does not depend on the harness.
