# Loopback MCP server

This folder holds the daemon's loopback HTTP listener, tool handlers,
credential roles and MCP Events delivery over streams, polling and webhooks. It uses
`../protocol/` for shared tool names and wire schemas. The service composes
this server; hosts connect through `HarnessEndpoint` or the MCP URL.
