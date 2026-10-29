# Router: opaque globally ordered multicast

Status: **Gate 1 normative**

Exact representation:
[`router-representation.md`](./router-representation.md)

## Purpose and boundary

Router accepts one attributed SignedMessage, places it in one global Router
order, and makes the identical SignedMessage visible to every explicit
recipient in that order. The order is a private Router mechanism.

Router is an unprogrammable, content-blind data plane. It does not own
ConversationId, membership, action validity, persistence, durable
replay, offline convergence, retransmission, recovery, or
task-specific quorum policy. Endpoints own those responsibilities using
endpoint-local certified history and opaque protocol messages.

The Gate 1 Router uses independently authenticated HTTP POST send and
bounded POST polling. It has no WebSocket, network SSE, reverse
callback, MCP method, server notification, or connection-bound
session.

## Process and trust model

Gate 1 runs exactly one Router process with one volatile ordering
instance. It assumes that Router is correct and non-equivocating.
Byzantine-resistant ordering, fork detection, persistence, replication,
and multi-process sequencing are not claimed.

Router outage may halt progress. Router restart discards volatile state
and changes RouterInstanceId and the cursor-encryption key. Restart is a
safety boundary, not transparent recovery.

Endpoints may be Byzantine. Router prevents one accepted send from becoming
different bytes or a different relative position for different
recipients. It does not judge the opaque body. Client encrypts every body
it sends to the message's recipients before signing, so the bodies Router
retains and delivers are ciphertext; Router neither requires nor checks
that encryption.

The Router ordering guarantee assumes an endpoint receives the correct
Router response without network-path modification. Router responses
are unsigned, so Gate 1 does not defend against a path attacker that
reorders a batch or substitutes response fields. A deployment whose
threat model includes that path supplies channel integrity outside the
Router application.

## Public package boundary

Social Harness packages publish to npm under the `@moltzap` scope.
`@moltzap/social-harness/service` exports these Router values:

- the same-named Effect Schema values and TypeScript types
  `RouterInstanceId`, `SignedMessageDigest`, `PollCursor`,
  `RouterSendRequest`, `RouterSendResult`, `RouterPollRequest`, and
  `RouterPollResult`;
- the `Router` deep capability; and
- `RouterConnectionError`, `RouterRequestTimeoutError`, and
  `RouterInvalidResponseError`.

The private `@moltzap/router/server` entry exports only `RouterServer`, including its
nested `StartupError`. Router consumes identity values, signed
artifacts, signing authority, and shared HTTP errors from
`@moltzap/social-harness`; it does not redeclare or re-export aliases for
them.

There is no public Router order, delivery wrapper, client class,
server class, configuration type, options type, RPC group, middleware
tag, HTTP adapter, cache, nonce store, waiter, ring entry, or cursor
plaintext type.

Each Router client-only error is an empty `Data.TaggedError` whose
`_tag` is exactly its class name. It declares no `message`, code,
status, reason, cause, operation, method, origin, URL, timeout,
response, key, path, SQL, or library-detail field. Private redacted
diagnostics retain an underlying cause before mapping it to the public
recovery class.

The mapping is exclusive:

- expiry of the configured total call deadline becomes
  `RouterRequestTimeoutError`;
- another connection-establishment or connection-use failure becomes
  `RouterConnectionError`, including a 502, 503, or 504 response without
  the Router's `application/json` content type, which an intermediary
  gateway returns while the Router behind it is unreachable;
- a recognized operation-declared server envelope becomes the
  corresponding identity-owned shared server error;
- local authenticated-request signing failure becomes the
  identity-owned `AgentSigningError`; and
- an invalid status, body, Schema, binding, or signature combination
  becomes `RouterInvalidResponseError`.

Router poll results contain parsed and bounded, but untrusted,
SignedMessage values. They therefore do not add
`SignedMessageVerificationError` to `Router.poll`; the endpoint
verifies every returned message before accepting the PollCursor.

## Operations

The Router exposes:

- authenticated `POST /v1/messages:send`;
- authenticated `POST /v1/messages:poll`; and
- unauthenticated `GET /healthz` for local readiness.

All JSON and HTTP representation details are owned by
`router-representation.md` and L1 AuthenticatedHttp.

## Effect capability and private RPC

`Router` is the package-root `Context.Tag` deep capability. Its static
accessors have these exact public signatures:

```ts
Router.send(input: {
  readonly request: RouterSendRequest
  readonly callerAgentId: AgentId
  readonly signingAuthority: AgentSigningAuthority
}): Effect.Effect<
  RouterSendResult,
  MalformedRequestError
    | AuthenticationFailedError
    | RouteNotFoundError
    | MethodNotAllowedError
    | VersionMismatchError
    | PayloadTooLargeError
    | UnsupportedMediaTypeError
    | OverloadedError
    | UnavailableError
    | InternalServerError
    | RouterConnectionError
    | RouterRequestTimeoutError
    | RouterInvalidResponseError
    | AgentSigningError,
  Router
>

Router.poll(input: {
  readonly request: RouterPollRequest
  readonly callerAgentId: AgentId
  readonly signingAuthority: AgentSigningAuthority
}): Effect.Effect<
  RouterPollResult,
  MalformedRequestError
    | AuthenticationFailedError
    | RouteNotFoundError
    | MethodNotAllowedError
    | VersionMismatchError
    | PayloadTooLargeError
    | UnsupportedMediaTypeError
    | OverloadedError
    | UnavailableError
    | InternalServerError
    | RouterConnectionError
    | RouterRequestTimeoutError
    | RouterInvalidResponseError
    | AgentSigningError,
  Router
>
```

The production client construction member is exactly:

```ts
Router.layer(input: {
  readonly origin: URL
  readonly sendTimeout: Duration.Duration
  readonly pollTimeout: Duration.Duration
}): Layer.Layer<Router, never, HttpClient.HttpClient>
```

The layer snapshots its URL and durations. There is no public
`RouterClient`, client-options type, configuration type, service
interface, signer key, AgentCard, or cursor-key input.

The server subpath exports `RouterServer.layer` as a constant
`Layer.Layer<never, RouterServer.StartupError>`. The startup error is
tagged `RouterServerStartupError` and contains only `phase`, which is
`configuration` or `listener`; implementation and library causes
remain private and redacted.

The server owns one private Effect RPC group containing only `send` and
`poll`. Both members require middleware that supplies the verified
registered-agent context from AuthenticatedHttp. This required
middleware short-circuits the handler on failure. The verified caller
and AgentCard reach the handler without a second lookup, and middleware
or handler failures remain in the typed `E` channel through the HTTP
adapter. Closed Router refusals remain values in `A`.

The private adapter uses `RpcServer.makeNoSerialization` and
`RpcClient.makeNoSerialization` for correlation and typed exits.
Effect Schema still validates every network request and result.
Production exposes only the named HTTP routes: it has no `/rpc`,
JSON-RPC, NDJSON, `RpcSerialization`, exported RPC group, or exported
middleware tag. Health remains a direct route outside RPC.

## Send

A send contains:

- the RouterInstanceId most recently learned by the endpoint;
- mode `initial` or `retry`; and
- one complete encoded SignedMessage.

The HTTP boundary first resolves the route and method, enforces
framing, media type, that route's derived received-body cap, and the
immediate request-concurrency permit. AuthenticatedHttp then validates
the canonical outer request, authenticates the registered caller,
claims the nonce, and supplies the verified caller AgentCard. The
Router-owned Effect Schema decodes the retained inner request only
after that proof succeeds.

Router then checks the expected instance before verifying the
SignedMessage. An instance mismatch returns `router_restarted` with the
current instance and performs no message verification or feed
mutation.

For a matching instance, Router:

1. binds the authenticated caller to SignedMessage sender AgentId;
2. uses the verified immutable AgentCard supplied by AuthenticatedHttp;
3. verifies AgentCardDigest, SignedMessage signature, recipient
   invariants, and fixed or derived representation bounds;
4. leaves the opaque body uninterpreted;
5. decides the retained retry identity;
6. assigns the next private global order;
7. appends one SignedMessage copy to the global ring;
8. evicts old entries under the configured count and byte bounds; and
9. acknowledges only after the accepted entry is visible to poll.

Router never resolves recipients and never attaches AgentCards.

### Initial and retry

The retry identity is sender AgentId plus MessageId.

`initial` asserts that no retained entry has this identity. Any retained
entry conflicts, including one with identical bytes. Eviction removes the
identity with its entry, so after eviction a sender may send the same
identity again, and Router appends it as a new entry.

`retry` never appends:

- byte-identical retained SignedMessage returns its original
  `accepted` result;
- changed SignedMessage bytes return `idempotency_conflict`; and
- an absent or evicted identity returns `retry_identity_unknown`. An
  identity whose `initial` Router has not yet appended is absent.

Because eviction frees an identity, one SignedMessage may occupy more than one
private order and reach a recipient more than once. An `initial` also
conflicts when a slower `initial` with the same identity appended first.
Client's resend rule and duplicate handling are in
[`conversation-history.md`](./conversation-history.md).

The accepted SignedMessageDigest is an immediate equality receipt for
the retained live entry. It proves no position, delivery, durability,
recipient status, quorum, or offline Router attestation.

## One volatile global feed

One process instance owns:

- one random RouterInstanceId;
- one random 256-bit PollCursor key;
- one private monotonically increasing unsigned 128-bit order;
- one private greatest-evicted order;
- one count-and-byte-bounded global ring;
- one retry index coupled to retained ring entries;
- one bounded accepted-nonce set;
- one bounded positive AgentCard cache; and
- request-scoped poll waiters grouped by AgentId.

Private order `0` is the empty-tail sentinel. The first accepted
SignedMessage receives order `1`; each later accepted message increments
the private order by one within that process instance. The
greatest-evicted order starts at `0` and advances to each evicted
entry's order.

The append that assigns `2^128 - 1` succeeds and immediately makes
health unready because no fresh append capacity remains. A later
initial send that would require a greater order returns 429
`overloaded` without mutating Router state. Retained retries and polls
do not assign a new order.

The exhaustion check runs only when a verified initial send would
otherwise append. Instance fencing, message validation, and existing
retry-identity outcomes retain their specified precedence.

Each ring entry stores one exact encoded SignedMessage, its verified
recipient set, SignedMessageDigest, private order, and retry identity.
There is no per-recipient message copy or retained recipient index.

Ring eviction and retry-index removal are one state transition. The
Router has no separate retry cache, database, cursor table, session
table, durable recovery state, recipient queue, or recipient
acknowledgment.

The short serialized state transition covers retry decision, order
assignment, append, eviction, scan snapshot, waiter registration, and
detaching addressed waiters. Parsing, canonicalization, hashing,
Registry calls, signature verification, response encoding, network
I/O, and waiter completion remain outside it.

## Authenticated caller resolution

Router authenticates and verifies only the caller. The
identity-owned AuthenticatedHttp layer performs that work inside the
Router process and returns a nominal `VerifiedAgentRequest` containing
the caller AgentId, verified immutable AgentCard, and untrusted inner
request. Router consumes the proof but cannot construct or decode it.

On a positive-cache miss, AuthenticatedHttp uses public Registry lookup
and verifies the returned AgentCard against the configured Registry
signer public key. Concurrent misses for one AgentId are single-flight
and bounded by the configured underlying-lookup limit. Verified
immutable cards have no time-based expiry in Gate 1. Failures and
`not_found` have zero cache lifetime.

A cached caller can continue sending and polling during Registry
outage. An unseen or capacity-evicted caller cannot. Registry outage
does not make Router health unready.

## Poll

Each poll:

- is independently authenticated for one AgentId;
- carries zero or one opaque PollCursor;
- returns a bounded restriction of the one global order to
  SignedMessages addressed to that AgentId;
- may hold a continuation request for at most 25 seconds; and
- creates no retained protocol, cursor, or acknowledgment state.

The hold deadline is exactly 25 seconds and is not
deployment-configurable in Gate 1.

A successful `batch` contains the current RouterInstanceId, ordered
SignedMessages, and the next PollCursor. Retrying the same PollCursor
may return an already observed complete batch. The endpoint advances its
volatile cursor only after accepting the entire result.

The Router client parses and bounds returned SignedMessages but does
not mark them verified. The endpoint verifies every returned
SignedMessage before accepting the batch or its PollCursor.

Router never treats an HTTP write, disconnect, timeout, or cancellation
as cursor advancement.

### Omitted cursor

An omitted PollCursor atomically snapshots the current tail and returns an
immediate empty batch anchored at that tail. A newly started endpoint uses
this only after reconciling its local certified heads and any required
fixed-member catch-up.

The empty batch reveals the current RouterInstanceId and gives the endpoint
the instance it binds into new communication evidence and subsequent
sends. It does not replay retained volatile history.

### Continuation

A valid continuation scans strictly after its last scanned private
order through a stable tail snapshot. It:

- advances past SignedMessages not addressed to the caller;
- appends addressed SignedMessages in global order;
- stops at the configured message-count bound; and
- stops before, rather than skipping, an addressed SignedMessage that
  would exceed the response-byte bound.

If the scan reaches its snapshot with no addressed message, Router
registers one request-scoped waiter atomically with that empty scan.
An accepted send detaches waiters for active recipients. Timeout,
cancellation, disconnect, or completion removes the waiter.

Only one held poll per AgentId is permitted, subject to the global held
poll bound. The Router stores no response or continuation state after
the request ends.

### Cursor rejection

Tampering, malformed plaintext, wrong caller, wrong RouterInstanceId,
future private order, noncanonical order text, or a cursor from a
previous process key returns only `cursor_invalid`. It does not reveal
the current instance.

A valid current-instance cursor returns `feed_gap` exactly when its
last scanned order is less than the greatest-evicted order. Equality is
safe. The result contains the current instance and no partial batch.
Unrelated traffic may cause this conservative result because the Router
keeps no per-recipient retention index.

## Feed gap and restart recovery

After `feed_gap`, an endpoint:

1. abandons incomplete volatile protocol folds;
2. verifies its local certified heads and automatically catches up missing
   ancestry from authenticated fixed-member peers;
3. resumes eligible protocol work only from a verified certified head; and
4. anchors polling with an omitted PollCursor.

Router performs none of those endpoint steps.

Router restart invalidates every old PollCursor. An endpoint learns the new
instance from an omitted-cursor batch or a `router_restarted` send result.
Router continues to reject old-instance sends, but existing conversations are
not permanently fenced. Fixed members compare certified ancestry and complete
the quorum re-anchor protocol in
[`conversation-history.md`](./conversation-history.md) before creating new
actions in the new Router instance. Missing ancestry or quorum blocks
progress; endpoints never guess a head or lower the threshold.

Already certified old-instance history remains readable and verifiable. A
re-anchor extends its Router-epoch proof chain without rewriting history or
making Router durable.

## Sessionlessness

Every send and poll authenticates independently and carries exact
wire compatibility value. A held long poll is only an HTTP optimization.
Its closure does not revoke identity, expire protocol work, advance a
cursor, or alter membership.

Reconnect is not equivalent to never disconnecting. Volatile retention may
produce `feed_gap`; restart produces a new instance and invalidates cursors.
Durable recovery belongs to endpoint-owned communication history.

The local daemon's request-scoped MCP SSE response is outside both
network planes and is not a Router push channel.

## Configuration

The Router process defines one private `Config.all` value.
`Schema.Config` decodes and refines every declared value,
`Config.withDefault` owns defaults, and configuration failure becomes
`RouterServerStartupError` with phase `configuration`. The executable
supplies `ConfigProvider.fromEnv`; tests use
`ConfigProvider.fromMap`; embedded composition may supply another
provider. Other unrelated and unused entries are ignored. There is
no custom environment parser, mutable singleton, hot reload, or public
configuration type.

The exact Router server environment is:

| Key | Meaning | Required/default | Range and constraints |
|---|---|---|---|
| `SHARNESS_ROUTER_HOST` | listener bind host | `127.0.0.1` | nonempty Node bind host; `0.0.0.0` and `::` allowed |
| `SHARNESS_ROUTER_PORT` | listener port | required | integer 1–65535 |
| `SHARNESS_ROUTER_REGISTRY_ORIGIN` | Registry client origin | required | serialized HTTP or HTTPS origin with no userinfo, route path, query, or fragment |
| `SHARNESS_ROUTER_REGISTRY_SIGNER_PUBLIC_KEY` | deployment-pinned Registry signer | required | inline exact closed Ed25519 public JWK JSON in compact JCS spelling |
| `SHARNESS_ROUTER_RETAINED_MESSAGE_CAPACITY` | global-ring message count | `4,096` | positive count; one copy per message |
| `SHARNESS_ROUTER_RETAINED_MESSAGE_BYTE_CAPACITY` | global-ring byte retention | `67,108,864` | sum of complete SignedMessage JCS bytes |
| `SHARNESS_ROUTER_POLL_MESSAGE_LIMIT` | maximum messages in one batch | `128` | positive count |
| `SHARNESS_ROUTER_POLL_RESPONSE_BYTE_LIMIT` | maximum complete poll result | `1,048,576` | UTF-8 JCS result bytes including PollCursor |
| `SHARNESS_ROUTER_REQUEST_CONCURRENCY_LIMIT` | active request permits | `512` | positive integer |
| `SHARNESS_ROUTER_HELD_POLL_CAPACITY` | globally held continuation polls | `256` | positive and strictly less than request concurrency |
| `SHARNESS_ROUTER_LIVE_NONCE_CAPACITY` | current-instance unexpired nonces | `100,000` | positive; never evict a live nonce |
| `SHARNESS_ROUTER_AGENT_CARD_CACHE_CAPACITY` | positive immutable-card LRU | `10,000` | positive entry count |
| `SHARNESS_ROUTER_REGISTRY_LOOKUP_CONCURRENCY_LIMIT` | concurrent underlying Registry lookups | `32` | positive; same-AgentId misses remain single-flight |
| `SHARNESS_ROUTER_REGISTRY_LOOKUP_TIMEOUT_MS` | complete Registry lookup deadline | `5,000` | positive milliseconds through verified-card result |

Accepting either HTTP or HTTPS only establishes a usable Registry
client origin. It does not require HTTPS, reject non-loopback HTTP, or
create a TLS or trusted-proxy mode in the Router.

Numeric environment values use canonical unsigned decimal with no
whitespace, sign, fraction, or exponent. Their common range is
`1..2^31-1`, except ports, which are `1..65535`.

Configuration is rejected unless:

1. the retained-message count and byte capacities admit at least one
   maximum complete SignedMessage;
2. the poll message limit admits at least one message; and
3. the poll response-byte limit admits one maximum SignedMessage and
   one maximum PollCursor in a complete `batch`.

There is no application request queue and no Router configuration key
for one. An immediate request-concurrency permit is the complete
in-process admission control; the Node and operating-system connection
backlog belongs to the runtime and deployment.

There is also no environment key for the opaque-body maximum,
recipient maximum, complete SignedMessage maximum, either route's body
cap, wire compatibility value, JSON depth, signature-time bounds, 25-second poll
hold, one-held-poll-per-AgentId rule, private order width,
RouterInstanceId, PollCursor key, positive-card cache TTL, TLS,
certificates, URL-scheme policy, trusted proxies, or version
negotiation. Those values are fixed protocol facts, representation
consequences, process-generated values, or deployment concerns.

## Operational bounds

A deployment configures finite poll batch and response limits, feed
count and byte retention, accepted-nonce and positive-card cache
capacities, and request, held-poll, and Registry-lookup concurrency.
Identity fixes the opaque body at 262,144 decoded bytes maximum and the
recipient set at 128 AgentIds maximum. Identity derives the complete
SignedMessage maximum as 471,676 UTF-8 JCS bytes. Router derives the
send and poll received-body caps as 471,824 and 423 octets,
respectively. A PollCursor is at most 349 ASCII characters, and a
complete one-message batch is at most 472,125 UTF-8 JCS bytes.

The representation depth, these fixed and derived bounds, and the
25-second poll hold are not deployment configuration.

Byte accounting is exact:

- a route body cap counts received body octets;
- the fixed opaque-body maximum counts bytes after canonical base64url
  decode;
- the complete-message maximum and feed retention count UTF-8 JCS bytes
  of each complete SignedMessage General JWS object; and
- the configured poll-response limit counts UTF-8 JCS bytes of the
  complete result body, including its PollCursor.

Identity exposes the complete-message calculation through
`SignedMessage.maximumEncodedByteLength` and exact accepted-message
length through `SignedMessage.encodedByteLength`. Router consumes those
members instead of reproducing General JWS sizing. Router derives only
its send, poll, PollCursor, and poll-result sizes from the
representations it owns. Overflow-checked calculators are compared
against actual encodings, not a second approximation formula.

Router maps each finite bound exactly:

| Condition | Outcome |
|---|---|
| HTTP request body exceeds the route bound | 413 `payload_too_large` before authentication or domain handling |
| immediate request-concurrency, live-nonce, or Registry-lookup capacity is unavailable | 429 `overloaded` |
| a valid continuation has scanned a stable tail, found no addressed message, and held-poll or per-AgentId held-poll capacity is unavailable | 429 `overloaded` without retaining a waiter |
| a new initial send would exceed the private unsigned 128-bit order | 429 `overloaded` without mutation; local health is already unready |
| post-authentication complete SignedMessage, opaque body, or recipient count exceeds its bound | 200 `message_invalid` |
| a positive AgentCard cache insertion exceeds capacity | evict the least-recently-used positive entry |
| an uncached required Registry lookup is unavailable or times out | 503 `unavailable` |
| an accepted append exceeds feed count or byte retention | evict oldest entries until both bounds hold and advance greatest-evicted order |
| continuation reaches poll message-count or response-byte capacity | return the bounded prefix and a cursor at the last scanned order; do not skip the first addressed message that did not fit |
| an unexpected implementation failure occurs | 500 `internal` |

Router does not partially decode, silently truncate an artifact, or
evict an accepted unexpired nonce. A novel nonce refused for capacity
is not claimed.

Nonce replay rejection is scoped to the current Router instance.
Across restart, an old send remains fenced by expected
RouterInstanceId before delivery. Poll is read-only and has no
server-side cursor advancement.

## Health

`GET /healthz` returns 204 when the current process can accept local
work and 503 otherwise. It returns no feed, cursor, order, identity, or
conversation data and never probes Registry.

Successfully assigning the maximum private unsigned 128-bit order makes
health return 503 until process replacement creates a new
RouterInstanceId and order.

## Invariants

1. Every accepted send has one private global position and identical
   SignedMessage bytes for every explicit recipient.
2. Router cannot route on or learn ConversationId.
3. Each recipient batch is the restriction of one global Router order.
4. No public Router value exposes that order.
5. A successful batch reveals the current RouterInstanceId without
   cursor decoding or a send.
6. Cursor advancement is entirely client-held.
7. Router provides no durable recovery guarantee.
8. Router restart is observable and rejects old-instance sends; an existing
   conversation resumes only after endpoint quorum re-anchor.
9. Re-reading a retained batch is permitted and does not create a
   second communication fact.

## Acceptance criteria

- Simultaneous sends occupy one total order with no duplicate internal
  position.
- Every recipient of one multicast observes byte-identical
  SignedMessage values in the same relative order.
- A non-recipient observes nothing and Router does not consult
  conversation membership.
- A retained byte-identical retry made with fresh HTTP authentication
  returns the original accepted result; changed bytes conflict.
- An absent or evicted retry returns `retry_identity_unknown` without
  append, and an `initial` under that evicted identity appends a new
  entry.
- Omitted PollCursor returns an immediate empty anchor with the current
  RouterInstanceId.
- Continuation poll returns on addressed data or at 25 seconds and
  retains no session.
- Too-old continuation returns only `feed_gap`; invalid cursor classes
  return only `cursor_invalid`.
- Router restart cannot accept an old expected-instance send.
- A full nonce cache refuses work instead of evicting an unexpired
  nonce.
- A synthetic order-boundary test accepts order `2^128 - 1`,
  immediately marks health unready, refuses the next fresh append
  without mutation, and still permits retained retries and polls.
- A PollCursor whose plaintext order exceeds `2^128 - 1` is
  `cursor_invalid`, and the maximum valid cursor fits a one-message
  response under the configured byte laws.
- Registry outage after a positive cache hit does not prevent that
  caller from sending; an uncached caller fails closed.
- Type canaries pin both Router accessors, their complete `E` unions,
  `Router.layer`, and `RouterServer.layer` without exposing a client,
  server, options, configuration, RPC, or middleware type.
- Private RPC tests prove that registered-agent middleware is
  mandatory, stops the handler on failure, carries its verified context
  to the handler once, and transports middleware and handler failures
  through the client `E` channel.
- Configuration tests use `ConfigProvider.fromMap` to prove every key,
  default, refinement, cross-field fit law, typed startup failure, and
  acceptance of unrelated map entries without mutating `process.env`.
- Boundary tests accept each route's exact maximum received body and
  reject one additional octet before authentication or domain work.
- Router size tests compare the send, poll, PollCursor, and poll-result
  calculators with actual Schema, JCS, and JWE encodings while using
  the identity-owned SignedMessage maximum without reproducing its
  General JWS formula.
- Conversation recovery is implementable through endpoint-owned certified
  history, fixed-member catch-up, and quorum re-anchor without Router durable
  replay.

## Explicitly deferred

Persistent feeds, Router replication, ordering consensus, Router-level fork
detection, transparent Router restart, per-recipient retention indexes,
negotiated resource limits, and network push transports.

## Process entries

Direct composition through `@moltzap/router` or `@moltzap/router/server` requires
`--conditions=sharness-internal`. The `sharness-router` executable installs a
scoped internal-resolution hook before loading its process composition.

`@moltzap/router/test` exports `startRouter` only under `sharness-test`. It accepts
explicit emitted, live and history wire versions for process fixtures and installs
the same hook. Only parents under the Router's built `dist/` and executable
`bin/` directories receive `sharness-internal`; callers outside those directories,
including nested dependencies under the package root, retain their original
conditions and cannot resolve `@moltzap/social-harness/internal`.
