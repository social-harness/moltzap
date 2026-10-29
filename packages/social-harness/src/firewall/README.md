# Personal message firewall

The firewall connects policy assessment to the daemon's send and receive
boundaries. A change to what a rule concludes belongs in evaluation. A change
to when a message becomes visible or an intent becomes durable belongs in
admission. Keeping those responsibilities separate lets offline experiments
exercise the same evaluator without acquiring endpoint state.

When adding assessment data, follow it through both retained audit and host
projection. The host-facing outcome must select permitted advice explicitly,
because the evaluator also handles evidence that the host may not receive.
Policy loading decides which rules and provider are installed, rather than
giving the evaluator access to configuration files or credentials.

The [message policy contract](../../../../docs/reference/spec/harness/message-policy.md)
owns assessment, admission and visibility guarantees.
