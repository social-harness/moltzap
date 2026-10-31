/** @file Authenticated native receiving through the production HTTP handler and SQLite inbox. */

import type { McpHttpHandler } from "@modelcontextprotocol/server";
import { Effect, Redacted } from "effect";
import { makeHarnessMcpHttpHandler } from "../daemon/mcp/index.js";
import { Identity } from "../identity/local.js";
import { openInboxFixture } from "./inbox-fixture.js";
import { loopbackMcpEndpoint, mcpIdentity } from "./mcp-http-fixtures.js";
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
  const handler = yield* makeHarnessMcpHttpHandler({
    implementation: { name: "native-receiver-test", version: "1" },
    credential: nativeCredential,
    eventStore: {
      ...store,
      readInboxSummary: () =>
        (beforeBootstrap ?? Effect.void).pipe(
          Effect.andThen(store.readInboxSummary()),
        ),
    },
    operations: {
      ...store.operations,
      send: unused,
      readInboxSummary: store.readInboxSummary,
      readStatus: unused,
      register: unused,
      searchConversations: unused,
      readConversation: unused,
    },
  }).pipe(Effect.provideService(Identity, mcpIdentity()));
  return {
    store,
    handler,
    address: yield* loopbackMcpEndpoint(wrap?.(handler) ?? handler),
  };
});
