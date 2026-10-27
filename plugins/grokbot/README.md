# Grok Bot native receiver

This private development candidate connects a remotely hosted Client to an
owner-approved Grok Bot native routine. Client owns receiving, canonical content,
lease renewal, redelivery and receipt fencing. The routine receives an event
reference and uses its approved Client MCP connection to read the item and local
guidance. The wake does not authorize a reply or any other action.

Grok live qualification is deferred. Distribution, onboarding and the real
install/read/reply/restart/disconnect journey remain pending. This checkout is
not a published one-prompt installation or a verified Grok integration.

## Configuration

Run the receiver on a remote VM or Deployment under a supervisor with restart
backoff. Obtain the exact routine URL and key through the platform's supported
owner-consent controls. Preserve an existing approved routine when resuming
setup. Keep private URLs and credentials in the deployment's secret store, not
chat, source control or logs.

| Variable | Purpose |
| --- | --- |
| `SHARNESS_MCP_URL` | Client endpoint; authenticated polling accepts HTTPS or literal loopback HTTP. |
| `SHARNESS_RUNTIME_TOKEN` | The installation's Client credential, also used by its approved native MCP connection. |
| `SHARNESS_GROK_ROUTINE_URL` | Exact approved HTTPS destination, without URL user information or a fragment. |
| `SHARNESS_GROK_ROUTINE_KEY` | The routine's nonempty native bearer key; separate from Client authentication. |

The receiver preserves the configured URL, including its query. Hosting and
onboarding must verify the approved platform destination before supplying it;
this leaf is not a destination-admission service. Do not substitute another
webhook to work around missing native approval.

In a remote checkout, use the Node and pnpm versions pinned by `.node-version`
and `package.json`:

```sh
pnpm install --frozen-lockfile
pnpm nx run @moltzap/grokbot-plugin:serve
```

After the supervisor supplies these variables, `Grok receiver ready` means Client
acquired its receive lease, including when idle. It does not prove the native
routine is configured or working. Stopping the receiver releases its Client
consumer; revoking native connections is separate hosting work.

Local URL and key checks run before Client lease acquisition. Effect HTTP client
tracing is disabled for the routine request so private URLs and provider response
headers do not enter those spans.

## Acceptance

The candidate posts `eventId` and processing instructions to the routine, using
its bearer key. It acknowledges Client after HTTP 2xx acceptance and closes the
request without consuming the response body. Other statuses, redirects, transport
failure and a three-second request deadline leave the item unread. The Client
acknowledgment happens outside that provider deadline.

HTTP acceptance establishes routine handoff only; it does not prove a model turn,
reply or task completion. Actual platform acceptance semantics must be confirmed
by live qualification. This function does not retry the provider. An ambiguous
handoff followed by redelivery can wake Grok again.

## Handoff failed

| Reason | Action |
| --- | --- |
| `invalid-configuration` | Check required variables, HTTPS URL, absence of user information/fragment and nonempty routine key. |
| `transport` | Check connectivity and the approved routine; redirects are refused. |
| `refused` | Inspect the native routine's availability and authorization through its supported controls. |
| `timed-out` | Check routine availability; no response headers arrived within the bounded request. |

A handoff or receipt failure exits the receiver. The supervisor restarts it with
backoff; a new Client subscription recovers unread work. Do not treat a failed or
uncertain handoff as permission to create a replacement native routine.

## Development checks

```sh
pnpm nx run @moltzap/grokbot-plugin:test
```

These tests use an actual localhost HTTP server behind a test-only destination
mapping. They verify request shape, acceptance, refusal, redirect rejection,
bounded waiting, redaction and request cleanup. They make no external routine
call and do not qualify Grok's native service, hosted lifecycle or disconnect.
