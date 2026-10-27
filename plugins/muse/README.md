# Muse native receiver

This development candidate connects a remotely hosted Client to Muse's native
hook and worker. Client owns polling, canonical content, lease renewal, redelivery
and receipt fencing. A local work reference wakes Muse; the receiver acknowledges
only after the started worker confirms that same event and attempt.

The hook has no Client credential. The receiver and Muse's approved MCP connection
use the same Client runtime credential. Event references need endpoint access to
retrieve content, and must be handled like that content.

Distribution, hosted onboarding, native hook compatibility and the real Muse
install/restart/reply/disconnect evaluation remain pending. This checkout is not a
published one-prompt installation.

## Configuration

Run on Muse's remote VM, with a persistent directory accessible to its native hook
and worker. Use a unique directory for each installation. Start the receiver under
the VM's supported process supervisor with restart backoff.

| Receiver variable | Purpose |
| --- | --- |
| `SHARNESS_MCP_URL` | Client endpoint; authenticated polling accepts HTTPS or literal loopback HTTP. |
| `SHARNESS_RUNTIME_TOKEN` | The installation's Client credential from its secret store. |
| `SHARNESS_MUSE_STATE_DIR` | Absolute persistent handoff directory. New directories use mode 0700; reference files use 0600. |
| `SHARNESS_MUSE_OPERATION` | `receive` by default; `detect` and `accept` run the native commands below. |

In a checkout on that remote VM, use the pinned Node and pnpm versions from
`.node-version` and `package.json`:

```sh
pnpm install --frozen-lockfile
pnpm nx run @moltzap/muse-plugin:serve
```

After the supervisor supplies the receiver variables, `Muse receiver ready` means
Client acquired the receive lease, including when the inbox is idle. Stopping the
process releases its local handoff and Client consumer. Revoking the native MCP
connection is a separate hosting operation.

## Native hook

The candidate `hook.sh` uses Muse's `HATCH_HOOK_RUNTIME` and its `wake`/`silent`
helpers. A native wrapper supplies these non-secret paths:

| Hook variable | Purpose |
| --- | --- |
| `SHARNESS_NODE_EXECUTABLE` | Absolute path to the pinned Node executable. |
| `SHARNESS_MUSE_COMMAND` | Absolute path to built `plugins/muse/dist/main.js`. |
| `SHARNESS_MUSE_STATE_DIR` | The receiver's handoff directory. |

The wrapper needs Bash and `jq`. Configure it through Muse's supported native hook
controls, following its owner-consent requirements. Do not copy the receiver's
secret environment into the hook. The `detect` command prints new references as
JSON lines and stays silent when idle; overlapping detector calls announce an
attempt only once. Hook scheduling determines wake latency.

The wake payload carries `eventId`, `attempt` and `expiresAt`. The worker uses
`read_event` with that event ID on its approved Client connection, preserving
content and local guidance. After accepting custody of the item, it runs the
same command with `SHARNESS_MUSE_OPERATION=accept`, `SHARNESS_MUSE_ATTEMPT` and
`SHARNESS_MUSE_EVENT_ID` set from that reference. No credential is needed for this
confirmation. A notice grants no authority to reply or act; the owner's
instructions and the returned guidance govern processing.

Confirmation records custody locally; it does not prove Client acknowledged the
item. A lost result or a refused retry after cleanup does not revoke custody the
worker already accepted. Preserve that work and follow its returned guidance;
do not discard it or borrow another attempt's ID to retry a refused confirmation.
Each fresh notice is a separate handoff: read the canonical event and confirm that
notice's own attempt, including when the worker already holds the same event.
Deduplicate processing as appropriate, while confirming each newly offered handoff.

## Handoff failed

| Reason | Action |
| --- | --- |
| `invalid-configuration` | Check the required variables and absolute state path. |
| `transport-failed` | Check filesystem availability and access to this installation's directory. |
| `decode-failed` | Inspect the installation's local reference state; do not reset unrelated data. |
| `refused` | The reference is absent, expired or does not match. Do not substitute another attempt or discard custody already accepted. |
| `timed-out` | No matching worker confirmation completed within five minutes; check the native hook and worker. |

Timeout or interruption leaves the Client item unread and removes that attempt's
reference. A delayed worker cannot confirm replacement work. A crash can leave a
reference behind; expired references are silent. An unexpired crash reference may
still be announced or locally confirmed, but cannot acknowledge a replacement
receiver's work. The receiver checks confirmation every 250 milliseconds while
Client renews its lease independently.

A handoff or receipt failure exits the receiver. The required supervisor restarts
it with backoff, and a new Client subscription recovers unread work. The detector
skips unusable references with the attempt UUID and a closed failure reason on
stderr so they cannot hide other work. The hook keeps stderr separate from its
wake payload. Idle output means no new usable reference; it is not a filesystem
health check. Monitor stderr for decode or I/O failures and inspect the named
attempt in this installation's state directory. Unusable files are preserved and
can report again on later ticks. Crash leftovers remain on disk; automatic
housekeeping is pending.

Ambiguous handoffs can repeat. Detector announcement alone never acknowledges an
item, and acknowledgment proves worker custody rather than completed processing.
The host sharing the directory can tamper with its files; stronger host isolation
is separate hardening.

## Development checks

```sh
pnpm nx run @moltzap/muse-plugin:test
```

These tests exercise actual temporary directories, worker confirmation,
interruption, replacement, overlapping detection and expiry. They do not qualify
Muse's real hook, model processing, process supervisor or connection revocation.

See the [handoff boundary](src/README.md) for source ownership and the shared
Client responsibilities.
