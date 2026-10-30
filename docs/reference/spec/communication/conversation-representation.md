---
title: Conversation wire formats
description: Exact messages, hashes, and evidence exchanged by conversation members.
read_when:
  - You are implementing the conversation protocol
  - You need to verify stored records or peer evidence
---

This reference defines certified records and recovery exchanges. The
[conversation contract](./conversation-history.md) explains their guarantees.

## Encoding and notation

Objects have exactly their required fields. Reject unknown fields or kinds before
state changes. Every interface below except `ConversationIdentityInput` also
requires `sharnessVersion: WireVersion`, omitted from the notation. That string
uses the [history version rules](#history-versions). Conversation identity is
version-independent. `ContentPart` has only its shown fields.

[Identity encodings](../identity/representation.md) apply. `EncodedAgentCard`
and `EncodedSignedMessage` are complete General JWS objects with signatures.

Each nominal string uses its four-character prefix and canonical unpadded
base64url of 32 bytes:

```ts
type ConversationId = `cnv_${string}`
type MembershipHash = `mbr_${string}`
type MsgId = `msg_${string}`
type MessageIntentHash = `mit_${string}`
type AnchorHash = `anc_${string}`
type ActionHash = `ach_${string}`
type RecordHash = `rch_${string}`
```

`Content` is a nonempty array of the following closed union and its RFC 8785
encoding is at most 32,768 bytes:

```ts
type ContentPart =
  | { type: "text"; text: WellFormedUnicodeString }
  | { type: "data"; value: JsonValue }
```

`JsonValue` recursively permits null, booleans, finite JSON numbers, well-formed
Unicode strings, arrays and objects with well-formed keys. Reject duplicate
names, lone surrogates, non-JSON numbers, noncanonical bytes and excess fields.

### Membership and identifiers

Membership and identifier preimages:

```ts
interface ConversationIdentityInput {
  kind: "conversation_identity"
  memberAgentIds: [AgentId, AgentId, ...AgentId[]]
}

interface MembershipDescriptor {
  kind: "membership_descriptor"
  conversationId: ConversationId
  members: [
    EncodedAgentCard,
    EncodedAgentCard,
    ...EncodedAgentCard[],
  ]
}

```

Both arrays contain 2–32 entries sorted by unsigned lexicographic decoded
AgentId bytes. IDs and names are unique. Verify every card's Registry signature
and rederive conversationId from the cards. Before persisting a new local intent,
the author creates MsgId from 32 cryptographically random bytes. Peers check its
canonical form and reject changed intent under `(authorAgentId, MsgId)`.

### Message intents, anchors, and action cores

```ts
interface MessageIntent {
  kind: "message_intent"
  conversationId: ConversationId
  membershipHash: MembershipHash
  authorAgentId: AgentId
  msgId: MsgId
  content: Content
}

interface InitialAnchorBody {
  kind: "initial_anchor_body"
  conversationId: ConversationId
  membershipHash: MembershipHash
  routerInstanceId: RouterInstanceId
}

interface ReanchorBody {
  kind: "reanchor_body"
  conversationId: ConversationId
  membershipHash: MembershipHash
  previousAnchorHash: AnchorHash
  selectedRecordHash: RecordHash
  routerInstanceId: RouterInstanceId
}

type AnchorBody = InitialAnchorBody | ReanchorBody

interface FirstMessageActionCore {
  kind: "FIRST_MESSAGE"
  conversationId: ConversationId
  membership: MembershipDescriptor
  anchor: InitialAnchorBody
  previousRecordHash: null
  messageIntent: MessageIntent
  messageIntentHash: MessageIntentHash
}

interface MessageActionCore {
  kind: "MESSAGE"
  conversationId: ConversationId
  membershipHash: MembershipHash
  anchorHash: AnchorHash
  previousRecordHash: RecordHash
  messageIntent: MessageIntent
  messageIntentHash: MessageIntentHash
}

type ActionCore = FirstMessageActionCore | MessageActionCore

interface FirstMessageRecordCore {
  kind: "record_core"
  membership: MembershipDescriptor
  anchorHash: AnchorHash
  action: FirstMessageActionCore
  actionHash: ActionHash
}

interface MessageRecordCore {
  kind: "record_core"
  membershipHash: MembershipHash
  anchorHash: AnchorHash
  action: MessageActionCore
  actionHash: ActionHash
}

type RecordCore = FirstMessageRecordCore | MessageRecordCore
```

FIRST_MESSAGE carries membership, verified and retained before signing. Empty
catch-up starts there. MESSAGE uses the held membership hash: reject mismatch,
ignore unknown conversations. Descriptor version comes from the first canonically
ordered card, and initial anchor version from that descriptor. Immutable cards
make these hashes agree across adjacent live versions.

FIRST_MESSAGE is nonempty and uses the omitted-cursor Router instance. MESSAGE
extends the certified head under the current completed anchor.

### Canonical encoding and preimages

`JCS(S, v)` is RFC 8785 UTF-8 of `v` satisfying closed grammar `S`.
Received bytes must match. Hashes use:

```text
H(artifact, S, v) =
  SHA-256(
    UTF8("org.social-harness/client/v2/" + artifact + "\0") || JCS(S, v)
  )
```

Hash derivations:

| Value | Artifact | Schema preimage | Text |
|---|---|---|---|
| `ConversationId` | `conversation` | `ConversationIdentityInput` | `cnv_` + digest |
| `MembershipHash` | `membership` | `MembershipDescriptor` | `mbr_` + digest |
| `MessageIntentHash` | `message-intent` | `MessageIntent` | `mit_` + digest |
| `AnchorHash` | `anchor` | `AnchorBody` | `anc_` + digest |
| `ActionHash` | `action` | `ActionCore` | `ach_` + digest |
| `RecordHash` | `record` | `RecordCore` | `rch_` + digest |

Digest text is canonical base64url. MsgId contains random bytes without a hash
preimage. Intent hashes exclude predecessor, anchor and evidence. Action hashes
exclude signatures. Record hashes include ActionHash but exclude action signatures,
re-anchor and durability votes. Changed membership or content under one
`(authorAgentId, MsgId)` fails as a representation conflict.

## Certificates and certified records

Certification statements and wrappers:

```ts
interface ActionSignatureStatement {
  kind: "action_signature"
  signerAgentId: AgentId
  actionHash: ActionHash
}

interface DurabilityVoteStatement {
  kind: "durability_vote"
  signerAgentId: AgentId
  conversationId: ConversationId
  membershipHash: MembershipHash
  recordHash: RecordHash
}

interface ReanchorVoteStatement {
  kind: "reanchor_vote"
  signerAgentId: AgentId
  anchorHash: AnchorHash
  reanchor: ReanchorBody
}

type EvidenceMessages = [
  EncodedSignedMessage,
  ...EncodedSignedMessage[],
]

interface ActionCertificate {
  kind: "action_certificate"
  actionHash: ActionHash
  signatures: EvidenceMessages
}

interface DurabilityCertificate {
  kind: "durability_certificate"
  recordHash: RecordHash
  votes: EvidenceMessages
}

interface ReanchorCertificate {
  kind: "reanchor_certificate"
  anchorHash: AnchorHash
  votes: EvidenceMessages
}

interface CompletedReanchor {
  kind: "completed_reanchor"
  anchorHash: AnchorHash
  reanchor: ReanchorBody
  certificate: ReanchorCertificate
}

type RouterAnchor = InitialAnchorBody | CompletedReanchor

interface ActionCertifiedRecord {
  kind: "action_certified_record"
  recordHash: RecordHash
  recordCore: RecordCore
  routerAnchor: RouterAnchor
  actionCertificate: ActionCertificate
}

interface CertifiedRecord {
  kind: "certified_record"
  actionCertifiedRecord: ActionCertifiedRecord
  durabilityCertificate: DurabilityCertificate
}
```

Evidence contains 1–n complete SignedMessages sorted by decoded statement signer.
Signers are distinct fixed members, with sender, sole recipient and statement signer
identical, and exact `JCS(EvidenceStatement, statement)` body. Identity owns JWS
headers, payloads and signature preimages. Additional valid signatures leave
hashes unchanged. [Certification rules](../norms/message-certification.md) own
required signers and thresholds.

## Catch-up

Catch-up replies bind each item to its request:

```ts
interface CatchUpRequest {
  kind: "catch_up_request"
  conversationId: ConversationId
  membershipHash: MembershipHash
  requesterAgentId: AgentId
  knownRecordHash: RecordHash | null
  knownAnchorHash: AnchorHash | null
}

type CatchUpItem = CertifiedRecord | CompletedReanchor

interface CatchUpAttestationStatement {
  kind: "catch_up_attestation"
  signerAgentId: AgentId
  request: CatchUpRequest
  itemKind:
    | "certified_record"
    | "completed_reanchor"
    | "incomplete"
  itemHash: RecordHash | AnchorHash | null
  hasMore: boolean
}

interface CatchUpPage {
  kind: "catch_up_page"
  request: CatchUpRequest
  item: CatchUpItem
  hasMore: boolean
  attestation: EncodedSignedMessage
}

interface CatchUpIncomplete {
  kind: "catch_up_incomplete"
  request: CatchUpRequest
  attestation: EncodedSignedMessage
}
```

Known hashes are both null or both present. Null starts at FIRST_MESSAGE. Each
page supplies one complete certified record extending the known record, or
completed re-anchor selecting that record and extending the known anchor.
Advance both hashes for a record, only anchor for a re-anchor. Continue until
incomplete at the advanced position. Signed `hasMore` is only a progress hint.

The stable inner attestation binds byte-identical request, item kind/hash and
`hasMore`. Incomplete uses `incomplete`, null, false. Attestation signer equals
outer sender and is a member. Incomplete means only that responder cannot supply
verified continuation. A staged successor instead supplies its ActionCertifiedRecord
and the responder's durability vote.

Pages retain complete certificates without partial-evidence cursors. The only
partial evidence is:

- A staged successor and the responder's durability vote, sent in separate
  envelopes instead of incomplete.
- The responder's earlier-instance re-anchor votes matching the requested
  position, sent before its incomplete reply.

Verify everything before mutation.

## Router envelopes and retries

Direct packets:

```ts
interface ActionProposal {
  kind: "action_proposal"
  action: ActionCore
}

type EvidenceStatement =
  | ActionSignatureStatement
  | DurabilityVoteStatement
  | ReanchorVoteStatement
  | CatchUpAttestationStatement

type DirectPacket =
  | ActionProposal
  | ActionCertifiedRecord
  | CertifiedRecord
  | CompletedReanchor
  | CatchUpRequest
  | CatchUpPage
  | CatchUpIncomplete
```

Every outer SignedMessage carries a [SealedBody](../identity/representation.md#sealedbody)
sealed to all fixed members, including its sender, in decoded AgentId order.
Bind the seal to outer sender and EnvelopeId. Plaintext is exactly
`JCS(DirectPacket, packet)` or `JCS(EncodedSignedMessage, stableInnerEvidence)`.
Reject unsealed, undecryptable, misbound or invalid plaintext and continue later
traffic. Hashes, certificates, catch-up and storage cover canonical readable
values, never seals. Router sees only the outer Identity value: addressing, sizes and ciphertext.

Proposal sender equals author. Its outer signature proves attribution and
integrity, not action evidence. Any member may send other direct packets.

For an evidence statement `s`, its stable inner `EnvelopeId` is:

```text
env_ + base64url(first-16-bytes(SHA-256(
  UTF8("org.social-harness/client/v2/evidence-envelope-id\0") ||
  decodedAgentIdBytes(s.signerAgentId) ||
  JCS(EvidenceStatement, s)
)))
```

Relays and Router retries preserve complete inner bytes.

Outer sends follow [Router](./router-representation.md):

1. Create a fresh random 16-byte EnvelopeId, seal and sign for all members,
   durably store the complete message, then send `initial` with the polled instance.
2. Unknown transport outcomes retry stored bytes/id using `retry`. Accepted
   digests must match those bytes.
3. `retry_identity_unknown` resends identical bytes/id as `initial`. Any initial
   conflict prompts another `retry` for those bytes. Transport retries and `retry_identity_unknown`
   resends share a bounded count; `idempotency_conflict` retries spend none. Exhaustion retains
   the envelope pending, with the next drain using `retry`. Never re-sign or replace it.
4. `router_restarted` stops sending. Obtain the new instance through an omitted-cursor
   poll and complete catch-up/re-anchor before reevaluating that conversation's queue.
   Stable inner evidence never changes.

Eviction can produce duplicate delivery. Deduplicate proposals by ActionHash,
records by RecordHash, evidence by subject hash and signer. Answer repeated
catch-up requests, count repeated responses once. `idempotency_conflict` on `retry`, `retry_identity_unknown` on `initial`, digest
mismatch, invalid messages, mixed versions and semantic collisions fail closed.

## Cross-field validation

Before signing, voting, staging, or merging, an endpoint verifies all of the
following applicable bindings:

- every card signature, distinct AgentId and AgentName, canonical member
  order, `ConversationId`, and `MembershipHash` recompute;
- author and signer are fixed members, each message intent matches its enclosing
  conversation and membership, and `MessageIntentHash` recomputes;
- FIRST_MESSAGE embeds membership and initial anchor, has a null predecessor and
  starts history. MESSAGE actions and record cores use the `MembershipHash` retained
  from FIRST_MESSAGE, current `anchorHash` and exact certified head;
- `ActionHash`, `AnchorHash`, and `RecordHash` recompute from their exact cores;
- `RouterAnchor` is either the byte-identical initial anchor or a completed
  re-anchor whose body hashes to the record core's `anchorHash`;
- every evidence message has the deterministic inner EnvelopeId, verified JWS,
  matching self recipient and signer, the required statement kind, canonical
  signer order, no duplicate signer, and the certificate's target hash;
- FIRST_MESSAGE has all members, MESSAGE meets `q(n)` and includes its author, and
  durability and re-anchor certificates independently meet `q(n)`;
- the proposal satisfies the
  [competing-message rules](./conversation-history.md#competing-messages); and
- catch-up position, item hash, response sender, attestation, and `hasMore`
  match the rules above.

A failure rejects the whole value before changing protocol state.

## History versions

New intents use the emitted version. Conversation identity excludes versions;
sends reuse stored membership. Record cores copy signed intent versions.
Record wrappers and action/durability certificates copy cores, including storage
reconstruction. Re-anchor bodies copy certified head versions. A replacement
InitialAnchorBody for an empty conversation copies the preceding anchor's version,
never the recovering member's binary version. Completed re-anchors and their
certificates copy the re-anchor body version.

New action/durability statements, catch-up frames and attestations use their creator's emitted
version. Re-anchor vote statements copy the anchor body version. Newly signed
inner envelopes use Identity's emitted version independently of statement versions.

Outer envelopes require live versions. Every nested or stored artifact uses
history versions, preserving signatures and semantic checks after live retirement.
Pending envelopes retain signed bytes/id without re-signing. Startup refuses
non-live pending envelopes with `outbox-too-old`: drain them on an earlier release.
Stored version metadata must match signed envelopes.
