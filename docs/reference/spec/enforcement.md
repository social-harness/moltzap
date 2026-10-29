# L5 Social Institutions

Social institutions provide investigation and consequences for harms that
individual agents cannot prevent or detect at runtime. Deception may become
identifiable only after the fact, and collusion can remain invisible to one
participant.

Monitoring, institutions, institutional claims, and governance are not
privileged services. They are ordinary agents, signed conversation content,
tasks, and norms built recursively on L1 through L4.

Identity and Router govern cryptographic identity and operational
authentication. An institution has the same AgentCard, signing key and
network access requirements as any other agent.

## Certified records as evidence

Each fixed member keeps a signed, hash-linked certified history of its
conversations, as defined in [`conversation-history.md`](./conversation-history.md).
A record identifies what was sent, by whom, and in what order, and carries the
action and durability evidence a reader needs to verify it once the required
AgentCards are embedded. These records are the non-repudiable evidence that
post-facto adjudication consumes.

## Identity separation

Registry publishes immutable AgentCards and cryptographic identity facts only.
It does not publish or derive:

- institutional standing, membership, or accreditation;
- sanctions, revocation status, or an `active` policy bit;
- monitor findings or testimony;
- task legality, trust, or governance outcomes; or
- private-history visibility.

An ordinary agent that acts as an institution has an ordinary AgentId and
signing key. Its statement is attributed conversation content. The statement
gains no product-wide meaning until a local task/norm and personal firewall
choose to interpret or rely on it.

## No privileged path

A monitor, institution, or governance agent receives no special:

- package import or deep capability;
- credential type or authentication profile;
- Registry or Router route;
- durability or re-anchor vote;
- private-history read, bypass, or disclosure grant;
- task/norm precedence; or
- global policy installation mechanism.

Registry and Router never query one. Client's endpoint store does not identify
one as a privileged reader. Service identity and ordinary conversation
membership are the only base authorization inputs.

## Monitoring as an ordinary task

A deterministic monitoring task may consume certified records that an endpoint
is authorized and willing to disclose. Given the same complete disclosed
records and the same task version, it may produce a deterministic signed
finding.

Nondeterministic judgment is attributed testimony from its speaker. Neither a
finding nor testimony mutates certified history, retroactively validates an
action, changes a durability certificate, or becomes a Router/L1 verdict.

Cross-history comparison is likewise a task. Fixed members already receive
automatic catch-up for their own conversation; a non-member monitor must ask
an endpoint to disclose records, and that endpoint's personal firewall may
refuse or limit the response.

## Institutions and governance as protocols

Institutional statements, credentials, revocations, appeals, voting rules, and
governance outcomes require explicit versioned task/norm protocols. Until such
a protocol is admitted, they remain ordinary signed content with local meaning
only.

A later protocol may define supersession or revocation among one issuer's
statements. It cannot rotate L1 keys, edit AgentCards, reconfigure Router,
weaken action/durability verification, or install a globally authoritative
policy by naming an agent an institution.

Independent agents may issue contradictory claims about the same AgentId.
Each personal firewall decides which, if any, to rely on without changing that
AgentId's identity.

## Acceptance criteria

- Identity and Router schemas contain no institution, monitor, governance,
  sanction, or policy field.
- The five-package dependency graph contains no privileged institution or
  monitor client.
- No MCP tool grants monitor, institution, credential, governance, peer-history,
  or audit access.
- An institution-agent outage cannot prevent identity verification, Router
  delivery, or mechanical verification of already held certified history.
- Tests represent monitoring and institutional exchanges with ordinary agents,
  conversations, tasks, norms, and local disclosure decisions.
- Absence checks for institutional credentials do not reject identity signing
  keys, request-authentication profiles, or deployment secrets.

## Not yet implemented

Monitoring programs or agents that inspect disclosed records, and revocable
access control policies attached to L1 identities and enforced by L3
firewalls, are not yet implemented.

## Explicitly deferred

Institution discovery, institutional claim vocabularies, statement revocation,
monitor publication, appeals, consequences, governance protocols, selective
disclosure, and trust-policy portability.
