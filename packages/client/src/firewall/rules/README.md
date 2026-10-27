# Built-in firewall rules

`index.ts` exposes the registrations policy composition selects.
`builtin.ts` supplies credential, plain-language, acknowledgement,
open-request and allowed-sender policies. `collective-norms.ts` combines code
and English rules for collective participation; it reads open requests through
`open-requests.ts`, as the built-in does, and the Client release from
`../../release/` for revision and provenance bytes. `outcome.ts` holds shared
rule results and digest construction. The bundle's English norms also ship as
`BEHAVIOR.md` files under `packages/client/behaviors/collectives/`.

See the [message-policy specification](https://github.com/social-harness/moltzap/blob/main/docs/spec/harness/message-policy.md#message-policy-file).
