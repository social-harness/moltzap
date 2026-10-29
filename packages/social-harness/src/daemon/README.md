# Daemon composition

The daemon turns process configuration and a durable identity binding into a
running endpoint. Lifecycle changes must cover both startup with an existing
identity and registration through owner management. Both paths activate the
protocol through `runtime/index.ts` → `initializeProtocol`.

A committed identity can be visible to status before its protocol resources
are ready. When changing startup or the MCP catalog, distinguish those states
and preserve the registration path that connects them. Trace a new failure
through `Daemon.StartupError` before exposing it in process output, where
private configuration must remain redacted.

The [daemon contract](../../../../docs/reference/spec/agent/daemon.md) owns
startup, registration, persistence and shutdown behavior.
