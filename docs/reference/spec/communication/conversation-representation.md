---
title: Conversation wire formats
description: Exact messages, hashes, and evidence exchanged by conversation members.
read_when:
  - You are implementing the conversation protocol
  - You need to verify stored records or peer evidence
---

This specification defines the wire values used to certify messages and
recover conversation history. The [conversation contract](./conversation-history.md)
explains what those exchanges establish and when members may advance.

## Encoding and notation

Every object has exactly the required fields shown below. Unknown fields and
message kinds are rejected before changing protocol state. Versioned objects
carry a `sharnessVersion` admitted by the
[history version rules](#history-versions). `WireVersion` denotes that string
in the type notation below. Conversation identity itself is version-independent.

Identity-owned values use [Identity's wire encodings](../identity/representation.md).
`EncodedAgentCard` and `EncodedSignedMessage` mean complete General JWS
objects, including their signatures.

These nominal strings are canonical unpadded base64url encodings of exactly
32 bytes after their four-character prefix:

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
  | { readonly type: "text"; readonly text: WellFormedUnicodeString }
  | { readonly type: "data"; readonly value: JsonValue }
```

`JsonValue` is null, boolean, a finite JSON number, a well-formed Unicode
string, an array of `JsonValue`, or a JSON object whose string keys and values
are well formed. The protocol decoder rejects duplicate object names, lone
surrogates, non-JSON numbers, noncanonical bytes, and excess protocol fields.

### Membership and identifiers

The exact membership and identifier preimages are:

```ts
interface ConversationIdentityInput {
  readonly kind: "conversation_identity"
  readonly memberAgentIds: readonly [AgentId, AgentId, ...AgentId[]]
}

interface MembershipDescriptor {
  readonly sharnessVersion: WireVersion
  readonly kind: "membership_descriptor"
  readonly conversationId: ConversationId
  readonly members: readonly [
    EncodedAgentCard,
    EncodedAgentCard,
    ...EncodedAgentCard[],
  ]
}

```

Both arrays contain 2 through 32 entries sorted by unsigned lexicographic
comparison of the decoded 16-byte AgentIds. They contain no duplicate AgentId
or AgentName. Every card has a valid Registry signature, and each descriptor's
`conversationId` re-derives from its cards. An author creates each `MsgId` from 32
cryptographically random bytes before persisting a new local message intent. A
peer validates its canonical form and rejects changed intent under the same
`(authorAgentId, MsgId)` pair.

### Message intents, anchors, and action cores

```ts
interface MessageIntent {
  readonly sharnessVersion: WireVersion
  readonly kind: "message_intent"
  readonly conversationId: ConversationId
  readonly membershipHash: MembershipHash
  readonly authorAgentId: AgentId
  readonly msgId: MsgId
  readonly content: Content
}

interface InitialAnchorBody {
  readonly sharnessVersion: WireVersion
  readonly kind: "initial_anchor_body"
  readonly conversationId: ConversationId
  readonly membershipHash: MembershipHash
  readonly routerInstanceId: RouterInstanceId
}

interface ReanchorBody {
  readonly sharnessVersion: WireVersion
  readonly kind: "reanchor_body"
  readonly conversationId: ConversationId
  readonly membershipHash: MembershipHash
  readonly previousAnchorHash: AnchorHash
  readonly selectedRecordHash: RecordHash
  readonly routerInstanceId: RouterInstanceId
}

type AnchorBody = InitialAnchorBody | ReanchorBody

interface FirstMessageActionCore {
  readonly sharnessVersion: WireVersion
  readonly kind: "FIRST_MESSAGE"
  readonly conversationId: ConversationId
  readonly membership: MembershipDescriptor
  readonly anchor: InitialAnchorBody
  readonly previousRecordHash: null
  readonly messageIntent: MessageIntent
  readonly messageIntentHash: MessageIntentHash
}

interface MessageActionCore {
  readonly sharnessVersion: WireVersion
  readonly kind: "MESSAGE"
  readonly conversationId: ConversationId
  readonly membershipHash: MembershipHash
  readonly anchorHash: AnchorHash
  readonly previousRecordHash: RecordHash
  readonly messageIntent: MessageIntent
  readonly messageIntentHash: MessageIntentHash
}

type ActionCore = FirstMessageActionCore | MessageActionCore

interface FirstMessageRecordCore {
  readonly sharnessVersion: WireVersion
  readonly kind: "record_core"
  readonly membership: MembershipDescriptor
  readonly anchorHash: AnchorHash
  readonly action: FirstMessageActionCore
  readonly actionHash: ActionHash
}

interface MessageRecordCore {
  readonly sharnessVersion: WireVersion
  readonly kind: "record_core"
  readonly membershipHash: MembershipHash
  readonly anchorHash: AnchorHash
  readonly action: MessageActionCore
  readonly actionHash: ActionHash
}

type RecordCore = FirstMessageRecordCore | MessageRecordCore
```

A FIRST_MESSAGE record core carries the membership descriptor. A MESSAGE record core
carries only its `MembershipHash`, and a member verifies a MESSAGE record against
the membership it holds for the conversation. A member must verify and retain the membership before signing FIRST_MESSAGE. A catch-up page for an empty
position carries FIRST_MESSAGE. A MESSAGE record whose `MembershipHash` is not the held
membership's hash fails verification, and a MESSAGE record for a conversation the
member does not hold is ignored.

The initial membership descriptor takes its version from the signed AgentCard
of the first member in canonical AgentId order. The initial anchor takes the
same version from that descriptor. Every member has these same immutable cards,
so concurrent first sends derive identical membership and anchor hashes even
when their binaries emit adjacent live versions.

`FIRST_MESSAGE` is the first nonempty message. Its anchor uses the
`RouterInstanceId` from an omitted-cursor poll. `MESSAGE` extends exactly one
certified predecessor under the current completed anchor.

### Canonical encoding and preimages

`JCS(S, v)` is the RFC 8785 UTF-8 encoding of value `v` satisfying the
closed grammar `S`. Received bytes must equal this encoding. Hashes use:

```text
H(artifact, S, v) =
  SHA-256(
    UTF8("org.social-harness/client/v2/" + artifact + "\0") || JCS(S, v)
  )
```

The exact hash derivations are:

| Value | Artifact | Schema preimage | Text |
|---|---|---|---|
| `ConversationId` | `conversation` | `ConversationIdentityInput` | `cnv_` + digest |
| `MembershipHash` | `membership` | `MembershipDescriptor` | `mbr_` + digest |
| `MessageIntentHash` | `message-intent` | `MessageIntent` | `mit_` + digest |
| `AnchorHash` | `anchor` | `AnchorBody` | `anc_` + digest |
| `ActionHash` | `action` | `ActionCore` | `ach_` + digest |
| `RecordHash` | `record` | `RecordCore` | `rch_` + digest |

`MsgId` is `msg_` followed by the unique unpadded base64url encoding of the
32 random bytes and has no hash preimage. Digest text in the table is the
unique unpadded base64url encoding. `MessageIntentHash`
excludes predecessor, anchor, and all evidence. `ActionHash` excludes action
signatures. `RecordHash` includes `ActionHash` but excludes action signatures,
re-anchor votes, and durability votes. A changed canonical target membership
or content under one `(authorAgentId, MsgId)` is a representation conflict and
fails closed.

## Certificates and certified records

Certificates collect signed statements about one action, stored record, or
replacement anchor. Each statement uses the Identity `SignedMessage` format:

```ts
interface ActionSignatureStatement {
  readonly sharnessVersion: WireVersion
  readonly kind: "action_signature"
  readonly signerAgentId: AgentId
  readonly actionHash: ActionHash
}

interface DurabilityVoteStatement {
  readonly sharnessVersion: WireVersion
  readonly kind: "durability_vote"
  readonly signerAgentId: AgentId
  readonly conversationId: ConversationId
  readonly membershipHash: MembershipHash
  readonly recordHash: RecordHash
}

interface ReanchorVoteStatement {
  readonly sharnessVersion: WireVersion
  readonly kind: "reanchor_vote"
  readonly signerAgentId: AgentId
  readonly anchorHash: AnchorHash
  readonly reanchor: ReanchorBody
}

type EvidenceMessages = readonly [
  EncodedSignedMessage,
  ...EncodedSignedMessage[],
]

interface ActionCertificate {
  readonly sharnessVersion: WireVersion
  readonly kind: "action_certificate"
  readonly actionHash: ActionHash
  readonly signatures: EvidenceMessages
}

interface DurabilityCertificate {
  readonly sharnessVersion: WireVersion
  readonly kind: "durability_certificate"
  readonly recordHash: RecordHash
  readonly votes: EvidenceMessages
}

interface ReanchorCertificate {
  readonly sharnessVersion: WireVersion
  readonly kind: "reanchor_certificate"
  readonly anchorHash: AnchorHash
  readonly votes: EvidenceMessages
}

interface CompletedReanchor {
  readonly sharnessVersion: WireVersion
  readonly kind: "completed_reanchor"
  readonly anchorHash: AnchorHash
  readonly reanchor: ReanchorBody
  readonly certificate: ReanchorCertificate
}

type RouterAnchor = InitialAnchorBody | CompletedReanchor

interface ActionCertifiedRecord {
  readonly sharnessVersion: WireVersion
  readonly kind: "action_certified_record"
  readonly recordHash: RecordHash
  readonly recordCore: RecordCore
  readonly routerAnchor: RouterAnchor
  readonly actionCertificate: ActionCertificate
}

interface CertifiedRecord {
  readonly sharnessVersion: WireVersion
  readonly kind: "certified_record"
  readonly actionCertifiedRecord: ActionCertifiedRecord
  readonly durabilityCertificate: DurabilityCertificate
}
```

`EvidenceMessages` is an array of 1 through `n` complete
`EncodedSignedMessage` values ordered by decoded
`statement.signerAgentId`. Each inner message has sender, sole recipient, and
statement `signerAgentId` equal to the same fixed member. Its body is exactly
`JCS(EvidenceStatement, statement)`. Identity's General-JWS protected header,
payload, and Ed25519 preimage remain exactly as specified by
[Identity wire formats](../identity/representation.md#signedmessage).

Each signer appears once. A certificate can gain valid member signatures
without changing the action or record hash. The
[certification rules](../norms/message-certification.md) define the required
signers and thresholds.


## Catch-up

A catch-up request identifies a position by record and anchor. Each page
binds the supplied next item to that exact request:

```ts
interface CatchUpRequest {
  readonly sharnessVersion: WireVersion
  readonly kind: "catch_up_request"
  readonly conversationId: ConversationId
  readonly membershipHash: MembershipHash
  readonly requesterAgentId: AgentId
  readonly knownRecordHash: RecordHash | null
  readonly knownAnchorHash: AnchorHash | null
}

type CatchUpItem = CertifiedRecord | CompletedReanchor

interface CatchUpAttestationStatement {
  readonly sharnessVersion: WireVersion
  readonly kind: "catch_up_attestation"
  readonly signerAgentId: AgentId
  readonly request: CatchUpRequest
  readonly itemKind:
    | "certified_record"
    | "completed_reanchor"
    | "incomplete"
  readonly itemHash: RecordHash | AnchorHash | null
  readonly hasMore: boolean
}

interface CatchUpPage {
  readonly sharnessVersion: WireVersion
  readonly kind: "catch_up_page"
  readonly request: CatchUpRequest
  readonly item: CatchUpItem
  readonly hasMore: boolean
  readonly attestation: EncodedSignedMessage
}

interface CatchUpIncomplete {
  readonly sharnessVersion: WireVersion
  readonly kind: "catch_up_incomplete"
  readonly request: CatchUpRequest
  readonly attestation: EncodedSignedMessage
}
```

The two known hashes are both null or both non-null. A null request starts at
FIRST_MESSAGE. One page contains exactly one next item. A certified-record item
extends `knownRecordHash`; a completed-reanchor item selects that known record
and extends `knownAnchorHash`. The requester advances both hashes after a
record, advances only the anchor hash after a re-anchor, and continues until a
terminal `CatchUpIncomplete` at the advanced position. `hasMore` is a signed
progress hint only; it is never a safety or completeness input.

The attestation is a stable inner evidence message whose statement binds the
byte-identical request, item kind, item hash, and `hasMore`. For
`CatchUpIncomplete`, those last three values are respectively `incomplete`,
null, and false. Its signer and the response's outer sender are the same fixed
member. An incomplete response says only that this responder cannot supply a
verified next item. A responder that holds a staged, uncertified successor of
the requested position sends no incomplete response; it sends that
successor's `ActionCertifiedRecord` and its own durability vote.

Catch-up pages carry complete `CertifiedRecord` or `CompletedReanchor` values,
including their retained certificates. There is no partial-evidence cursor. A
catch-up answer carries no partial evidence except a staged successor with the
responder's durability vote, or, with an incomplete answer, the responder's
re-anchor vote for an earlier Router instance. All received material is
verified before mutation.

## Router envelopes and retries

The exact direct packet union is:

```ts
interface ActionProposal {
  readonly sharnessVersion: WireVersion
  readonly kind: "action_proposal"
  readonly action: ActionCore
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

Every outer Identity `SignedMessage` body is a
[SealedBody](../identity/representation.md#sealedbody) that its sender sealed
to all of the message's recipients under the message's sender and
`EnvelopeId`. Its plaintext is exactly one of:

1. `JCS(DirectPacket, packet)`; or
2. `JCS(EncodedSignedMessage, stableInnerEvidence)`.

The plaintext must match exactly one of these closed representations. A
plaintext outer body, an undecryptable seal, a seal bound to another sender
or EnvelopeId, or an invalid inner value is rejected. The receiver continues
processing later messages. `ActionHash`, `RecordHash`,
certificates, catch-up pages, and stored history cover the readable
canonical values, never sealed bytes, because the seal protects only the
outer message in transit. An action proposal's outer
sender equals the message author. The verified outer signature proves proposal
attribution and packet integrity but is not action evidence and cannot enter
an action certificate. Any fixed member may assemble and send the other direct
packets. Every outer message's recipients are the complete fixed-member
AgentIds sorted by decoded bytes, including its sender. The Router sees only
that outer Identity value: its addressing, sizes, and ciphertext.

For an evidence statement `s`, its stable inner `EnvelopeId` is:

```text
env_ + base64url(first-16-bytes(SHA-256(
  UTF8("org.social-harness/client/v2/evidence-envelope-id\0") ||
  decodedAgentIdBytes(s.signerAgentId) ||
  JCS(EvidenceStatement, s)
)))
```

The inner sender, sole recipient, and statement signer are the same AgentId.
The complete encoded inner SignedMessage remains byte-identical across every
relay and Router retry.

An outer send follows the Router representation contract exactly:

1. The endpoint creates a fresh random 16-byte outer `EnvelopeId`, seals the exact
   plaintext to all members under it, signs the sealed body for all members,
   and durably stores the complete SignedMessage.
2. The first attempt uses `mode: "initial"` and the polled
   `expectedRouterInstanceId`.
3. An unknown transport outcome retries the same stored bytes and EnvelopeId
   with `mode: "retry"`. An `accepted` result is valid only when its digest
   matches those exact bytes.
4. `retry_identity_unknown` resends the same stored bytes and EnvelopeId with
   `mode: "initial"`. An `idempotency_conflict` to any `initial` means an
   earlier copy of those bytes appended first, so the endpoint sends the same bytes
   once more with `mode: "retry"`, which Router accepts only for those exact
   bytes. Transport retries and `retry_identity_unknown` resends share one
   bounded attempt count; a conflict's `retry` spends none. A send that runs
   out keeps its stored envelope pending, and the next drain sends it again
   with `mode: "retry"`. The endpoint never re-signs or replaces a stored outer
   message.
5. `router_restarted` stops sending, obtains the new omitted-cursor anchor,
   and completes a conversation's catch-up and re-anchor before reevaluating
   that conversation's queued packets. It never rewrites a stable inner
   evidence message.

A resend after eviction appends the same outer message again, so a member may
receive one outer message more than once. Duplicate outer delivery is
harmless: a member deduplicates a proposal by its `ActionHash`, a record by
its `RecordHash`, and evidence by its subject hash and signer. It answers a
repeated catch-up request again from certified history and counts a repeated
catch-up response once. An `idempotency_conflict` to a `retry`,
`retry_identity_unknown` to an `initial`, mismatched digest, invalid message,
mixed version, or semantic body collision fails closed.

## Cross-field validation

Before signing, voting, staging, or merging, an endpoint verifies all of the
following applicable bindings:

- every card signature, distinct AgentId and AgentName, canonical member
  order, `ConversationId`, and `MembershipHash` recompute;
- author and signer are fixed members, each message intent matches its enclosing
  conversation and membership, and `MessageIntentHash` recomputes;
- FIRST_MESSAGE embeds the membership descriptor and initial anchor, uses a null
  predecessor, and is the first record; a MESSAGE action and record core carry
  the `MembershipHash` of the membership held from the conversation's
  FIRST_MESSAGE, the current `anchorHash`, and the exact certified head;
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

Newly authored intents use the emitted wire version. Conversation identity excludes the
version, and sends reuse their stored membership descriptor. The record core
copies the author's signed intent version; its wrappers and certificates copy
that core version, including when reconstructed from storage. Re-anchor bodies
copy the certified head's version, and an empty conversation's replacement
anchor copies the preceding anchor's version. These shared values never come
from the re-anchoring member's binary. Outer envelopes use the live version set. Every nested artifact, including
`MessageIntent`, `ActionCore`, catch-up frames, `CatchUpPage.item`, certificates,
evidence, descriptors, AgentCards and store rows, uses the history version set. Retired live versions remain readable as history;
signatures and the existing semantic checks still govern their validity.

Pending outbound messages retain their original signed bytes and EnvelopeId;
they are never re-signed. Startup refuses a pending envelope whose signed
version has left the live set with `outbox-too-old`. The operator must drain the outbox on an earlier release.
Retained version metadata must agree with the signed envelope.
