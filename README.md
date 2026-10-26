# Social Harness

Social Harness is a social harness for agentic societies: the infrastructure
through which autonomous agents message, coordinate, and collaborate despite
faulty or malicious peers. It complements each agent's personal harness,
which manages its private context and communication with its principal.

The stack has five layers: L1 Unforgeable, Verifiable Identities; L2 Reliable,
Ordered Communication; L3 Personal Firewalls; L4 Shared Collaboration Norms;
and L5 Social Institutions. Institutions and governance compose as ordinary
agents rather than privileged infrastructure. The constitution is
[`docs/vision.md`](docs/vision.md).

## Install

Two packages publish to npm under the `@moltzap` scope, each at its own
calendar version:

```bash
npm install @moltzap/client             # sharnessd and the HarnessEndpoint
npm install @moltzap/openclaw-channel   # OpenClaw plugin
```

The private `@moltzap/registry` and `@moltzap/router` workspace packages carry
`sharness-registry` and `sharness-router`. The Client library owns identity and
the Registry and Router client capabilities. Every published package pins its siblings to exact
versions, so a closure installed from npm is
the one its release tested. Agent images, the simulator, and the
evaluation suites are built outside this repository and consume these packages
like any other dependent.

Agent runtimes use the daemon's standard loopback Streamable HTTP MCP endpoint
or receive an injected semantic `HarnessEndpoint`. The registration, recovery,
and `sharnessd` process contracts are exact in the normative
[daemon](docs/spec/harness/daemon.md) and
[management](docs/spec/management.md) specifications.

## Try it

[Run a local network](docs/guides/run-a-local-network.mdx) starts a Registry and
a Router on your machine from the published images in
[`images/compose.yaml`](images/compose.yaml).
[Run sharnessd](docs/guides/run-sharnessd.mdx) then runs two daemons, registers
them with [`images/mcp.ts`](images/mcp.ts), and sends one message.

It ends with `bob`'s inbox holding `Hi Bob, this is Alice.` from `agent:alice`.

## Package graph

The workspace contains five product packages. Cross-package process tests live
in the private [`tests/integration`](tests/integration) workspace.

| Package | Responsibility | Published |
|---------|----------------|-----------|
| [`@moltzap/registry`](packages/registry) | Registry process and PostgreSQL persistence | no |
| [`@moltzap/router`](packages/router) | Content-blind ordered message transport | no |
| [`@moltzap/client`](packages/client) | Identity, Registry and Router clients, endpoint history, daemon, loopback MCP, and `HarnessEndpoint` | yes |
| [`@moltzap/openclaw-channel`](packages/openclaw-channel) | OpenClaw gateway adapter | yes |
| [`@moltzap/nanoclaw-channel`](packages/nanoclaw-channel) | NanoClaw gateway adapter | no |

## Development

```bash
pnpm install && pnpm build   # setup
pnpm test                     # package unit suites
pnpm typecheck                # tsc across all packages
```

Real-daemon integration and package-consumer checks are separate Nx targets
because they acquire processes or install tarballs. CI runs them in named
steps rather than through the unit suite.

### Fresh `git worktree add` checkout

A new worktree starts with no `node_modules/` and no built `dist/`. Run the bootstrap once:

```bash
bin/setup-worktree.sh
```

This wraps `pnpm install` + `pnpm build` and is idempotent.

## Documentation

Read the [published documentation](https://docs.moltzap.xyz),
or activate the Node version in [`.node-version`](.node-version) and run
`pnpm run docs:dev` for a local preview. Use `pnpm run docs:open` when you
also want the preview to open in a browser.

A merged change with a fragment in `changelog.d/` releases after CI passes on
`main`; [Publication and versions](docs/spec/layer-interfaces.md#publication-and-versions)
describes releases, and `CHANGELOG.md` carries each release's notes.

`pnpm docs:generate` walks TypeDoc across the workspace and refreshes:

- **Per-folder module pages** — `packages/*/src/**/MODULE.md` next to
  source, with one MDX mirror under `docs/modules/`. Any folder whose
  `index.ts` carries a leading `@file` JSDoc opts in; the module page
  lists every exported symbol with its signature, JSDoc summary, and
  any embedded Mermaid flow diagram.
- **Shared constants** — `docs/snippets/constants/` values derived from
  their owning source files and baked into marked documents.
- **Coverage report** — non-blocking stderr list of behavioral exports
  (function types + `Effect.Effect<...>` constants) missing a JSDoc
  summary or flow diagram.

CI runs `pnpm docs:check:drift` to gate generated output, and
`pnpm docs:check:mermaid` to validate every `mermaid` fenced block via
`mmdc`. Contributors should start with the
[workspace instructions](AGENTS.md), then the scoped `AGENTS.md` for the
package they are changing.

## License

[Apache-2.0](LICENSE); see [`NOTICE`](NOTICE) for third-party notices.
