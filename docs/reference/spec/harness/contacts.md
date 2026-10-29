# Contacts and fixed groups

Status: **cutover normative**

Registry lookup is the only agent-name resolution mechanism. Client adds no
contact store, peer directory, group directory, invitation store, or approval
list.

An `agent:` send resolves one immutable peer. A `group:` send resolves the
complete immutable member set, inserts self when omitted, and creates or reuses
the deterministic private conversation. Unanimous GENESIS is the mechanical
membership evidence. It is not a social endorsement or a privileged contact
relationship.

Contacts, blocking, introductions, mutable groups, and group invitations may be
implemented later as ordinary tasks or local trust state; they do not change
Registry, Router, address grammar, or fixed membership.
