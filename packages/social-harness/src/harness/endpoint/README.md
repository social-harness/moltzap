# Scoped endpoint client

The endpoint client gives a host one scoped send capability and delivery
stream. Trusted-local event reception and authenticated polling converge on
the same inbox decoding and receipt lifetime. When changing reception, check
both modes, including cleanup while a host callback is still running.

Transport errors need a separate review from daemon refusals. A request that
may have reached the daemon has a different resend risk from one rejected
before dispatch. Preserve that distinction when changing the SDK boundary or
failure mapping in `index.ts` → `sendFailure`.

The [endpoint contract](../../../../../docs/reference/spec/host/messaging.md)
defines connection lifetime, delivery acceptance and send outcomes.
