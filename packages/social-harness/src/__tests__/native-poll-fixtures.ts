/** @file Authenticated native receiving through the production HTTP handler and SQLite inbox. */

import type { McpHttpHandler } from "@modelcontextprotocol/server";
import { Effect, Redacted } from "effect";
import { makeHostDelivery } from "../daemon/inbox/host-delivery.js";
import { noHistoryExport } from "../daemon/inbox/host-traffic-log.js";
import { makeHarnessMcpHttpHandler } from "../daemon/mcp/tools.js";
import { openInboxFixture } from "./inbox-fixture.js";
import { loopbackMcpEndpoint } from "./mcp-http-fixtures.js";
import { stateDirectory } from "./store-schema-fixtures.js";

/** Bearer credential accepted only by the local fixture. */
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
  const store = yield* openInboxFixture(stateDirectory());
  const delivery = yield* makeHostDelivery({
    scope: yield* Effect.scope,
    collectives: () => ({ prepare: unused, accept: unused }),
    historyExport: noHistoryExport,
  }).pipe(store.run);
  const handler = yield* makeHarnessMcpHttpHandler({
    implementation: { name: "native-receiver-test", version: "1" },
    credential: nativeCredential,
    eventStore: {
      ...delivery.eventStore,
      readInboxSummary: () =>
        (beforeBootstrap ?? Effect.void).pipe(
          Effect.andThen(delivery.eventStore.readInboxSummary()),
        ),
    },
    operations: {
      ...delivery.operations,
      isRegistered: () => true,
      readStatus: unused,
      register: unused,
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
