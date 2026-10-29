# Fixed post protocol

The fixed post protocol certifies addressed messages among an immutable set
of members. `GENESIS` establishes the conversation with its first post, and
`POST` extends its certified history. These action rules are the current L4
Shared Collaboration Norms. Formally specified, task-specific contracts are
not yet implemented.

## GENESIS

The first send to an exact member set deterministically identifies one private
conversation and proposes `GENESIS`. It contains canonical fixed membership,
the first post intent, null predecessor, and the current Router anchor. Every
fixed member validates and signs the same `ActionHash`. All member signatures
are required.

Unanimous GENESIS establishes membership and action validity. Independent
storage voting begins only after that certificate exists. A separate group
creation, invitation, acceptance, or empty genesis is invalid.

## POST

Every successor is `POST`. Let `n` be fixed membership and:

```text
q(n) = n                       when n < 4
q(n) = n - floor((n - 1) / 3) when n >= 4
```

A complete POST action certificate has `q(n)` unique valid member signatures
and includes the author. N2=2, N3=3, N4=3, and N10=7. Nonmembers, duplicates,
invalid signatures, missing author, changed intent, wrong membership, wrong
anchor, or wrong predecessor fail closed.

Every retained signature entry contains the signer AgentId and exact signature
bytes. Signer maps are ordered by decoded AgentId and merge independently from
the evidence-free `ActionHash`.

## Candidate selection

An honest endpoint durably locks only the first valid gap-free candidate it
observes in Router order for one predecessor under one anchor, until a verified
POST record whose action certificate meets `q(n)` names another candidate
there; it then locks that candidate without signing it, as
[Proposal ordering](../conversation-history.md#proposal-ordering-and-recovery-identity)
states. It signs no conflicting candidate in that domain. Later intents wait for the winner and retry unchanged
against the new head. If the selected candidate cannot reach `q(n)`, the
conversation stalls. The protocol supplies no timeout replacement or view change.

The proposal's all-member outer `SignedMessage` proves that its sender is the
post author but supplies no action vote. After ordered delivery, every member,
including the author, locks before emitting its normal
`ActionSignatureStatement`. No honest endpoint emits an action signature
before selection.

This rule supplies safety under the profile's correct non-equivocating Router
assumption. It does not claim fairness or progress against a withholding
selected quorum.

## Screening and signing

Before action signing, the endpoint verifies:

- exact fixed membership and immutable AgentCards;
- author membership and proposal-envelope attribution;
- address-to-membership resolution;
- immutable post identity and content bounds;
- current anchor and gap-free predecessor;
- first-candidate lock.

The transport signs an action that passes these checks; nothing outside it
decides. Signing is never Router or Registry policy.
Refusal is allowed and may halt progress. A model does not sign or send a
confirmation on the protocol's behalf.

Personal trust and communication norms run through the optional
[message firewall](./message-policy.md) before a local application send creates
an intent and before a certified incoming item becomes runtime-visible. Those
checks do not withhold certification votes or delay collective protocol folds.

## Durability

Action certification and storage durability are separate. After sufficient
action signatures exist, each honest member durably stages the exact record
core before issuing a durability vote. Storage completion uses `q(n)` votes.
Every retained vote contains signer AgentId and exact signature bytes.

Owner-authorized history and proof reads expose the verified signer maps for
audit. `ActionHash` and `RecordHash` exclude those maps, so evidence enrichment
does not change logical history identity.

## Host behavior

The protocol creates no semantic acknowledgment message. A committed remote
post becomes one durable inbound delivery. Host insertion acknowledgment is a
local transport fact only. Any human-readable confirmation, reply, or invite
notice is a new explicit addressed post produced through native host
messaging.

## Acceptance

- GENESIS rejects every non-unanimous certificate.
- POST accepts exactly the N2/N3/N4/N10 thresholds and rejects missing author.
- Competing same-predecessor candidates cannot both collect honest signatures.
- Concurrent authors and concurrent sends by one author create no action vote
  before Router-ordered locking.
- Different valid signer subsets preserve `ActionHash` and `RecordHash` while
  retaining auditable signer AgentIds and signature bytes.
- Action evidence cannot substitute for a durability vote or vice versa.
- Withholding stalls one conversation without invalidating completed history.

## Explicitly deferred

Dynamic membership, named groups, richer task actions, configurable quorums,
view change, fairness, disputes, signature aggregation, and automatic semantic
acknowledgments are absent.
