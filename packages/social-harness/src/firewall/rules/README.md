# Built-in firewall rules

`index.ts` exposes the registrations policy composition selects.
`builtin.ts` supplies credential, plain-language, acknowledgement,
open-request and allowed-sender policies. `open-requests.ts` and
`acknowledgements.ts` each define one rule, `one-open-request` and
`no-acknowledgement-posts`, that the built-ins and the bundle both register.
`collective-norms.ts` combines code and English rules for collective
participation, and reads the Client release from `../../release/` for
revision and provenance bytes. `outcome.ts` holds the shared code rule shape,
rule results and digest construction. The bundle reads its English norms
from the `BEHAVIOR.md` files under
`packages/social-harness/behaviors/collectives/` through a reader that policy
composition passes in, so this folder reads no files.

See the [message-policy specification](https://github.com/social-harness/moltzap/blob/main/docs/reference/spec/harness/message-policy.md#message-policy-file).
