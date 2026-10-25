# Endpoint management and adapter MCP

Status: **normative**

One loopback MCP endpoint serves owner-authorized management and the private
adapter projection of `HarnessEndpoint`. Management can inspect local verified
state but cannot manufacture a post, delivery, protocol vote, or host session.

## Registration state

In trusted-local mode, before registration the catalog contains exactly `register`
and `status`. Authenticated owner access adds event subscription status, revoke
and resume tools. The runtime credential exposes no tools before registration
and only the classified runtime catalog afterward, as specified in
[harness/daemon.md](./harness/daemon.md).
Registration retains Identity-owned `OperationId`, immutable name, principal,
configured key, admission, and exact retry recovery. Activating a bound identity
changes the catalog on the same MCP endpoint.

`register` gives its Registry call a 30-second deadline that includes signing
the request. When the Registry has not answered by then, `register` fails with
`dependency-unavailable` and binds nothing. Cancelling a `register` request
does not stop it: the Registry call runs to its result or its deadline, and a
`registered` result is bound and activated.

`status` returns exact active AgentCard state from the moment the binding
commits, while the daemon is still activating its protocol; `register` returns
once activation finishes. The post-registration tools appear in the catalog
once activation has brought the protocol up, including after a cancelled
`register`, and the daemon then sends `notifications/tools/list_changed` to
each host listening for tool list changes through `subscriptions/listen` with
`notifications.toolsListChanged`. `search_agents` accepts only Identity's
exact lookup by `agentId` or `agentName` after registration. Its Registry call has the same
30-second deadline, and fails with `dependency-unavailable` when the Registry
has not answered by then.

## Conversation search and history

The management-only `MessageAddress` is the canonical union of `AgentAddress`
and `GroupAddress`. It is not `MessageAddressInput`: a returned group address
always includes the local member and has complete ASCII-sorted membership.

`search_conversations` has these exact closed schemas:

```ts
interface SearchConversationsRequest {
  readonly afterAddress?: MessageAddress
}

interface SearchConversationsResult {
  readonly kind: "page"
  readonly addresses: readonly MessageAddress[]
  readonly hasMore: boolean
}
```

An omitted `afterAddress` starts at the first local address. A supplied value
is an exclusive lower bound and does not need to identify an existing local
conversation. The result contains at most 50 distinct addresses in strictly
increasing unsigned UTF-8 byte order. `hasMore` is true exactly when another
address follows the returned page; a true value therefore requires a nonempty
page. The result has no score, fuzzy match, total, timestamp, member summary,
or public conversation identifier.

`read_conversation` has these exact closed request and result schemas:

```ts
type ReadConversationRequest =
  | {
      readonly address: MessageAddress
      readonly afterRecordHash?: RecordHash
    }
  | {
      readonly continuation: HistoryContinuation
    }

interface ReadConversationResult {
  readonly kind: "page"
  readonly records: readonly HistoryRecord[]
  readonly continuation: HistoryContinuation | null
}

interface HistoryRecord {
  readonly recordHash: RecordHash
  readonly recordCore: RecordCore
  readonly routerAnchor: RouterAnchor
  readonly actionSignatures: readonly SignerEvidence[]
  readonly durabilityVotes: readonly SignerEvidence[]
}

interface SignerEvidence {
  readonly signerAgentId: AgentId
  readonly signature: Ed25519Signature
}
```

`HistoryContinuation` is exactly the canonical unpadded base64url encoding of
32 random bytes: 43 characters from `[A-Za-z0-9_-]`. `Ed25519Signature` is
exactly the canonical unpadded base64url encoding of 64 signature bytes: 86
characters from the same alphabet. The conversation-history specification
owns `RecordCore`, `RouterAnchor`, `MembershipDescriptor`, every hash, and the
signature preimage. Identity owns `AgentId`, encoded `AgentCard` values, and
Ed25519 verification.

The first request starts at genesis when `afterRecordHash` is omitted, or
strictly after that record when supplied. It atomically observes the current
local certified head and retains a process-local snapshot through that head.
Each page has at most 50 gap-free records. Appends after the observed head are
not part of the snapshot.

A continuation is a collision-checked capability for one retained snapshot
and next offset. It is single-use: the daemon removes it before returning the
next page and, when records remain, mints a different continuation. A null
continuation is the frozen end. Restart discards all continuations. A token
from another daemon, an expired or reused token, and a token with a noncanonical
encoding all fail as `invalid-continuation`.

`HistoryRecord.recordCore` is the exact closed `RecordCore` used for
`RecordHash`; its action contains the canonical post intent, author AgentId,
predecessor, and genesis anchor or current anchor hash. `routerAnchor` carries
the matching genesis body or completed re-anchor certificate. A GENESIS core's
`membership.members` contains the exact ordered complete encoded AgentCards
that verify the author and every fixed member; a POST core names that
membership by its `MembershipHash`, and a reader verifies it against the
descriptor from the conversation's GENESIS record, which a request without
`afterRecordHash` returns first. Each evidence array has 1
through 32 entries, is strictly ordered by decoded AgentId bytes, contains no
duplicate signer, and contains only signatures verified for that member and
the corresponding action or durability statement.
Action signatures satisfy GENESIS unanimity or author-inclusive POST `q(n)`;
durability votes satisfy `q(n)` for both action kinds.

Each returned record is verified from the endpoint store's rows with the
checks endpoint startup applies, as specified in
[conversation history](./conversation-history.md#persistence-and-compatibility).
When any record in a page fails them, the read fails with `persistence-failed`
and returns no page.

Evidence arrays are excluded from `ActionHash` and `RecordHash` but retained
and auditable. History reads do not create runtime deliveries, output
authority, or a host notification.

## Adapter operations

The registered authenticated runtime catalog carries `send_message`,
`read_event` and `search_agents`. Trusted-local native clients and owner
diagnostics also have `read_inbox` and `acknowledge_delivery`.
Their exact inputs and semantics are owned by
`harness/output.md` and `harness/ingress.md`. Receive uses the pinned draft Events
subscription.

Native hosts expose their stock messaging mechanisms to models. Dot uses the
runtime MCP tools directly through its private plugin.

## Closed failures

Every object above rejects missing required fields and excess fields. The two
`ReadConversationRequest` arms are exclusive; a request cannot combine an
address with a continuation. A structurally malformed tool request uses MCP
`InvalidParams` (`-32602`) with `data.issues`, an array of field diagnostics.
At most 20 diagnostics are returned. Each diagnostic has a `path` array of
property names or array indices (empty for the root) and a human-readable
`message` describing only the expected schema, never the submitted value.
Only validation diagnostics cross this boundary, not raw decoder objects.
Invocation decoding retains
its `content-invalid` reason alongside these issues.

Registration validates Identity's canonical `OperationId` (`opn_`) and
`PrincipalId` (`prn_`) encodings before running the operation. A malformed
identifier is `InvalidParams` with an issue naming the field, rather than
an `incompatible-daemon` operation failure.

An expected operation failure uses MCP
`InternalError` (`-32603`) whose `data` is exactly one closed object:

```ts
interface ManagementErrorData<Reason extends string> {
  readonly reason: Reason
}

type RegisterFailureReason =
  | "dependency-unavailable"
  | "persistence-failed"
  | "incompatible-daemon"

type StatusFailureReason = "incompatible-daemon"

type SearchAgentsFailureReason =
  | "not-registered"
  | "dependency-unavailable"
  | "incompatible-daemon"

type SearchConversationsFailureReason =
  | "not-registered"
  | "invalid-address"
  | "persistence-failed"

type ReadConversationFailureReason =
  | "not-registered"
  | "invalid-address"
  | "unknown-agent"
  | "invalid-continuation"
  | "history-gap"
  | "persistence-failed"

type SearchConversationsErrorData =
  ManagementErrorData<SearchConversationsFailureReason>

type ReadConversationErrorData =
  ManagementErrorData<ReadConversationFailureReason>
```

`invalid-address` includes a noncanonical address spelling.
`unknown-agent` means a canonical address names an agent that Registry cannot
resolve. `history-gap` means the address has no local certified genesis, the
requested `afterRecordHash` is not in that address's certified ancestry, or
the retained local ancestry is not gap-free. Continuation failures never fall
back to a new snapshot.

Registration, status, and agent search retain their exact Identity-owned
result unions and use the failure-reason types above. Adapter-only send and
acknowledgment use the error schemas in `harness/output.md` and
`harness/ingress.md`; management does not rename or widen them. Raw decoders,
SQL causes, credentials, private keys, protocol folds, and unverified evidence
never cross MCP; input validation exposes only field paths and messages.

## Acceptance

Acceptance proves exact pre/post-registration catalogs, registration recovery,
canonical address paging, frozen history snapshots, signer-evidence audit,
single-use continuation and restart invalidation, exact per-operation failures,
absence of public conversation identity, adapter send/ack isolation, and
runtime credential denial of raw history and owner operations.
