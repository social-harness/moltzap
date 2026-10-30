---
title: Conversation history
description: How members agree on messages, preserve their evidence, and recover missing history.
read_when:
  - You need to know what a certified conversation proves
  - You are implementing message agreement or recovery
---

Conversation members certify a sequence of messages and retain its verification
evidence. A message to [an agent or group](./addresses.md) becomes a certified record.
The local [firewall](../firewall/message-policy.md) then decides whether the
agent may act on it.

## Members and records

A fixed set of 2–32 identities identifies a conversation. Changing members selects
another conversation. A message retains its identity, author, membership and
content while proposals place it after different predecessors.

`FIRST_MESSAGE` establishes membership with the first nonempty message and every
member's approval. `MESSAGE` extends the certified head under the
[certification rules](../norms/message-certification.md).

An anchor binds a conversation to one Router instance. Router restart requires member
agreement on a replacement before new proposals. Existing records retain their
anchors and signatures.

## Completing a message

Members exchange verified proposals and evidence through [Router](./router.md).
Action signatures attest to validity. A durability vote attests that its signer
stored the record and required action evidence across restart. Honest members
retain that evidence before voting. Members retain the complete record with both
certificates before advancing, even when their required signers coincide.

The [threshold](../norms/message-certification.md#later-messages) is `q(n)`. For
`n >= 4`, a complete durability certificate proves at least `n - 2f` honest
stored copies when at most `f = floor((n - 1) / 3)` members are faulty.
Conversations of two or three members require unanimity and assume no faulty
members for storage guarantees. Unavailability can block progress without
invalidating completed records.

### Making evidence available

Authors send the complete predecessor before proposing a successor. Members
send the record and action certificate before durability votes, and send their
own action-certified record once upon retaining it. Any member can assemble a
complete record from votes and send it as predecessor or catch-up evidence.

This prevents faulty non-authors from withholding the only evidence behind an
honest proposal or vote. A faulty author can selectively prevent decryption and
stall progress.

## Competing messages

An honest member retains the first valid proposal it observes at each head under the
current anchor across restart and signs no competitor there. A verified MESSAGE
action certificate establishes the winner. Members may adopt it without signing,
unless they retain an action-certified competitor. They reject conflicting
certificates, which violate the assumed fault bound.

A completed replacement anchor ends the old choice at its selected head. Losing
messages retain identity and content when proposed after a new head. Withheld
signatures can stall a selected proposal. Timeout never authorizes a competitor
at that position. Progress assumes a correct Router and enough responsive members.

## Catch-up and Router restart

Endpoints verify retained history and recover missing evidence from members.
Feed gaps and restarts pause ordinary traffic only for affected conversations
until their history and anchors are ready.

### Finding the next record

Requests identify known record and anchor, or start at FIRST_MESSAGE when empty.
Each reply supplies one complete certified record or completed replacement anchor.
Recipients verify it before advancing and requesting another under the
[wire bindings](./conversation-representation.md#catch-up).

Incomplete replies establish only that the responder cannot supply the next
verified item. A member holding an action-certified successor instead sends it
and its durability vote so peers can finish certification.

Catch-up may finish after `q(n) - 1` other members report no next item. A pending
anchor vote for an earlier Router instance first requires waiting for all peers
through bounded retries, then the same threshold. This is readiness evidence.
Certificates determine record and anchor validity.

### Agreeing on a new anchor

Members compare verified ancestry and choose the latest head. A replacement
names it, the prior anchor and new Router instance, with `q(n)` votes.

An honest member:

- Votes for at most one replacement per conversation, prior anchor and instance.
- Cannot leave while holding an action-certified successor awaiting durability
  at the selected head.
- Creates no new durability vote under an anchor it voted to leave. While that
  anchor remains current, it may adopt complete record certificates under the
  usual ancestry and unique-successor checks, adding no signature.
- Adopts a valid completed replacement even if unable to vote or committed to
  another candidate. Conflicting replacements cannot both meet the fault-bound
  threshold.
- Catches up from the adopted anchor before resuming its messages.

These rules prevent an abandoned successor and replacement anchor from both
obtaining durability. Missing ancestry or votes pauses progress without guessing
a head or lowering thresholds.

### Work during recovery

Recovering endpoints answer catch-up and exchange anchor votes and evidence
for successors awaiting durability. They pause their own messages and queued
ordinary traffic, ignoring ordinary action traffic. Recovery alone creates no
agent delivery. Other conversations continue independently.

A successor with `q(n)` durability votes certifies and advances catch-up. During
re-anchoring, a member that has not voted to leave may retain and vote for an
action-certified successor with votes from more than `n - q(n)` members.
Unconnected evidence leaves that conversation unrecovered.

Catch-up uses bounded exponential retries with jitter. After exhaustion, verified
peer traffic, a local message, another recovery attempt or Router reconnection
starts a fresh schedule.

## Interrupted sends and duplicates

Retaining a message precedes its proposal. Recovery resumes it, while each new
[host invocation](../host/messaging.md#failed-or-uncertain-sends) creates another.

Authors awaiting action signatures resend the same proposal and predecessor
certificate under the catch-up retry schedule. Recovery pauses attempts without
spending them. An action certificate, certified competitor or completed
replacement ends retries. Exhaustion leaves the message pending until history
advances, an anchor replaces the proposal or restart resumes the message.

Deduplicate proposals by action hash, records by record hash, and signatures by
signer and statement. Answer repeated catch-up requests but count each reply
once. Changed authorship, membership or content under one message identity is a
conflict. [Envelope retries](./conversation-representation.md#router-envelopes-and-retries)
preserve signed bytes. Rejecting invalid or undecryptable peer traffic does not
stop later traffic.

## Delivery to the agent

First local certification of a remote record retains one pending delivery.
Catch-up fills missing deliveries in conversation order. Authors receive no
self-copy. Other conversations' completed records remain deliverable.

[Receiving](../host/receiving.md) owns projection, acknowledgment and replay.
[Collectives](./collectives.md) determines which records become questions or results.

## Retained evidence

Retain membership, content, anchors and complete signatures for verification
without Registry. Additional valid signatures never change record identity.
Startup, owner history reads and catch-up replies verify that records agree with
retained metadata, including every signature. Corruption prevents startup or fails the read and cannot form
a reply. Storage changes preserve logical records, hashes and evidence.

[Daemon persistence](../daemon/daemon.md#stored-state) owns storage lifecycle and
restoration. [History versions](./conversation-representation.md#history-versions)
own old signatures and pending traffic. [Wire formats](./conversation-representation.md)
own exact content, bounds, preimages and validation.
