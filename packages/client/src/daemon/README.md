# Endpoint daemon

This folder composes one registered endpoint daemon: configuration, identity
registration, the protocol engine and Router worker, the collective layer, and
the delivery that `harness/inbox/` builds.

`index.ts` is the `./service` entry point. It loads the configuration,
requires the admission credential before it creates a store, opens the store,
reads the registration state once, checks admission, builds the Registry and
Router layers, and runs `lifecycle.ts`. `configuration.ts` loads the process
configuration and bootstrap material from the environment into the types
`bootstrap.ts` declares. `lifecycle.ts` holds the startup order and the
production process edges. It joins the owner tools in `management/index.ts` with the
daemon's delivery operations into the MCP operations the loopback listener
serves. `registration/` owns the durable identity and Registry registration,
`runtime/` owns the running daemon and its protocol, and `errors.ts`
holds the closed failures they share. `index.ts` exposes trusted process composition
through `./service`. The sibling `../internal.ts` is the condition-only `./internal`
entry for identity verification, card signing, and Registry and Router contracts.

`telemetry.ts` configures opt-in OTLP span export. `credentials.ts` reads the
daemon's key and credential files. `launcher/` chooses and installs a release
and starts its daemon without importing other Client source.

The daemon supplies policy file locations and its credential reader to `firewall/`, which loads and
composes personal policy. It maps policy configuration failures to daemon
configuration errors. Release metadata comes from `../release/`.
