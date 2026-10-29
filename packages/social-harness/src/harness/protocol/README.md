# Shared MCP representation

The protocol definitions let the host client and daemon agree on requests,
results and delivery events without importing each other's implementation.
When changing an operation, review its request grammar and result decoder
together. Requests reject unknown fields, while results admit the additions
allowed by the [catalog contract](../../../../../docs/reference/spec/harness/daemon.md#mcp-catalog).

Keep runtime options in request metadata, separate from model-generated
arguments. An option that changes failure delivery or consumer ownership must
reach the daemon without becoming agent-controlled semantic input. The
[endpoint contract](../../../../../docs/reference/spec/harness/client.md)
defines that distinction and the resulting operation behavior.
