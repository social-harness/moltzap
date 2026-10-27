# Daemon registration

This folder owns the daemon's identity: the registration state read at
startup, the admission check an unregistered daemon must pass, and Registry
registration bound to the endpoint store.

Start with `index.ts`. `registerDaemonIdentity` returns the Registry's result
unchanged. Only a `registered` result carries the verified card, and the store
binds that card before the result returns. `binding.ts` owns the durable
identity row: it reads and re-verifies the row, binds a new card, and defines
the persistence and representation errors both steps raise. Only `index.ts`
imports it.
