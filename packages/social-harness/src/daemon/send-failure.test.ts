/** @file Failed outbound persistence preserves the HTTP send outcome and private content. */

import { SqlClient } from "@effect/sql";
import { scopedLive as it } from "@effect/vitest";
import { Effect, Fiber, Logger } from "effect";
import { expect } from "vitest";
import {
  acquireDaemonClient,
  makeFixture,
  runRegisteredFixture,
} from "../__tests__/daemon-runtime-fixtures.js";
import { makeToolCallRequest } from "../__tests__/mcp-http-fixtures.js";
import {
  stateDirectory,
  withDaemonStore,
} from "../__tests__/store-schema-fixtures.js";

const SECRET = "private outbound failure sentinel";
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
  return withDaemonStore(stateDirectory(), () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const sql = yield* SqlClient.SqlClient;
      yield* sql.unsafe(
        "CREATE TRIGGER fail_outbound BEFORE INSERT ON outbound_messages BEGIN SELECT RAISE(ABORT, 'private persistence failure'); END",
      );
      const daemon = yield* runRegisteredFixture(fixture).pipe(
        Effect.forkScoped,
      );
      yield* acquireDaemonClient(fixture).pipe(
        Effect.raceFirst(
          Fiber.join(daemon).pipe(
            Effect.zipRight(Effect.dieMessage("Daemon stopped during startup")),
          ),
        ),
      );
      const url = new URL(
        `http://127.0.0.1:${fixture.bootstrap.configuration.mcpPort}/mcp`,
      );
      expect(yield* callSend(url)).toMatchObject({
        result: {
          structuredContent: { kind: "multicast", address: "agent:bob" },
        },
      });
      expect(yield* Fiber.join(daemon).pipe(Effect.flip)).toMatchObject({
        phase: "storage",
      });
      expect(JSON.stringify(diagnostics)).toContain(
        // eslint-disable-next-line agent-code-guard/no-hardcoded-assertion-literals -- This HTTP regression verifies the public diagnostic cause while private storage errors stay redacted.
        '"reason":"persistence-failed"',
      );
      expect(JSON.stringify(diagnostics)).not.toContain(SECRET);
    }),
  ).pipe(
    Effect.provide(
      Logger.replace(
        Logger.defaultLogger,
        Logger.make(({ message, annotations, cause }) => {
          diagnostics.push({
            message,
            cause,
            annotations: Object.fromEntries(annotations),
          });
        }),
      ),
    ),
  );
};

// @agent-code-guard/regression-only: once an intent is bound, a later storage failure must preserve acceptance while stopping the daemon.
it(
  "accepts the send over HTTP before stopping with private content redacted",
  failsBoundProposal,
  30_000,
);
