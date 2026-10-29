# Policy installation and edits

Policy composition joins operator configuration, resolved behavior text and
persisted owner rules into one immutable installation. Decide which owner may
change a new setting before adding it. Process configuration and owner edits
have different lifetimes and authorities.

File loading resolves behavior paths before trusted composition. Owner edits
build a replacement chain, persist the new rules, then swap the active
installation. Keep that order when changing edits or recovery so cancellation
cannot leave stored rules and active checks describing different policies.
An in-flight check retains the installation it captured.

The [policy contract](../../../../../docs/reference/spec/harness/message-policy.md)
defines file inputs, editable rules and persistence behavior.
