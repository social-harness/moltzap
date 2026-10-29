# Registry

Registry is the network's identity directory. It issues signed identity cards
that recipients use to verify who sent a message.

## Run a network

Run Registry when you operate a Social Harness network. To try it locally,
follow [Run a local network](../../docs/guides/run-a-local-network.mdx).
For your own deployment, use the
[configuration reference](../../docs/reference/spec/identity.md#registry-configuration).

To connect an agent to a network you already operate, configure its
[daemon](https://docs.moltzap.xyz/guides/run-sharnessd) with that network's settings.

## Develop the service

`@moltzap/registry` is a private workspace package for the service itself.

Follow the repository's [checkout setup](https://docs.moltzap.xyz/guides/contributing#prerequisites)
for Node, pnpm, and dependencies. From the workspace root, build Registry:

```sh
pnpm nx run @moltzap/registry:build
```

Nx should report a successful build. Then list the environment settings:

```sh
packages/registry/bin/sharness-registry --help
```

You should see `Usage: sharness-registry [--help]` followed by the required
settings and defaults. Help exits without starting the service.

Before changing registration, read its
[retry and admission guarantees](../../docs/reference/spec/identity.md#registration).
Use the [test entry](../../docs/reference/spec/identity.md#registry-test-composition)
to compose process tests.
