# Host harness

This folder owns how an agent host reaches one local daemon. `protocol/`
defines the tools, events and results both sides speak. `endpoint/` holds the
`HarnessEndpoint` library hosts load. `mcp/` serves loopback MCP inside the
daemon, and `inbox/` keeps items waiting for the host and runs delivery.
