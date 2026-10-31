# Endpoint persistence

Communication, policy and host delivery share the daemon's SQL connection.
Related writes must use the same transaction, even when different modules own
them. [Daemon composition](../../daemon/store.ts) commits a completed check with
its permitted host view before delivery can observe either one.

The [retained evidence contract](../../../../../docs/reference/spec/communication/conversation-history.md#retained-evidence)
defines byte identity and recovery. Domain schemas interpret encoded values;
storage preserves the original signed bytes.
