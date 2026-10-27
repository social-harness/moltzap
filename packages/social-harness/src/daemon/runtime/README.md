# Running daemon

This folder owns the daemon once it runs: its registration state, the
activation gate, the MCP subscription, the delivery passes, and the fatal
signal that stops the process.

Start with `index.ts`. The daemon starts from the registration state the
daemon read at startup. A registration switches it to active as soon as the
binding commits, before the protocol finishes activating, so status reports
the binding at once. The MCP catalog reads whether the protocol is up, so the
post-registration tools appear once activation acquires it, and the daemon
then tells listening hosts the tool list changed. A failure or defect in a
registration's activation stops the daemon, since the binding is durable.
Activation runs under one gate, so registration and restart never
acquire a second protocol. `protocol.ts` acquires the Router worker, the
engine and the collective layer for one identity, pins the sender cards that
stored memberships name, and supervises the worker and outbound fibers. Only
`index.ts` imports it.
