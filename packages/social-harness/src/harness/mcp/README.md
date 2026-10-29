# Daemon MCP boundary

The MCP boundary projects daemon operations for owner and runtime callers.
When adding a tool, review its credential role and registration state before
adding it to the catalog. A valid input shape alone does not establish that a
caller may invoke the operation.

Push, polling and webhook receiving share the daemon's inbox and exclusive
consumer ownership. A change to one transport must preserve the ownership and
acknowledgment behavior seen by the others. Keep message classification and
policy admission in the shared delivery path so a new transport cannot bypass
them.

The [management contract](../../../../../docs/reference/spec/management.md) and
[ingress contract](../../../../../docs/reference/spec/harness/ingress.md) own
the tool and receive interfaces.
