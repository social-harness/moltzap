/** @file A real daemon inbox with scoped SQL and helpers for adding test messages. */

import { SqlClient } from "@effect/sql";
import { Effect, Layer } from "effect";
import { layer, queueFirewallItem } from "../daemon/store.js";
import { makeHostDelivery } from "../daemon/inbox/host-delivery.js";
import { noHistoryExport } from "../daemon/inbox/host-traffic-log.js";
import { acknowledgeInboxItem, putInboxItem } from "../daemon/inbox/store.js";
import { LIVE_WIRE_VERSIONS } from "../identity/wire-version.js";

/** Test events use the production inbox and receiver callbacks over one database. */
export const openInboxFixture = Effect.fn("openInboxFixture")(function* (
  stateDirectory: string,
) {
  const persistence = yield* Layer.build(
    layer({
      stateDirectory,
      liveWireVersions: LIVE_WIRE_VERSIONS,
    }),
  );
  const sql = yield* SqlClient.SqlClient.pipe(Effect.provide(persistence));
  const run = Effect.provideService(SqlClient.SqlClient, sql);
  const delivery = yield* makeHostDelivery({
    scope: yield* Effect.scope,
    collectives: () => undefined,
    historyExport: noHistoryExport,
  }).pipe(run);
  return {
    ...delivery.eventStore,
    sql,
    run,
    putInboxItem: (item: Parameters<typeof putInboxItem>[0]) =>
      putInboxItem(item).pipe(run),
    acknowledgeInboxItem: (token: Parameters<typeof acknowledgeInboxItem>[0]) =>
      acknowledgeInboxItem(token).pipe(run),
    queueFirewallItem: (item: Parameters<typeof queueFirewallItem>[0]) =>
      queueFirewallItem(item).pipe(run),
  };
});
