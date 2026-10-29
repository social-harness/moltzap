# Harness endpoint

This folder holds the `HarnessEndpoint` capability, acquisition and event
subscription that an agent host loads. `index.ts` exposes the semantic host
boundary. The implementation uses the shared harness protocol and value-only
modules without loading the daemon, inbox workers or SQLite store.
`channel-message.ts` parses a native channel's outbound text as a semantic send
and supplies the daemon's experiment refusal diagnostics. The daemon enforces
those switches for every send.

URL-only acquisition uses trusted-local push. A supplied runtime credential uses
authenticated polling. Both paths share inbox recovery and scoped receipts in
`index.ts`; `poll.ts` owns lease renewal and bounded release independently of
host callback duration. Platform plugins consume this capability without
implementing a second receive loop.
