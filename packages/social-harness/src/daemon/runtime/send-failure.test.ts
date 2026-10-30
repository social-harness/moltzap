/** @file Failed outbound persistence preserves the HTTP send outcome and private content. */

import { SqlClient } from "@effect/sql";
import { scopedLive as it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Logger } from "effect";
import { expect } from "vitest";
import type { DaemonRuntimeDependencies } from "../lifecycle.js";
import {
  makeFixture,
  runRegisteredFixture,
  runtimeDependencies,
} from "../../__tests__/daemon-runtime-fixtures.js";
import {
  loopbackMcpEndpoint,
  makeToolCallRequest,
} from "../../__tests__/mcp-http-fixtures.js";
import {
  stateDirectory,
  withDaemonStore,
} from "../../__tests__/store-schema-fixtures.js";

const SECRET = "private outbound failure sentinel";
const listener =
  (
    ready: Deferred.Deferred<URL>,
  ): DaemonRuntimeDependencies["acquireListener"] =>
  ({ handler }) =>
    loopbackMcpEndpoint(handler).pipe(
      Effect.flatMap((url) => Deferred.succeed(ready, url)),
      Effect.asVoid,
    );
const callSend = (url: URL) =>
  Effect.gen(function* () {
    const request = makeToolCallRequest({
      id: "failed-proposal",
      name: "send_message",
      toolArguments: { input: { to: "agent:bob", text: SECRET } },
    });
    const body = yield* Effect.tryPromise(() => request.text());
    const response = yield* Effect.tryPromise(() =>
      // eslint-disable-next-line agent-code-guard/prefer-effect-platform -- The real listener must flush the send response while its daemon is stopping.
      fetch(url, { method: "POST", headers: request.headers, body }),
    );
    return yield* Effect.tryPromise(() => response.json());
  });
const failsBoundProposal = () => {
  const diagnostics: unknown[] = [];
  return withDaemonStore(stateDirectory(), (store) =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      yield* store.bindIdentity({
        agentId: fixture.localCard.agentId,
        canonicalAgentCard: fixture.canonicalLocalCard,
      });
      const sql = yield* SqlClient.SqlClient;
      yield* sql.unsafe(
        "CREATE TRIGGER fail_outbound BEFORE INSERT ON outbound_messages BEGIN SELECT RAISE(ABORT, 'private persistence failure'); END",
      );
      const ready = yield* Deferred.make<URL>();
      const daemon = yield* runRegisteredFixture(
        fixture,
        runtimeDependencies(listener(ready)),
      ).pipe(Effect.forkScoped);
      const url = yield* Deferred.await(ready).pipe(
        Effect.raceFirst(Fiber.join(daemon)),
      );
      expect(yield* callSend(url)).toMatchObject({
        error: { data: { reason: "delivery-pending" } },
      });
      expect(yield* Fiber.join(daemon).pipe(Effect.flip)).toMatchObject({
        phase: "storage",
      });
      // eslint-disable-next-line agent-code-guard/no-hardcoded-assertion-literals -- The log reports the closed persistence cause without the underlying private database message.
      expect(JSON.stringify(diagnostics)).toContain('"reason":"persistence"');
      expect(JSON.stringify(diagnostics)).not.toContain(SECRET);
    }),
  ).pipe(
    Effect.provide(
      Logger.replace(
        Logger.defaultLogger,
        Logger.make(({ message, annotations }) => {
          diagnostics.push({
            message,
            annotations: Object.fromEntries(annotations),
          });
        }),
      ),
    ),
  );
};

// @agent-code-guard/regression-only: once an intent is bound, a storage failure must retain its send uncertainty while stopping the daemon.
it(
  "returns delivery-pending over HTTP and stops with private content redacted",
  failsBoundProposal,
  30_000,
);
