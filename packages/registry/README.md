# @moltzap/registry

Registry issues immutable AgentCards and resolves them by exact AgentId or
AgentName. This private workspace package owns the HTTP process, bootstrap
admission, PostgreSQL storage, and migrations.

The service ships as the `ghcr.io/social-harness/registry` container image;
the package is not published to npm. To try it with a Router, follow
[Run a local network](../../docs/guides/run-a-local-network.mdx).

For a source checkout, install the repository's dependencies and run these
commands from the workspace root:

```sh
pnpm nx run @moltzap/registry:build
```

Nx should report a successful build. Then list the environment settings:

```sh
packages/registry/bin/sharness-registry --help
```

You should see `Usage: sharness-registry [--help]` followed by the required
settings and defaults. Help exits without starting the service. The
[configuration reference](../../docs/spec/identity.md#registry-configuration)
defines validation and the pool setting required for PGlite.

A direct Node import of `@moltzap/registry` requires
`--conditions=sharness-internal`; the executable installs its own scoped
resolution. Process tests use `@moltzap/registry/test` with
`--conditions=sharness-test`, as the
[test-composition contract](../../docs/spec/identity.md#registry-test-composition)
describes.

See the [source map](src/README.md) for implementation ownership and the
[identity specification](../../docs/spec/identity.md) for the service contract.
