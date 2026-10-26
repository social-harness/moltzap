Breaking harness interface change: remove `SHARNESS_FIREWALL_AUDIT_EXPORT`, the `Daemon.FirewallOptions.auditExport` service option, and the `FirewallAuditRecord` schema and type exports from `@moltzap/client/service`. Operators read `firewall_decisions` for recent decisions and activations and the history export for certified conversation records.

The daemon ignores `SHARNESS_FIREWALL_AUDIT_EXPORT`; unset it and delete any previously published snapshot and its `.partial` file, which hold private provider traces.
