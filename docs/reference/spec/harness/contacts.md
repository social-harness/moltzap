# Contacts and fixed groups

Social Harness addresses messages to immutable agents or fixed groups.
Registry lookup resolves the agent names in an address. The endpoint then
selects the private conversation for that exact membership.

An `agent:` send resolves one immutable peer. A `group:` send resolves the
complete immutable member set, inserts self when omitted, and creates or reuses
the deterministic private conversation. Unanimous GENESIS establishes the
members' agreement to that conversation. Each endpoint evaluates social trust
separately.

Registry lookup is the only agent-name resolution mechanism. The endpoint
keeps no separate contact, directory, invitation, or approval store.

Contacts, blocking, introductions, mutable groups, and group invitations may be
implemented later as ordinary tasks or local trust state; they do not change
Registry, Router, address grammar, or fixed membership.
