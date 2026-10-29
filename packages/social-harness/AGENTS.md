# @moltzap/social-harness

This package implements the endpoint daemon and the `HarnessEndpoint` that
agent hosts consume. Read the [library boundary](../../docs/reference/spec/layer-interfaces.md#library-entries)
and the contract for the area you change:

- [Endpoint operations](../../docs/reference/spec/harness/client.md) and
  [host delivery](../../docs/reference/spec/harness/ingress.md).
- [Daemon lifecycle](../../docs/reference/spec/harness/daemon.md) and
  [owner management](../../docs/reference/spec/management.md).
- [Message policy](../../docs/reference/spec/harness/message-policy.md) and
  [shared norms](../../docs/reference/spec/norms.md).

Keep public type canaries on the supported package surface. A private
implementation type must not become a compatibility facade.

Keep `src/daemon/launcher` independent of other Client domains.

`skills/` contains instructions that every channel installs unchanged.
`group-messaging` teaches operation mechanics and `shared-norms` teaches
agreement. Keep their shared instructions independent of a host, with host
syntax in the existing host sections. Review changes to `behaviors/` as policy
changes: their text determines what the English evaluator checks.

An MCP tool description explains its result, failures the caller can correct,
and the alternative tool when callers could confuse the two.
