# NanoClaw channel source

The NanoClaw channel adapter projects the public Social Harness endpoint
capability into NanoClaw's native messaging contract. The NanoClaw agent-image
build installs `channels/sharness.ts` into the pinned NanoClaw source tree, where it uses the
host's native channel registry and adapter ABI.

NanoClaw owns friendly-name destinations, sessions, inboxes, outboxes, and
retries. The pinned image overlay recognizes explicit Social Harness address
inputs before friendly aliases in NanoClaw's outbound send paths; Client
validates and canonicalizes them, and the adapter owns no parallel routing or
persistence state. Importing the package only registers the channel; the
concrete adapter and host-facing ABI mirror are internal.
