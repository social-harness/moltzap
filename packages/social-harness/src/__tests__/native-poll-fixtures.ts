/** @file Authenticated native receiving through the production HTTP handler and SQLite inbox. */

import type { McpHttpHandler } from "@modelcontextprotocol/server";
import { Effect, Redacted } from "effect";
import { openEndpointStore } from "../communication/store/index.js";
import { noHistoryExport } from "../daemon/inbox/host-traffic-log.js";
import { makeHostDelivery } from "../daemon/inbox/host-delivery.js";
import { makeHarnessMcpHttpHandler } from "../daemon/mcp/tools.js";
import { LIVE_WIRE_VERSIONS } from "../identity/wire-version.js";
import { loopbackMcpEndpoint } from "./mcp-http-fixtures.js";
import { stateDirectory } from "./store-schema-fixtures.js";

/** Synthetic runtime authority accepted only by the local fixture. */
export const nativeCredential = Redacted.make(
  "local-native-receiver-test-credential",
);
const unused = () =>
  Effect.dieMessage("Unrelated native receiver fixture operation");

/** Real admission and receipt behavior with optional HTTP or initial-poll fault injection. */
export const nativePollFixture = Effect.fn("nativePollFixture")(function* (
  wrap?: (handler: McpHttpHandler) => McpHttpHandler,
  beforeBootstrap?: Effect.Effect<void>,
) {
  const store = yield* openEndpointStore(stateDirectory(), {
    liveWireVersions: LIVE_WIRE_VERSIONS,
  });
  const delivery = yield* makeHostDelivery({
    store,
    scope: yield* Effect.scope,
    collectives: () => ({ send: unused, settleRequest: unused }),
    historyExport: noHistoryExport,
  });
  const handler = yield* makeHarnessMcpHttpHandler({
    implementation: { name: "native-receiver-test", version: "1" },
    credentials: {
      runtime: nativeCredential,
      owner: Redacted.make("local-native-owner-test-credential"),
    },
    eventStore: {
      ...delivery.eventStore,
      readInboxSummary: () =>
        (beforeBootstrap ?? Effect.void).pipe(
          Effect.andThen(delivery.eventStore.readInboxSummary()),
        ),
    },
    operations: {
      ...delivery.operations,
      protocolActive: () => true,
      readStatus: unused,
      register: unused,
      searchAgents: unused,
      searchConversations: unused,
      readConversation: unused,
    },
  });
  return {
    store,
    handler,
    address: yield* loopbackMcpEndpoint(wrap?.(handler) ?? handler),
  };
});
