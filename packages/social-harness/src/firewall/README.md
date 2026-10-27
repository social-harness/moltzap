# Personal firewall

This folder owns the personal firewall: evaluation, built-in rules, policy
loading and editing, incoming and outgoing admission, and retained checks.
`index.ts` is its entry for the rest of Client.

| Folder | Holds |
| --- | --- |
| `outcome/` | Runtime-safe check references, guidance, withheld text and send refusals. Communication and hosts read these values without loading the firewall implementation. |
| `evaluator/` | Ordered code and English middleware, decisions, questions and provider integration. |
| `rules/` | Built-in code policies and the collective norm bundle. |
| `policy/` | Policy documents, loading, composition and persisted owner edits. Configuration errors belong to policy loading. |
| `admission/` | Installation, outgoing checks, incoming admission, result checks and retained check values. |

Rules, policy and admission sit above `communication/collectives/`. `outcome/`
and the isolated `evaluator/` sit below certified records. Client release
metadata comes from `../release/`. Store owns persistence in
`communication/store/firewall.ts`, and MCP owner tools live in `harness/mcp/tools.ts`.

See the [message-policy specification](https://github.com/social-harness/moltzap/blob/main/docs/spec/harness/message-policy.md).
