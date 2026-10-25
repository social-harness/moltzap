/** @file Real NodeRuntime signal handling around the daemon's production audit lifecycle. */

import { NodeRuntime } from "@effect/platform-node";
import { Config, ConfigProvider, Deferred, Effect } from "effect";
import { join } from "node:path";
import { openEndpointStore } from "../communication/store/index.js";
import { LIVE_WIRE_VERSIONS } from "../identity/wire-version.js";
import { makeFixture } from "./daemon-runtime-fixtures.js";
import { makeHarness, run } from "./daemon-runtime-harness.js";
import { makeAuditFixture } from "./firewall-audit-fixtures.js";

const program = Effect.gen(function* () {
  const directory = yield* Config.string("SHARNESS_TEST_AUDIT_DIRECTORY");
  const block = yield* Config.boolean("SHARNESS_TEST_AUDIT_BLOCK");
  const fixture = yield* makeFixture;
  const evidence = yield* makeAuditFixture;
  const harness = yield* makeHarness(fixture, "none");
  harness.delivery.acknowledged = true;
  const store = yield* openEndpointStore(directory, {
    liveWireVersions: LIVE_WIRE_VERSIONS,
  });
  yield* store.bindIdentity({
    agentId: fixture.localCard.agentId,
    canonicalAgentCard: fixture.canonicalLocalCard,
  });
  yield* store.beginFirewallAttempt({
    ...evidence,
    checkId: "unfinished",
    direction: "outgoing",
    revision: 0,
  });
  const auditedStore = block
    ? {
        ...store,
        readFirewallAuditPage: () =>
          Effect.sync(() => process.stdout.write("exporting\n")).pipe(
            Effect.zipRight(Effect.never),
          ),
      }
    : store;
  yield* run(
    fixture,
    auditedStore,
    harness,
    join(directory, "audit.ndjson"),
  ).pipe(Effect.forkScoped);
  yield* Deferred.await(harness.listenerReady);
  yield* Effect.sync(() => process.stdout.write("ready\n"));
  return yield* Effect.never;
});

NodeRuntime.runMain(
  Effect.scoped(program).pipe(
    Effect.withConfigProvider(ConfigProvider.fromEnv()),
  ),
);
