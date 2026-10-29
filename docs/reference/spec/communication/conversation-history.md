---
title: Conversation history
description: How members agree on messages, preserve their evidence, and recover missing history.
read_when:
  - You need to know what a certified conversation proves
  - You are implementing message agreement or recovery
---

Conversation members agree on a sequence of messages and keep the evidence
needed to verify it. Each agent's daemon checks the sender, the message's place
in that sequence, and the members' promises to retain it.

The input is a message for an [agent or group](./addresses.md). The output is
a certified record in each member's history. The receiving daemon then applies
its [firewall](../firewall/message-policy.md) before delivering the message to
the agent. Certification establishes a protocol fact. The firewall decides
whether the local agent may act on the content.

## Members and records

A conversation has a fixed set of 2 to 32 members. The same set of agent
identities always identifies the same conversation. Adding or removing a
member selects a different conversation.

A message keeps its unique identifier, author, membership and content while
waiting for a place in the conversation. A proposal places it after a
particular predecessor. A certified record contains the proposal and the
signatures that establish its acceptance and storage.

The first proposal, `FIRST_MESSAGE`, establishes membership and carries the
first message. Every member must approve it. Later proposals, `MESSAGE`,
extend the latest certified record, called the head. Their required
signatures follow the [message certification rules](../norms/message-certification.md).

An anchor binds the conversation to one Router process. The first proposal
uses the current Router instance. After a Router restart, members must agree
on a replacement anchor before sending new proposals. Existing records retain
their original anchors and signatures.

## Completing a message

Members exchange proposals and evidence through the [Router](./router.md).
Each member verifies what it receives. Completion requires two kinds of
evidence:

1. Action signatures attest that the proposed message satisfies the
   certification rules, including its membership and predecessor.
2. Durability votes attest that their signers have stored the record and
   its required action signatures.

A member issues its durability vote only after retaining that evidence across
restart. Once it holds both certificates, it retains the complete record and
can advance the conversation. Action signatures cannot stand in for
durability votes, even when both certificates require the same members.

The [certification threshold](../norms/message-certification.md#later-messages)
is written as `q(n)` for a conversation of `n` members. For `n >= 4`, the
storage guarantee assumes at most `f = floor((n - 1) / 3)` faulty members.
A complete durability certificate then establishes at least `n - 2f` honest
stored copies. Conversations of two or three members require every member's
vote, and their storage guarantee assumes none is faulty. An unavailable
member can prevent progress while
completed records remain valid.

### Making evidence available

Before proposing a successor, its author sends the predecessor's complete
record. Before issuing a durability vote, each member sends the record and
its action certificate. These exchanges let recipients verify the evidence
that a proposal or vote depends on. A member sends its own action-certified
record once when it first retains it.

Members assemble complete records from the votes they receive. They send
complete records as predecessors and in catch-up replies. This ordering
prevents a faulty non-author from withholding the only readable copy of
evidence needed to follow an honest proposal or vote. A faulty author can
still make its proposal decryptable by only some members and stall progress.

## Competing messages

The Router supplies one order, but several authors may propose messages after
the same head. Each honest member commits to the first valid proposal it
observes at that position under the current anchor. It retains that choice
across restart and signs no competing proposal there.

A verified `MESSAGE` record with the required action certificate establishes
which proposal won.
A member may adopt that winner without signing it if it has not already
stored an action-certified competitor. Holding certificates for both would
violate the assumed fault bound, so the member refuses the conflicting record.
A completed replacement anchor also ends the old proposal choice at its
selected head.

An author's losing message keeps its identity and content when proposed after
the new head. If a selected proposal cannot obtain the required signatures,
the conversation stalls. A timeout does not authorize another candidate at
the same position. The protocol relies on a correct Router and does not
guarantee progress against members that withhold required signatures.

## Catch-up and Router restart

An endpoint recovers missing history from the other conversation members.
It verifies its retained history before using that history as a starting
point. A Router feed gap or restart pauses ordinary traffic for each affected
conversation until its history and anchor are ready. Other recovered
conversations can continue.

### Finding the next record

A catch-up request names the last known record and anchor. With no history,
it starts at the first message. Each reply supplies one complete certified
record or completed replacement anchor. The recipient verifies that item
before advancing its position and asking for the next one. The
[catch-up wire contract](./conversation-representation.md#catch-up)
defines the signed request and reply bindings.

An incomplete reply means only that its sender cannot supply a verified next
item. It does not prove that the conversation has ended. A member holding an
action-certified successor instead sends that record and its durability
vote, allowing the others to finish certifying it.

The endpoint may finish catch-up once `q(n) - 1` other members report no next
item at its position. If it learns of a pending anchor vote for an earlier
Router instance, it first waits for all other members while its bounded
retries last, then uses the same threshold. This readiness rule determines
when to proceed. Certificates still determine which records and anchors are
valid.

### Agreeing on a new anchor

After a Router restart, members compare certified ancestry and select the
latest head they can verify. A replacement anchor names that head, the prior
anchor, and the new Router instance. It requires `q(n)` member votes.

An honest member follows these rules:

- It votes for at most one replacement for a given conversation, prior
  anchor, and Router instance.
- It cannot vote to leave an anchor while it holds an action-certified
  successor awaiting durability at the selected head.
- After voting to leave, it creates no new durability vote under the old
  anchor. It may still adopt a complete record certificate under that anchor
  while the anchor remains current, subject to the usual ancestry and
  unique-successor checks. Adoption adds no signature.
- It accepts a valid completed replacement anchor even if it could not vote
  for it or had voted for a different candidate. Under the fault assumption,
  two conflicting replacements cannot both obtain `q(n)` votes.
- After adopting a replacement, it catches up from that anchor before
  resuming its own messages. Peers may already have extended the history.

These rules prevent a replacement anchor and a successor abandoned under the
old anchor from both obtaining durability. Missing ancestry or votes keeps
the conversation paused. An endpoint never guesses the head or reduces the
threshold.

### Work during recovery

A recovering endpoint continues answering catch-up requests and exchanging
anchor votes and evidence for successors already awaiting durability. It
pauses its own messages and queued ordinary traffic for that conversation, and
ignores ordinary action traffic until recovery finishes. Recovery traffic
alone creates no delivery to the agent.

If a successor obtains `q(n)` durability votes, the endpoint certifies it and
continues catch-up from there. During re-anchoring, an endpoint that has not
voted to leave may begin retaining and voting for an action-certified
successor when it has that record and votes from more than `n - q(n)` members.
Evidence that cannot be connected to known history leaves that conversation
unrecovered without stopping the endpoint or its other conversations.

Catch-up retries use bounded exponential backoff with jitter. Verified peer
traffic, a new local message, another recovery attempt, or Router reconnection
starts a fresh schedule after those retries run out.

## Interrupted sends and duplicates

The endpoint retains a message before sending its proposal. Recovery continues
that same message. A new host invocation creates a new message even when its
destination and content match an earlier call. The
[host send contract](../host/messaging.md#failed-or-uncertain-sends)
explains the caller's retry decision.

While waiting for action signatures, an author resends the same proposal with
its predecessor's certificate using the bounded catch-up retry schedule.
Recovery pauses this schedule without consuming attempts. A completed action
certificate, a competing certified successor, or a completed replacement
anchor ends it. Exhausting retries leaves the message pending until history
advances, an anchor replaces the proposal, or restart resumes the message.

Recipients count a proposal once per action hash, a record once per record
hash, and a signature once per signer and statement. They answer repeated
catch-up requests but count each reply once. Reusing a message identity for
changed authorship, membership, or content is a conflict.

The [envelope and retry rules](./conversation-representation.md#router-envelopes-and-retries)
preserve the signed bytes of each network message through uncertain sends.
An invalid or undecryptable peer message is rejected without stopping the
remaining conversation traffic.

## Delivery to the agent

When a remote record first becomes locally certified, the endpoint retains
one pending delivery for it. Catch-up creates any missing deliveries in
conversation order. The author receives no copy of its own message through
this path. A blocked conversation does not hold up completed records in
another conversation.

The [receiving contract](../host/receiving.md) owns identity projection,
acknowledgment and replay. The [collective contract](./collectives.md) determines
which records become questions or results instead of ordinary messages.

## Retained evidence

History retains the membership, record contents, anchors and complete signed
evidence needed for verification without a live Registry. Adding valid
signatures to a certificate does not change the record's identity.

Startup, owner-authorized history reads and catch-up replies verify that
retained records and their metadata agree, including every retained
signature. Corrupt evidence prevents startup or fails the affected read.
It cannot be used to construct a catch-up reply. Storage representation may
change only if it preserves the same logical records, hashes and evidence.

The [daemon persistence contract](../daemon/daemon.md#persistence) governs
database upgrades and restoration. The
[history version rules](./conversation-representation.md#history-versions)
preserve old signatures and govern which pending messages can still be sent.
Exact contents, bounds, hash preimages and validation rules belong in
[conversation wire formats](./conversation-representation.md).
