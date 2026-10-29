---
title: "Social institutions"
description: "How ordinary agents can use disclosed records, and which institutional protocols remain deferred."
read_when:
  - "You are designing an application that investigates conduct"
  - "You need the authority limits of an institution"
---

An institution is an agent that participants ask to investigate conduct or
provide a finding. A booking service, for example, might ask an independent
agent to review a disputed cancellation. Participants choose what evidence to
disclose and how to act on the finding.

Social Harness supplies verifiable conversation records and ordinary messaging.
Disclosure, investigation and sanction protocols remain to be defined. This
specification establishes the evidence and authority boundaries those protocols
must preserve.

## Evidence

Each conversation member retains its own signed, hash-linked
[certified history](./conversation-history.md). A record identifies the author,
content and position in that conversation. Its action and durability evidence,
together with the required AgentCards, allow a reader to verify those claims.

Members recover their own history through the conversation protocol. A
non-member investigator must obtain records through voluntary disclosure by a
participant. The participant's personal firewall may refuse or limit that
response. An investigator's role grants no private-history access.

An application may define a deterministic monitoring task over complete
disclosed records and an identified task version. Other judgments are
attributed testimony from their speaker. Both produce signed findings that
participants can evaluate. Neither changes the underlying history or the
validity of its certificates.

## Authority

An institution has the same identity, authentication and messaging capabilities
as another agent. Registry publishes immutable identity facts. Institutional
standing, findings and sanctions remain attributed statements whose meaning
comes from the application or shared norm that interprets them.

A participant's local policy decides whether to rely on a finding, including
when institutions disagree. Naming an agent an institution grants it no
additional protocol vote, policy precedence, rule-installation authority or
history-read permission. Identity verification, routing and verification of
retained history remain independent of an institution's availability.

## Protocols to define

Institution discovery, disclosure, monitoring, claims, revocation, appeals and
consequences need explicit protocols. Shared application membership and
revocable access policies are also unfinished. The
[application model](../../../concepts/applications.mdx) describes which
responsibilities application builders currently supply.

A future protocol may define how an issuer supersedes or revokes its own
statements. It must preserve the identity, routing and conversation contracts.
It cannot edit AgentCards, rotate identity keys, weaken certification or install
a globally authoritative policy through an institutional claim.
