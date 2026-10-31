/** @file The daemon serves authenticated startup state and reports listener failures. */

import { scopedLive as it } from "@effect/vitest";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { Data, Deferred, Effect, Fiber } from "effect";
import { expect } from "vitest";
import {
  makeFixture,
  runtimeDependencies,
} from "../__tests__/daemon-runtime-fixtures.js";
import {
  loopbackMcpEndpoint,
  mcpTestHeaders,
} from "../__tests__/mcp-http-fixtures.js";
import {
  stateDirectory,
  withDaemonStore,
} from "../__tests__/store-schema-fixtures.js";
import { Router } from "../communication/router/index.js";
import { Registry } from "../identity/registry/index.js";
import {
  type DaemonRuntimeDependencies,
  DaemonRuntimeError,
  runDaemonRuntime,
} from "./lifecycle.js";

class ListenerTestFailure extends Data.TaggedError("ListenerTestFailure") {}
const unusedNetwork = () =>
  Effect.dieMessage("Unregistered daemon accessed the network");
const withoutNetwork = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provideService(Registry, {
      register: unusedNetwork,
      lookup: unusedNetwork,
    }),
    Effect.provideService(Router, { send: unusedNetwork, poll: unusedNetwork }),
  );
const listener =
  (
    ready: Deferred.Deferred<URL>,
  ): DaemonRuntimeDependencies["acquireListener"] =>
  ({ handler }) =>
    loopbackMcpEndpoint(handler).pipe(
      Effect.flatMap((url) => Deferred.succeed(ready, url)),
      Effect.asVoid,
    );
const acquireClient = (address: URL) => {
  const client = new Client(
    { name: "daemon-startup-test", version: "1" },
    { capabilities: {}, versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  // eslint-disable-next-line agent-code-guard/acquire-release-requires-scope -- The returned effect keeps the client in the test's enclosing scoped lifetime.
  return Effect.acquireRelease(
    Effect.tryPromise(() =>
      client.connect(
        new StreamableHTTPClientTransport(address, {
          requestInit: { headers: mcpTestHeaders },
        }),
      ),
    ).pipe(Effect.as(client)),
    () => Effect.tryPromise(() => client.close()).pipe(Effect.ignore),
  );
};
const startupStatus = Effect.gen(function* () {
  const fixture = yield* makeFixture;
  const ready = yield* Deferred.make<URL>();
  const daemon = yield* runDaemonRuntime(
    { bootstrap: fixture.bootstrap, registration: { kind: "unregistered" } },
    runtimeDependencies(listener(ready)),
  ).pipe(withoutNetwork, Effect.forkScoped);
  const address = yield* Deferred.await(ready).pipe(
    Effect.raceFirst(Fiber.join(daemon)),
  );
  const client = yield* acquireClient(address);
  const status = yield* Effect.tryPromise(() =>
    client.callTool({ name: "status", arguments: {} }),
  );
  expect(status.structuredContent).toEqual({ kind: "unregistered" });
  yield* Fiber.interrupt(daemon);
});
const listenerFailure = Effect.gen(function* () {
  const fixture = yield* makeFixture;
  const error = yield* runDaemonRuntime(
    { bootstrap: fixture.bootstrap, registration: { kind: "unregistered" } },
    runtimeDependencies(() => Effect.fail(new ListenerTestFailure())),
  ).pipe(withoutNetwork, Effect.flip);
  expect(error).toEqual(new DaemonRuntimeError({ phase: "listener" }));
});

// @agent-code-guard/regression-only: an unregistered process serves authenticated registration and status before network activation.
// eslint-disable-next-line sonarjs/assertions-in-tests -- startupStatus contains the status assertion inside the real database scope.
it("serves authenticated status before registration over HTTP", () =>
  withDaemonStore(stateDirectory(), () => startupStatus));
// eslint-disable-next-line sonarjs/assertions-in-tests -- listenerFailure contains the failure assertion inside the real database scope.
it("reports listener acquisition failure without activating communication", () =>
  withDaemonStore(stateDirectory(), () => listenerFailure));
