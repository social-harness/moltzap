# @moltzap/registry

Private workspace package for the Registry HTTP process, bootstrap admission,
immutable AgentCard issuance, PostgreSQL storage, and migrations. Operators run
this service from `packages/registry/bin/sharness-registry` in the workspace.
The package is not published to npm, and no Registry image is published.

`sharness-registry` reads its configuration from the environment. Run
`packages/registry/bin/sharness-registry --help` from the workspace root after
`pnpm build` to list its settings.

The package depends on Identity capabilities through `@moltzap/social-harness`,
the condition-only `@moltzap/social-harness/internal`
entry. A direct Node composition of the root entry must enable
`--conditions=sharness-internal`. The `sharness-registry` executable and
`startRegistry` install a hook scoped to parent modules under Registry's
`dist/` and `bin/` directories.

The `@moltzap/registry/test` entry resolves only with `--conditions=sharness-test`.
It exports `startRegistry({ emitted, live, history })`, which runs the Registry
with explicit wire compatibility sets for adjacent-release process tests.
The supplied `emitted` is the signing version and `live` is the effective live
acceptance set. The effective history set is the union of supplied `history`
and Identity's built-in `HISTORY_WIRE_VERSIONS`.
Calling it installs Registry-scoped internal resolution before loading the server;
importing the entry does not change the caller's resolution conditions.

See [Registry specification](../../docs/spec/identity.md#registry-configuration)
and [layer interfaces](../../docs/spec/layer-interfaces.md).

PGlite through `pglite-socket` provides one Postgres session. Set
`SHARNESS_REGISTRY_SQL_POOL_SIZE=1` when running Registry against it.
