# Changing collective operations

A requested form crosses two validation boundaries. [The host forms](forms.ts)
retain the caller's property descriptions for diagnostics. The
[collective-part grammar](part/grammar.ts) admits the supported keywords before
they travel in a post, and [answer validation](validation.ts) checks against
that admitted form. When changing a form keyword, follow it through admission,
encoding, and answer checking so the request and its answers agree.

Hosts can import the value and rendering entrypoints without loading the
operation layer. The daemon composes that layer through [index.ts](index.ts)
and supplies its communication and firewall capabilities through
[ports.ts](ports.ts). Keep shared value handling independent of those live
capabilities. The [Client contract](../../../../../docs/reference/spec/host/messaging.md#operations)
owns operation behavior and completion rules.
