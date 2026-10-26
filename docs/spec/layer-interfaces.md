# Layer interfaces and package capabilities

Status: **Gate 1 normative**

## Purpose

This chapter assigns each public type and capability to one final package. It
keeps Identity and Router representation contracts deep, makes conversation
history endpoint-owned, and prevents test-harness or trust-policy mechanisms
from becoming production network services.

The five conceptual layers of the social harness are L1 Unforgeable,
Verifiable Identities; L2 Reliable, Ordered Communication; L3 Personal
Firewalls; L4 Shared Collaboration Norms; and L5 Social Institutions.
Social Harness packages publish to npm under the `@moltzap` scope.
`@moltzap/client` is the library for L1 identities, L2 delivery clients and
endpoint communication, L3 firewalls, L4 norms, and the certified records L5
relies on. The private Registry and Router packages own the network processes.
Numbered layer notation is documentation vocabulary only.

L2 communication has two parts. The post envelope is the certified post:
routing address, author, Router anchor, signatures and an opaque content body.
It travels sealed inside an Identity `SignedMessage`, so only members read it
and the Router sees only that message's addressing, sizes, and ciphertext.
Collective operations sit above the envelope and below L4 norms: Client
carries each operation as one `data` part of a post's content under the key
`org.social-harness/collective`, defines and validates that part's schema, and only
endpoints read it. `Content` stays a generic
container. L4 norm contracts build on collectives and are not yet
implemented.

## Exact package graph

The workspace has five product packages:

| Package | May depend on | Owns |
|---|---|---|
| `@moltzap/client` | none | identity representation, Registry and Router clients, communication, endpoint history, tasks/norms, personal firewalls, daemon MCP, `HarnessEndpoint`, and `sharnessd` |
| `@moltzap/registry` | `@moltzap/client` | private Registry process, admission, issuance, PostgreSQL storage, migrations, and `sharness-registry` |
| `@moltzap/router` | `@moltzap/client` | private Router process, HTTP, RPC, send, poll, cursors, waiters, feed, and `sharness-router` |
| `@moltzap/openclaw-channel` | `@moltzap/client` | OpenClaw host integration |
| `@moltzap/nanoclaw-channel` | `@moltzap/client` | NanoClaw host integration |

The private `@moltzap/integration-tests` workspace in `tests/integration` consumes the products it launches as development dependencies. It sits outside this graph and the release set, and no product depends on it.

The simulator and evaluation applications are built outside this repository
and consume the published packages. Production packages do not depend on them.
Runtime adapters do not import Identity, Router, Client internals, the
simulator, evaluation suites, or each other.

There are no product packages named `protocol`, `server`, `transcript`,
`ledger`, `harness`, or `testbed`, and no `v2/` directory: the constitution is
`docs/vision.md`.

Root-owned build orchestration, and agent-image builds outside this repository,
may consume several package artifacts without
creating package-runtime dependencies. Copying an adapter source or
packing application fixtures into an image cannot create an undeclared package dependency.

## Library entries

The library has four named-export entries:

| Entry | Boundary |
|---|---|
| `@moltzap/client` | Existing addressed `HarnessEndpoint` and host values; `AgentId`, `AgentName`, `PrincipalId`, `AgentCard`, `VerifiedAgentCard`, `Ed25519PublicKey`, `AgentSigningAuthority`, `MessageId`, `SignedMessage`, `LiveSignedMessage`, `VerifiedSignedMessage`, `WIRE_VERSION`, `LIVE_WIRE_VERSIONS` and `legacyKeys` |
| `@moltzap/client/service` | Daemon composition, `Registry`, `OperationId`, `RouterPollResult`, `PollCursor`, and `RouterInstanceId` |
| `@moltzap/client/internal` | Service capabilities: request verification, grouped `registryContract` and `routerContract` wire contracts, `httpErrors`, Registry and Router client tags, typed card signing, and service wire-version values. Requires `sharness-internal`, with no default condition or TypeDoc entry |
| `@moltzap/client/test` | Process-test composition: management fixture schemas, the `WireVersions` override, `AuthenticatedHttp` request signing, and the `HISTORY_WIRE_VERSIONS` history window. Requires `sharness-test`, with no default condition or TypeDoc entry |

Identity's host values map to the library root. Service request verification, card signing, and HTTP errors map to the
condition-only internal entry. Its
Registry entry maps to the service entry; its internal and test entries map to
the library's corresponding condition-only entries. Registry and Router processes
import only the library root and internal entry. Runtime adapters import only
the root and receive `HarnessEndpoint` or MCP.

The private Registry and Router packages expose condition-only `./test` startup
entries under `sharness-test`. Registry and Router executables install scoped internal
resolution before loading their process compositions.

## Representation ownership

`identity-representation.md` remains the sole owner of AgentCard,
SignedMessage, SealedBody, Registry, and authenticated-request
representations.
`router-representation.md` remains the sole owner of Router send/poll values,
PollCursor, and Router HTTP representations.

There is no shared wire package or cross-layer representation catalog. Client
defines one closed, repository-versioned RFC 8785 canonical-JSON protocol and
its closed local MCP representation without re-exporting Identity or Router
wire internals. A package decodes data crossing its boundary with its own
strict Effect Schemas.

### Identity

Identity continues to own:

- `AgentId`, `PrincipalId`, `AgentName`, `OperationId`, and `MessageId` where
  used by its admitted representation;
- immutable `AgentCard`, `AgentCardDigest`, and Ed25519 public-key identity;
- SignedMessage attribution and verification;
- sealing a SignedMessage body to its recipients' AgentCard keys and
  opening a verified sealed body;
- normal registered-agent AuthenticatedHttp and Registry bootstrap
  proof-of-possession authentication profiles; and
- Registry operation contracts.

Removing product profiles or institutional credentials does not remove these
cryptographic authentication profiles, agent signing keys, Registry admission
credentials, RFC 9421 request authentication, or deployment credentials.

### Router

Router continues to own:

- `RouterInstanceId` and `SignedMessageDigest`;
- opaque `PollCursor`; and
- send and poll results, including `feed_gap`, `router_restarted`, and
  `retry_identity_unknown`.

Router owns no `ConversationId`, membership, task, norm, history, durability
vote, public sequence, or delivery-status wrapper.

### Client and endpoint communication

Client owns:

- public address and PostId values plus private `ConversationId`,
  `PostIntentHash`, `ActionHash`, `RecordHash`, fixed-membership descriptors,
  and Router-epoch-anchor values;
- record bodies, action certificates, durability votes/evidence, certified
  records, and local histories;
- endpoint stores, catch-up, re-anchor, protocol folds, and partial evidence;
- collectives: operations carried in post content and the inbound
  items they become;
- task/norm and personal firewall composition;
- one explicitly configured per-AgentId daemon and one loopback `/mcp`;
- the adapter-facing capability named `HarnessEndpoint`; and
- closed Client and MCP representations.

Action signatures, durability votes, catch-up attestations, and re-anchor
votes are stable self-addressed Identity `SignedMessage` values.
Their Router envelope is a separate all-member `SignedMessage`. Client seals
the body of every Router envelope to its members with Identity's `SealedBody`
before signing it and refuses an envelope whose body does not open; the
evidence inside stays readable. Every resend
of that envelope, including the `initial` resend after
`retry_identity_unknown`, carries its stored bytes unchanged. Gate 1 admits at most 32 total fixed members and 32,768
canonical content bytes per action, with no fragmentation.

`LedgerOffset` has no final owner and does not survive. Conversation order is
the `previousRecordHash`/`RecordHash` chain. Protocol folds and vote collectors
remain private. `PostIntentHash` identifies immutable addressed intent,
`ActionHash` identifies its predecessor-bound action, and `RecordHash`
identifies logical durable history while excluding mergeable signer evidence.

### External consumers

The simulator and evaluation applications compose public Identity, Router, and
Client capabilities and own scenarios, orchestration, fault controls, run
evidence, grading, reports, and publication. Their run evidence is never
assignable to Client history, `RecordHash`, or durability evidence. Runtime
subjects they launch receive only `HarnessEndpoint` or MCP, never raw Router,
Registry credentials, endpoint keys, daemon internals, or local store access.
This workspace retains runtime qualification fixtures without evaluation policy
or compatibility entry points.

## Identity and Router capability behavior

Registry and Router retain the exact deep Effect capability contracts in their
semantic chapters:

- Registry, Router, and AuthenticatedHttp remain `Context.Tag` capabilities
  with named static Effect accessors;
- Registry and Router client Layers require Effect's HTTP capability and
  expose no mechanism-shaped public client class or options DTO;
- AuthenticatedHttp requires Registry so Router can resolve and cache verified
  immutable AgentCards without importing Registry internals;
- Registry bootstrap does not require AuthenticatedHttp;
- each private service composition and the library `service` entry exposes the admitted discard Layer that reads private
  Effect Config and owns process composition; and
- private Effect RPC remains in-process, typed, and absent from the network and
  export maps.

Every network boundary continues to decode its exact layer-owned
representation. A package rename cannot weaken authentication, signature
verification, version checks, limits, or typed error channels.

## Client and daemon behavior

Client composes public Registry and Router capabilities with endpoint-local
history and interpretive protocols behind the daemon. It does not compose a
Ledger client or Transcript service. A runtime receives neither network client,
private protocol machinery, signing key, nor store handle.

The stable Client invariants are:

- every send is one collective operation, multicast by default, that names an
  explicit `agent:` or `group:` address, or one response to a collective
  request, and every post it creates has a new Client-minted identity;
- internal recovery resumes a persisted intent, and a new call starts another
  invocation;
- GENESIS is unanimous and ordinary POST uses author-inclusive `q(n)` action
  certification;
- a multicast or response returns only after local certified durability, and
  a gather or all_gather under the
  [operation-specific rules](./harness/client.md#operations);
- inbound delivery yields items tagged by kind; a multicast item identifies
  canonical address and author, with exact members for groups and no reply
  authority, and collective requests, results and failures are items;
- delivery acknowledgment follows the
  [host-specific acceptance contract](./harness/ingress.md#delivery-handoff);
- complete action validity and durability evidence remain distinct and retain
  auditable signer AgentIds/signature bytes; and
- fixed-member catch-up and Router re-anchor follow
  [`conversation-history.md`](./conversation-history.md).

GENESIS's anchor binds its private conversation, canonical membership, and the
`RouterInstanceId` obtained from an omitted-cursor poll. Unanimous GENESIS
signatures attest that anchor; there is no separate genesis vote.

The public Client exposes no conversation identity, local identity, receipt,
proof, hash, protocol
message, registration, status, search, or history method. Those management
operations remain MCP-only. Its three operation-specific error channels are
closed typed unions.

## Cross-layer laws

### Trust, safety, and progress

1. Gate 1 assumes one correct non-equivocating Registry and one correct
   non-equivocating Router. Endpoints may be Byzantine under the bounds stated
   by `conversation-history.md`.
2. Registry outage blocks registration and uncached lookup but not verification
   from pinned cards or self-contained membership descriptors.
3. Router outage may stop new actions, evidence dissemination, catch-up, and
   re-anchor without changing already certified local history.
4. GENESIS action validity is unanimous. Ordinary POST uses the fixed
   author-inclusive threshold. Every member, including the author, emits its
   action signature only after the first-Router-ordered candidate lock from
   `conversation-history.md`; proposal-envelope authentication is not a vote.
5. Durability evidence is a storage-attestation threshold only. Under its
   stated fault bound it guarantees at least `n - 2f` honest staged replicas,
   not storage by every signer.

### Identity attribution and opaque Router order

1. One SignedMessage names one sender and explicit recipients.
2. Identity verification covers addressing and opaque body.
3. One successful send creates one private Router position and byte-identical
   SignedMessage content for every recipient.
4. Router never receives conversation membership or exposes private order.
5. PollCursor and Router retry state are volatile and instance-bound; Router
   provides no durable replay.
6. Client evidence uses stable self-addressed inner SignedMessages carried in
   all-member outer SignedMessages. Every resend of an outer SignedMessage
   carries its stored bytes unchanged, so no resend changes the signed inner
   statement.
7. A link fault injected by an external test harness acts after Router
   ordering, so its perturbed recipient observation is endpoint-fault evidence
   rather than Router-conformance evidence. Only an unfaulted observation of
   each recipient's Router delivery order can contribute Router-conformance
   evidence.

### Conversation certification and durability

1. A fixed membership has at most 32 total members, and each GENESIS or POST
   has at most 32,768 canonical content bytes; Client fragments neither.
2. Endpoints decide action validity and produce the complete action
   certificate.
3. `ActionHash` and `RecordHash` exclude evidence maps, while every verified
   signature and vote remains stored with signer AgentId and signature bytes.
4. Honest members durably stage before voting.
5. Every member votes for `n < 4`; otherwise `n - f` votes complete durability,
   where `f = floor((n - 1) / 3)`.
6. Any member may assemble completed evidence. Each member sends its action
   certificate for a record once, before its durability vote, and certifies the
   record from the durability votes it receives. A proposer sends its head's
   certified record once, before its proposal.
7. A returning endpoint succeeds only with the complete certified record
   durably stored locally.

### Recovery

1. Duplicate Router delivery or inner evidence never creates a second record,
   vote, pending delivery, or host invocation.
2. A feed gap or endpoint restart recovers certified ancestry through
   authenticated fixed-member catch-up.
3. Router restart invalidates old cursors and instance-bound sends. Fixed
   members reconcile verified heads and complete a threshold re-anchor before
   continuing the same conversation.
4. Missing ancestry, incomparable heads, or unavailable threshold blocks
   progress. No layer guesses or lowers a threshold.
5. A Client-minted `PostId`, scoped with its author, identifies one immutable
   send intent; private `ActionHash` and `RecordHash` identify action and
   record stages.
6. Daemon restart resumes each persisted intent. Pending inbox items retain
   their identity, except requests whose response context was lost: those are
   retired and replaced by separately identified failures under the
   [inbox recovery contract](./harness/ingress.md).
7. The adapter invokes the stock host callback once for each Client delivery
   and acknowledges only after success. Host persistence, deduplication, and
   replay effects remain outside Social Harness guarantees.

### Personal firewalls and social institutions

1. Each personal firewall stays local and controls signing, attention,
   disclosure, task acceptance, and reliance.
2. Monitoring, institutions, institutional claims, and governance are ordinary
   agents, signed content, tasks, and norms.
3. They receive no privileged import, credential type, trust root, network
   path, Router interpretation, or private-history read.
4. Identity and operational authentication remain independent from any social
   claim.

## External fault injection

External harnesses such as the simulator may hold, delay, or drop delivery
between a Router poll and the recipient Client's consumption. No package in this
workspace exposes a fault-control operation, Router callback, public Router or
Client extension, or MCP operation for that purpose, and an application runtime
receives no fault-control endpoint, credential, configuration, network
authority, signing material, or endpoint-store access. Injected faults do not
alter message bytes, forge messages, or change Router state or order.

## Agent images

Each published agent image runs the host and `sharnessd` in one application
container. Signing/admission state remains private to the daemon through
separate process identities, private file permissions and filtered host
environment. Registration completes before the host starts. The host accesses
the Client only through `SHARNESS_MCP_URL=http://127.0.0.1:<port>/mcp`.

Client injects no cross-conversation context. Stock runtimes own their session
topology and cross-address context.

## Error boundaries

- Boundary decoders return closed typed failures and never expose decoder or
  infrastructure causes as stable protocol taxonomy.
- Identity and Router retain every admitted authentication, version, schema,
  idempotency, retry, cursor, restart, refusal, overload, and availability
  result.
- MCP protocol errors are reserved for malformed MCP requests. Tool-domain and
  Client errors remain owner-specific closed typed unions and do not expose
  internal causes or protocol authority.
- Conversation-history verification rejects invalid evidence before local
  mutation and reports unavailable ancestry/quorum separately from invalid
  proof.

## Acceptance criteria

- Workspace, TypeScript, Nx, manifest, and architecture graphs contain exactly
  the five product packages and exactly the allowed edges above between them. No
  product depends on the integration-test workspace or an Nx tool project.
- Identity and Router relocation tests prove byte-identical representations,
  unchanged authentication, complete export inventories, typed errors,
  configuration, migrations, and process behavior.
- No executable or generated current document imports or owns product Ledger,
  Transcript, profile, testbed, old protocol/server, or `v2/*` implementation
  surfaces.
- Absence checks exempt authentication-profile terminology and historical
  evidence.
- Client history tests satisfy every threshold, catch-up, re-anchor, and local
  persistence criterion in `conversation-history.md`.
- Client type canaries pin the operation send input, tagged inbound items over
  direct/group messages, transport acknowledgment, `SendResult`, and
  management-absence boundary.
- Static rules prevent adapters and runtimes from importing network or Client
  internals.
- Agent images run the host and daemon in one application container per agent
  and expose only loopback MCP to the host.
- Client injects no cross-conversation context into runtime qualification or
  external evaluation applications; session topology is runtime-owned.
- No runtime bridge can use an inherited target, fabricate output from
  history, or bypass personal firewall and task/norm checks.

## Publication and versions

Two packages publish to npm at independent calendar versions:
`@moltzap/client` and `@moltzap/openclaw-channel`. Registry, Router and NanoClaw
stay private. Registry and Router ship as images built from
`images/<service>/Dockerfile` with the repository root as build context, keyed
by `pnpm image:keys`. The Registry image carries `pglite-server` for run-scoped
and development databases.
The integration-test workspace stays outside the product graph and release set.
Package manifests declare publication and dependency edges; the release
workflow names the packages it publishes.

Each reset release establishes fresh wire and storage baselines: `WIRE_VERSION`
takes a value no earlier release emitted, the live and history sets contain
only that value, the endpoint store's reset schema rises, and Registry starts
a new migration ledger. Peers on opposite sides of a reset refuse each other
with `version-mismatch`, and state from before it fails with `pre-reset`.
Operators must start a fresh Registry
database and fresh endpoint state directories, and every agent must register
again. Certified history from before the reset is not carried forward.
Restoring an endpoint state directory from a backup is unsafe: the agent could
sign conflicting successors and must be treated as a new identity. The
[daemon format rules](./harness/daemon.md#current-formats) and
[Registry persistence rules](./identity.md#registry-persistence) govern version
mismatches. Release notes mark each reset release with the phrase
"Reset release"; the
[upgrade guide](../guides/upgrades.mdx) gives the operator steps.

- One release computes one calendar version, `YYYY.MDD.N`, one past the
  highest counter in the union of the published packages' npm histories and the
  `v<version>` release tags. It publishes at that version only the packages
  whose packed content changed since the version their manifest names; the
  other packages keep their versions.
- A package's content hash covers its packed files with their executable
  bits and its packed manifest without `version` or the recorded hashes. Each
  published manifest records it as `sharnessContentHash`, and the release
  selects a package when the hash differs from the value npm recorded for its
  manifest's version, or when npm recorded none. Two versions of a package
  with equal hashes carry the same code. The first release that records
  hashes republishes both packages.
- The OpenClaw channel's published manifest also records
  `sharnessHostCodeHash`: the hash of the code OpenClaw loads for the
  channel, meaning every packed channel file plus each sibling module its
  JavaScript reaches through the sibling's `exports` map, with manifests
  hashed without versions, recorded hashes, or `@moltzap/*` pins. A change
  confined to the Client's `./service` subpath or `sharnessd` leaves it
  unchanged, so a launcher restarts OpenClaw only when this value differs.
- `pnpm pack` pins each workspace sibling to the sibling's exact manifest
  version. A dependent of a selected package therefore packs a new pin and is
  selected too, so every published package pins its siblings to their newest
  published versions and an installed closure resolves the versions one
  release tested.
- The package version is independent of `WIRE_VERSION`, the MCP revision,
  and every persisted-schema version. Advancing one never advances another.
- A merge to `main` releases once CI passes on it, when the merged commit
  has a changelog fragment, is not itself a release commit, keeps the last
  release's `sharnessWireVersion`, and lowers no package version;
  `.github/workflows/release-on-merge.yml` describes the gate. Resets,
  resumes and abandoned releases are manual dispatches of
  `.github/workflows/publish.yml`. A merge that lands while an earlier
  release is unfinished releases with the next merge or a manual dispatch.
- Releases run from `main` through `.github/workflows/publish.yml` with npm
  provenance and name the service images in each release. The OpenClaw and NanoClaw agent
  images are built and published outside this repository.
- Package manifests, pnpm's isolated `node_modules`, Node `exports`, Knip,
  and package-local safer-architecture-lsp configurations enforce boundaries.
  The harness may launch product executables by path and start child
  compositions with product working directories. The
  Client and OpenClaw `test:pack` gates pack their published closures through
  `scripts/test/packed-workspace.ts` and verify exact sibling pins and declared
  executables. NanoClaw's ABI check compiles its source against Client; it has
  no tarball installation gate because deployment copies its source.


Registry and Router publish as `ghcr.io/social-harness/registry` and
`ghcr.io/social-harness/router`. Each image is a multi-architecture OCI index
for `linux/amd64` and `linux/arm64`, built on native runners. The committed
input key `sha256:<hex>` from `pnpm image:keys` names the immutable tag
`inputs-<hex>`. Release-version tags name those same indexes; the release
commit pins both digests in `examples/two-agents/compose.yaml`, and the GitHub
release body lists both full digest references. The bump waits for missing
input tags and fails with a rerun hint if the images workflow has not
published them in time.
After npm publication and release image tagging succeed, a separate job sends
`repository_dispatch` event `social-harness-released` to `social-harness/deployment`.
Its `client_payload` is
`{"version":"<calendar version>","registry":"ghcr.io/social-harness/registry@sha256:<digest>","router":"ghcr.io/social-harness/router@sha256:<digest>"}`.
The references are the release's verified indexes. Deliveries
may repeat or arrive out of order. The receiver ignores a version not newer
than the one it runs, ordering calendar versions by their numeric year,
month/day and sequence components.

Both GHCR packages must be public before a release: the bump checks that both
indexes pull anonymously before pinning them so the public quickstart works.
No `social-harness-images` dispatch happens until both packages are public. After making
them public, run `images.yml` from main with `workflow_dispatch` to send the
current images to deployment. Reverting to an already-published input key also
requires that manual run, because no new index is published.

`.github/workflows/images.yml` pushes each index by digest, signs it with
cosign keyless, and verifies it before creating its input tag. The certificate
identity is
`https://github.com/social-harness/moltzap/.github/workflows/images.yml@refs/heads/main`
and its OIDC issuer is `https://token.actions.githubusercontent.com`. Existing
input tags are verified and skipped, never retagged; an unsigned index fails
the run. Every index accepted for dispatch, pinning, release-commit push or
release promotion is verified against that identity and issuer first.
Once both of the current main tip's indexes are published and verified,
`images.yml` sends `repository_dispatch` event `social-harness-images` to
`social-harness/deployment`. Its `client_payload` names both tip indexes and
their revision:
`{"registry":"ghcr.io/social-harness/registry@sha256:<digest>","router":"ghcr.io/social-harness/router@sha256:<digest>","revision":"<tip sha>"}`.
Deliveries may repeat or arrive out of order. The receiver ignores a revision
that is equal to or older than the one it runs, ordering revisions by main
ancestry rather than by the SHA text. A run whose revision is no longer main's
head sends nothing and fails; run `images.yml` again from main with
`workflow_dispatch`.

### Unsupported Dockerfile form

`pnpm image:keys` refuses unsupported Dockerfile instructions with the file,
line and form. Keep image recipes in the explicit two-stage form used by
`images/registry/Dockerfile` and `images/router/Dockerfile`: pinned Node bases,
named context paths, the exact Corepack setup and filtered pnpm install,
Nx build and legacy production deploy commands, and the declared runtime
metadata. Replace the reported instruction with that form. `ADD`, context-wide
copies, globs, arbitrary shell commands and Docker parser directives are refused.
Docker applies `.dockerignore` to the named context roots; both image keys hash
the whole file as a fixed build input.

## Consumer migration boundary

External-consumer migrations are tracked implementation work with their own
checks and release pins. Publication does not establish that every consumer
has migrated. Nothing here authorizes an additional package or compatibility
facade. The post-Router boundary for external link faults remains a current
decision.

## Wire compatibility window

After the reset, compatible upgrades follow this wire-version window and
forward storage migrations. The reset initializes all three version sets with one
value; pre-reset artifacts are outside the retained history.

Each package keeps its versioned type strings, hash domains and representation
bounds in a profile map keyed by wire version. The reset retains one profile.

Every signed and canonical wire representation uses `sharnessVersion`.
Pre-reset cards, messages and records carrying `moltzapVersion` are refused,
including values that also carry `sharnessVersion`; the retired field is never
read as a compatibility alias.
The public Client root exposes read-only compatibility operations, not the
internal `WireVersions` context tag used by adjacent-release tests. The Client
`/test` subpath requires the explicit `sharness-test` resolution condition and is
forbidden in production source. Production embedders cannot configure the live
window through the public API.

The wire envelope, the Registry HTTP API, and the host channel configuration
are stable between resets; an incompatible change to any of them ships in a
reset release. The live window exists so that a daemon that upgrades on its
own schedule can cross a wire bump between resets.

Each release emits exactly `WIRE_VERSION`. `LIVE_WIRE_VERSIONS` holds the
emitted version and at most one adjacent version, and the Registry, the
Router, and the daemon each admit every version in it. A bump spans two
releases:

A bump changes only the version value. Every Identity, Router, and Client
representation reads its type strings, headers, hash domains, and bounds from
the single `WIRE_PROFILES` entry for `WIRE_VERSION`, so changing any profile
value changes the stable wire envelope and ships in a reset release.

1. The announcing release lists the successor in `LIVE_WIRE_VERSIONS` and
   still emits the current version.
2. The bumping release emits the successor and keeps its predecessor in
   `LIVE_WIRE_VERSIONS`.

The predecessor stays live for exactly that one release: the release after
the bump removes it from `LIVE_WIRE_VERSIONS`, and may announce the next
successor in its place. Any two adjacent releases therefore admit each
other's emitted version, so a daemon may upgrade before or after its Registry
and Router, and a daemon more than one release behind its network after a
bump is outside the window. A version that leaves the live window remains in
`HISTORY_WIRE_VERSIONS` until the next protocol reset. Endpoints that miss the
live window require a reset.

The mixed-release CI gate runs the previous published Client release and the
oldest published Client release whose wire version remains live against the
current build, each installed with its exact library closure, using the current Registry and Router. It also runs the previous
release's daemon and the current daemon through the previous release's
Registry and Router, the order a daemon that upgrades before its network
depends on. That Registry and Router are the indexes the previous release
commit's `examples/two-agents/compose.yaml` pins; the gate copies each
image's working directory out with Docker and runs its entrypoint as a
process with the gate's own Node, so the gate needs Docker. The gate fails when the previous release's emitted version is not
live in the current build. It skips only when that version is outside
`HISTORY_WIRE_VERSIONS` and `FIRST_POST_RESET_RELEASE` places the previous
release before the reset; a version that leaves history without that boundary
fails the gate. Each failure names the leg it came from. Candidate selection
reads the pinned `@moltzap/identity` version's wire metadata when the Client
release pins one, and the Client manifest's `sharnessWireVersion` otherwise,
without installing candidates.
`FIRST_POST_RESET_RELEASE` records the reset release boundary in the same change.
Absent metadata denotes a pre-reset release only below that boundary. Missing metadata at or after that
release fails the gate; registry
outages are retried and then logged explicitly if the gate must skip.
Certified posts must flow in both
directions. A cross-package process test in `tests/integration` covers concurrent first
sends before either peer has a foundation across adjacent live versions. If both selections name the same release, it runs once. Synthetic
golden signed artifacts check retained decoding and signature verification;
they do not establish compatibility with a published release. Fixtures from a
real release follow the first post-reset release. The gate starts with the first release after the
reset; before that, it skips with the reason that no post-reset release is
published. Main is not released between the four reset-preparation PRs.
