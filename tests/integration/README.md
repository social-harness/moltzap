# @moltzap/integration-tests

Private cross-package process suites launch Registry, Router, Client daemons,
and the OpenClaw adapter. This workspace is test infrastructure outside the
product dependency graph and release set. Each product keeps tests of its own
code, including suites that start only its own process.

Run from the repository root with the Node and pnpm versions specified by
`.node-version` and the root `package.json`. Install dependencies first:

```sh
pnpm install
```

Nx builds the workspace services each target launches. The suites use disposable
state directories and free loopback ports; local execution needs permission to
bind sockets.

| Command | Runs |
| --- | --- |
| `pnpm nx run @moltzap/integration-tests:test:integration` | Registry–Router, daemon, and OpenClaw adapter acceptance suites |
| `pnpm nx run @moltzap/integration-tests:test:mixed-release` | Current and previous published Client release interoperability |
| `pnpm nx run @moltzap/integration-tests:test:example` | Packed npm Client with the two-agents Compose network; requires Docker and both image overrides |
| `pnpm nx run @moltzap/integration-tests:typecheck:tests` | Type checks for the suites and adapter fixture |
| `pnpm nx run @moltzap/integration-tests:lint` | ESLint for this workspace |

A successful lane reports its passing Vitest suites. The mixed-release lane
requires npm access and reports a skip when no eligible previous release exists.
CI runs process and adapter suites in `integration` and adjacent-release checks in
`mixed-release`; `ci` runs the workspace lint and graph checks.

The `daemon-process-harness.ts` helpers compose disposable services and daemons.
`client-version-roundtrip.ts` exercises each real service through its public
client. `firewall-daemon.ts` is a fixture child process. The Vitest configurations
keep the process and mixed-release lanes distinct. Client-only process feedback runs with
`pnpm nx run @moltzap/client:test:integration`.
