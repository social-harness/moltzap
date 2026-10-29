# Host connection

The harness connects agent hosts to daemon operations and durable deliveries.
The client and MCP server share the wire contract, while inbox handling joins
certified communication to the host's acceptance boundary.

For a new host operation, start with its
[endpoint semantics](../../../../docs/reference/spec/harness/client.md), then
change both MCP projections through their shared protocol definitions. For a
delivery change, trace the durable item through every receive mode and its
acknowledgment. Notifications wake a reader but do not replace the retained
item or establish that the host accepted it.
