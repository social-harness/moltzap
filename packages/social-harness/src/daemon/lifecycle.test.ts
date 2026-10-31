/** @file The daemon serves authenticated startup state and reports listener failures. */

import { scopedLive as it } from "@effect/vitest";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { Data, Deferred, Effect, Fiber } from "effect";
import { expect } from "vitest";
import {
  type Fixture,
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
import {
  Router,
  RouterWorkerTransportError,
} from "../communication/router/index.js";
import { Firewall } from "../firewall/index.js";
import { HARNESS_SEND_TOOL } from "../host-protocol/names.js";
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
    Effect.provide(Firewall.layer()),
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

const runRegistrationFixture = (
  fixture: Fixture,
  dependencies: DaemonRuntimeDependencies,
) =>
  runDaemonRuntime(
    { bootstrap: fixture.bootstrap, registration: { kind: "unregistered" } },
    dependencies,
  ).pipe(
    Effect.scoped,
    Effect.provide(Firewall.layer()),
    Effect.provideService(Registry, {
      register: () =>
        Effect.succeed({ kind: "registered", agentCard: fixture.localCard }),
      lookup: unusedNetwork,
    }),
    Effect.provideService(Router, { send: unusedNetwork, poll: unusedNetwork }),
    Effect.forkScoped,
  );

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
  yield* Fiber.interrupt(daemon);
  return status.structuredContent;
});

const listenerFailure = Effect.gen(function* () {
  const fixture = yield* makeFixture;
  return yield* runDaemonRuntime(
    { bootstrap: fixture.bootstrap, registration: { kind: "unregistered" } },
    runtimeDependencies(() => Effect.fail(new ListenerTestFailure())),
  ).pipe(withoutNetwork, Effect.flip);
});

const registersBeforeCommunicationStarts = Effect.gen(function* () {
  const fixture = yield* makeFixture;
  const ready = yield* Deferred.make<URL>();
  const starting = yield* Deferred.make<undefined>();
  const stopped = yield* Deferred.make<undefined>();
  const daemon = yield* runRegistrationFixture(fixture, {
    ...runtimeDependencies(listener(ready)),
    makeWorker: () =>
      Deferred.succeed(starting, undefined).pipe(
        Effect.zipRight(Effect.never),
        Effect.onInterrupt(() => Deferred.succeed(stopped, undefined)),
      ),
  });
  const address = yield* Deferred.await(ready).pipe(
    Effect.raceFirst(Fiber.join(daemon)),
  );
  const client = yield* acquireClient(address);
  const registered = yield* Effect.tryPromise(() =>
    client.callTool({ name: "register", arguments: fixture.registerRequest }),
  );
  yield* Deferred.await(starting);
  const tools = yield* Effect.tryPromise(() => client.listTools());
  const status = yield* Effect.tryPromise(() =>
    client.callTool({ name: "status", arguments: {} }),
  );
  yield* Fiber.interrupt(daemon);
  yield* Deferred.await(stopped);
  return {
    registration: registered.structuredContent,
    status: status.structuredContent,
    tools: tools.tools.map(({ name }) => name),
    agentName: fixture.localCard.agentName,
  };
});

const communicationStartupFailure = Effect.gen(function* () {
  const fixture = yield* makeFixture;
  return yield* runDaemonRuntime(
    {
      bootstrap: fixture.bootstrap,
      registration: { kind: "active", agentCard: fixture.localCard },
    },
    {
      ...runtimeDependencies(() => Effect.void),
      makeWorker: () => Effect.fail(new RouterWorkerTransportError()),
    },
  ).pipe(withoutNetwork, Effect.flip);
});

// @agent-code-guard/regression-only: lifecycle regressions cover saved registration, startup failure and cancellation over real loopback HTTP.
it("serves authenticated status before registration over HTTP", () =>
  withDaemonStore(
    stateDirectory(),
    Effect.fn(function* () {
      expect(yield* startupStatus).toEqual({ kind: "unregistered" });
    }),
  ));

it("reports listener acquisition failure without activating communication", () =>
  withDaemonStore(
    stateDirectory(),
    Effect.fn(function* () {
      expect(yield* listenerFailure).toEqual(
        new DaemonRuntimeError({ phase: "listener" }),
      );
    }),
  ));

it("returns saved registration while communication startup waits", () =>
  withDaemonStore(
    stateDirectory(),
    Effect.fn(function* () {
      const result = yield* registersBeforeCommunicationStarts;
      expect(result.registration).toMatchObject({
        kind: "registered",
        agent: { agentName: result.agentName },
      });
      expect(result.tools).toContain(HARNESS_SEND_TOOL);
      expect(result.status).toMatchObject({
        kind: "active",
        agent: { agentName: result.agentName },
      });
    }),
  ));

it("stops the daemon when independent communication startup fails", () =>
  withDaemonStore(
    stateDirectory(),
    Effect.fn(function* () {
      expect(yield* communicationStartupFailure).toEqual(
        new DaemonRuntimeError({ phase: "listener" }),
      );
    }),
  ));
