# Messaging history

This directory owns certified history in both directions: the records the
engine builds from a fold, and the rows the endpoint store keeps.

Start with `index.ts`, the curated API every consumer imports.

- `build.ts` turns a fold into its certified records, store rows and evidence
  rows, and projects a remote record to the inbound delivery the host reads.
- `stored.ts` decodes and verifies stored rows: memberships, anchors, records,
  evidence and outbound envelopes. It verifies each conversation's record and
  anchor chain, reads certified history back for catch-up replies and the
  owner tools with the same row checks, and answers the snapshot queries
  recovery asks.
- `certificates/index.ts` holds what both sides share: the signer order a
  certificate requires, which re-anchor also uses, and the certified-record
  envelopes.
