# Personal message firewall

The firewall assesses exact prepared messages against explicitly configured
rules. A check captures its rules and permitted evidence once. Construction
owns the active rule value and durable edits, while daemon delivery owns when
an assessed message becomes visible or an accepted intent becomes durable.
Offline checking uses the same evaluation operation with an injected provider.

Configuration files and rule documents are package assets under `config/firewall/`.
Applications select them explicitly or supply their own files. The evaluator
receives validated data and cannot acquire provider credentials or read policy
files. Agent-visible advice selects registered text and permitted references;
private assessment evidence stays private.

The [message policy contract](../../../../docs/reference/spec/firewall/message-policy.md)
owns assessment, admission and visibility guarantees.
