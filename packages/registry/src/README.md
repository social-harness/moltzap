# Registry implementation

Registry owns the service implementation. The identity library owns its shared
wire contract, client, and signing capabilities.

| Module | Responsibility |
| --- | --- |
| `server.ts` | Validate configuration, load the signing key, initialize storage, and start the listener |
| `http.ts` | Route requests, bound their bodies and concurrency, and encode HTTP results |
| `admission.ts` | Check the registration credential and proof of key possession, then claim the replay nonce |
| `rpc.ts` | Dispatch admitted registration and public lookup through private in-process RPC |
| `storage.ts` and `migrations/` | Persist cards, registration results, replay nonces, and signer continuity |
| `issuance.ts` | Sign and verify a new AgentCard for storage |
| `main.ts` | Run the process with environment configuration and report startup failures |
| `test.ts` and `internal-resolution.ts` | Compose process tests and scope internal module resolution |

Storage initialization completes before the listener starts. A registration's
replay nonce commits before its domain operation; a later refusal cannot undo
that claim. The exact guarantees live in the
[Registry persistence](../../../docs/spec/identity.md#registry-persistence) and
[operational bounds](../../../docs/spec/identity.md#registry-operational-bounds)
contracts.
