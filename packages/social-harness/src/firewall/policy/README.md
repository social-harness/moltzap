# Firewall policy

`document/index.ts` holds the `MessagePolicy` document schema and maps a
`BEHAVIOR.md`, from a policy file, the package's own `behaviors/` or
`policy_update`, to its rule. `load.ts` reads the
policy document and decision-provider key. `compose.ts`
constructs the installed middleware chains from the document and built-in
rules in `../rules/`. `configuration.ts` owns the policy file locations and
closed configuration error. The service maps that error to its daemon error.
`editable.ts` persists owner edits before swapping immutable active chains.

See the [message-policy specification](https://github.com/social-harness/moltzap/blob/main/docs/reference/spec/harness/message-policy.md#message-policy-file).
