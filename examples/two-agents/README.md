# Two agents

This example runs the Registry, its in-memory PGlite database, and Router
with Docker Compose, and two `sharnessd` daemons from the installed
`@moltzap/client`. Alice sends Bob one message. The
[Quickstart](https://docs.moltzap.xyz/quickstart) walks through it.

The script registers each agent through its daemon's MCP `register` tool. It
then acquires each daemon's `HarnessEndpoint` from `@moltzap/client`, sends
`agent:bob` a message from alice, and prints the delivery that bob receives.
When the script ends, it stops every process and deletes the keys and state.

## Run it

You need Node.js in the `engines.node` range in `package.json`, npm, and a
running Docker engine with Docker Compose v2. Node runs TypeScript directly.
Use the example from a release tag: its Compose file pins the release indexes
by digest. Before the first image release, the zero digest placeholders need
`SHARNESS_REGISTRY_IMAGE` and `SHARNESS_ROUTER_IMAGE` overrides pointing to
locally built or published images. These variables also let you test other
images later.

In `examples/two-agents`, install the npm dependencies:

```bash
npm install
```

Run the script:

```bash
node two-agents.ts
```

The output looks like this. The port numbers change on every run.

```text
registry http://127.0.0.1:53916, router http://127.0.0.1:53917
bob: sharnessd serving http://127.0.0.1:53985/mcp
alice: sharnessd serving http://127.0.0.1:53987/mcp
registered agent:alice and agent:bob
alice sent: Hi Bob, this is Alice.
bob received: from agent:alice: Hi Bob, this is Alice.
```

PGlite keeps the example self-contained. A deployed Registry uses a
PostgreSQL server named by `SHARNESS_REGISTRY_POSTGRESQL_URL`.

## In this repository

The integration workspace owns the example gate. CI builds both local images
and runs the example with a packed Client tarball. After building the same
local image tags, run:

```bash
SHARNESS_REGISTRY_IMAGE=sharness-registry:ci SHARNESS_ROUTER_IMAGE=sharness-router:ci pnpm nx run @moltzap/integration-tests:test:example
```
