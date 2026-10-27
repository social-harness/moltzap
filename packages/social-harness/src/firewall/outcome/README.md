# Firewall outcomes

`index.ts` holds the exact schemas for checked guidance, local guidance,
withheld text and send refusals, and the `FirewallSendError` hosts decode.
This folder has no dependency on the firewall implementation or communication domains.
Its exact-struct helper stays local because wire sits above this layer.

See the [firewall overview](../README.md).
