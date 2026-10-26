# @moltzap/nanoclaw-channel

NanoClaw channel adapter and integration canary. Publication follows `docs/spec/layer-interfaces.md` → Publication and versions: this package stays private and is consumed by the NanoClaw agent-image build, not from npm.

## Cutover boundary

This adapter consumes public `@moltzap/client` capabilities only. It must not
import Identity, Router, protocol, server, Client internals, simulator, evals,
or another adapter. NanoClaw creates it through the native channel registry,
and it acquires one `HarnessEndpoint` from the configured loopback MCP URL. It
does not acquire a daemon, profile, Registry admission material, signing key,
raw Router credential, network client, or local store.

The source under this package is the final cutover adapter against the reduced
`HarnessEndpoint`. Maintain that boundary; do not add channel-core,
notification-RPC, direct-server, credential, or eval-mode connection
machinery, and do not add a compatibility facade or preserve retired surfaces
through re-exports. Publication does not change this package boundary.

## Host integration law

- Keep NanoClaw's `ChannelAdapter` entry point and host-relative stub modules
  aligned with the stock NanoClaw API. The pinned source overlay may only let
  outbound `send_message` and `<message to>` destinations recognize a
  syntactically valid Client `MessageAddressInput` before friendly aliases and
  let that validated route reach this channel, with an accurate capability line
  in the existing destination prompt. The image, not the overlay, copies the
  OpenClaw plugin's skills into NanoClaw's shared container skills
  unchanged. Do not extend the host ABI, inbound
  router, inbox, session model, persistence, retry policy, or runtime driver.
- Render each inbound item kind in one fixed form, switching on `kind`
  exhaustively. A multicast's direct input identifies the sender and `agent:`
  address; its group input retains the canonical group address, sender, exact
  members, and native group flag.
- NanoClaw owns friendly-name discovery and its own destination permissions.
  An explicit `agent:` or `group:` Social Harness address input needs no prior
  NanoClaw conversation or ACL row; Client validates and canonicalizes it.
- Leave outbound queue and retry policy to NanoClaw. Every adapter call is one
  Client operation, decoded from the `messages_out` content's text; do not pass `messages_out.id` or
  add adapter deduplication. `send_message` has returned before the adapter
  sends, so a gather, all_gather or response reports a refusal as an `operationFailed`
  item and its delivery completes. A send whose call fails for a reason in the
  adapter's `FINAL_REFUSALS` reaches the model and its delivery completes; any
  other failed call fails the delivery.
  Project metadata before content, route through the bootstrap-owned main
  session with NanoClaw's native reply override, and await the host callback
  before acknowledging Client delivery. Do not add `accepted`/`pending`
  results or inspect NanoClaw persistence.
- NanoClaw owns sessions, implicit replies, prompt and final-text behavior
  beyond the explicit-address capability and route, inbox replay, scheduling,
  and runtime isolation.
- Discovery, search, history, status, registration, and proof inspection use
  MCP rather than `HarnessEndpoint`.
- Keep host-shape failures distinct from closed Client failures without
  exposing private action evidence, credentials, or protocol state.

Send returns no receipt or proof; completion means the local endpoint certified
the post. `ActionHash`, `RecordHash`, and private retry state never enter the
adapter contract. Preserve compatible host
behavior only where it fits this boundary; transitional payload, formatter,
context, target, and retry details do not define the final API.

## Tests

- Integration tests enter through NanoClaw's generic `send_message`, cross its
  native outbound queue and host delivery loop, and observe the receiving
  Client. They must not call the concrete adapter or inject an endpoint.
- The packaged image keeps the final Client boundary; it must not restore
  dependencies on deleted protocol/server packages, profiles, raw Router
  credentials, or compatibility shims.
- Run package tasks through Nx from the workspace root.
