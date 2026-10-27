# Records

This folder owns certified record formats and their exact protocol
representation: closed schemas, canonical JCS encoding, hashing, sealing and
signing, verification, the fixed `q(n)` threshold, and the message values
(`PostId`, `Content`) every layer above encodes. `encoding/` holds the
canonical bytes, the hashes and signatures over them, and the seal on every
outer body; `verification.ts` builds on it.

Other domains use `index.ts`. Hosts read `values.ts` (addresses, post ids, content, and
member limits) directly, so they never load signing, verification, or the
Router client. Nothing here depends on another Client domain.
