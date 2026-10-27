# Host inbox

This folder keeps items waiting for the host, delivery tokens, the delivery
pass and the history export. `index.ts` exposes `HostDelivery` to the service:
host operations, inbox writes and delivery share one state behind one gate.
Hosts load only the value schemas in `history-export.ts`.

Incoming items wait for firewall admission before the delivery pass publishes
them. The firewall owns checks and retained decisions, the store owns persistence,
and the service owns resource ordering.
