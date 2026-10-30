/** @file The daemon serves authenticated startup state and reports listener failures. */

import { scopedLive as it } from "@effect/vitest";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { Deferred, Effect, Fiber } from "effect";
import { expect } from "vitest";
import { makeFixture } from "../__tests__/daemon-runtime-fixtures.js";
import { mcpTestHeaders } from "../__tests__/mcp-http-fixtures.js";
import {
  stateDirectory,
  withDaemonStore,
} from "../__tests__/store-schema-fixtures.js";
import { makeEndpointEngine } from "../communication/conversations/index.js";
import { makeRouterWorker, Router } from "../communication/router/index.js";
import { Registry } from "../identity/registry/index.js";
import { noHistoryExport } from "./inbox/host-traffic-log.js";
import {
  type DaemonRuntimeDependencies,
  DaemonRuntimeError,
  runDaemonRuntime,
} from "./lifecycle.js";
import { acquireHarnessMcpHttpServer } from "./mcp/http.js";
import { makeHarnessMcpHttpHandler } from "./mcp/tools.js";

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
const dependencies = (
  acquireListener: DaemonRuntimeDependencies["acquireListener"],
): DaemonRuntimeDependencies => ({
  makeEngine: makeEndpointEngine,
  makeWorker: makeRouterWorker,
  makeHandler: makeHarnessMcpHttpHandler,
  makeHistoryExport: () => Effect.succeed(noHistoryExport),
  acquireListener,
});

const servesStartupStatus = () =>
  withDaemonStore(stateDirectory(), () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const ready = yield* Deferred.make<URL>();
      const edges = dependencies(({ handler }) =>
        acquireHarnessMcpHttpServer({ port: 0, handler }).pipe(
          Effect.flatMap((server) => {
            const address = server.address();
            return address === null || typeof address === "string"
              ? Effect.dieMessage("Expected TCP listener")
              : Deferred.succeed(
                  ready,
                  new URL(`http://127.0.0.1:${address.port}/mcp`),
                ).pipe(Effect.asVoid);
          }),
        ),
      );
      const daemon = yield* runDaemonRuntime(
        {
          bootstrap: fixture.bootstrap,
          registration: { kind: "unregistered" },
        },
        edges,
      ).pipe(withoutNetwork, Effect.forkScoped);
      const address = yield* Deferred.await(ready);
      const client = new Client(
        { name: "daemon-startup-test", version: "1" },
        {
          capabilities: {},
          versionNegotiation: { mode: { pin: "2026-07-28" } },
        },
      );
      yield* Effect.acquireRelease(
        Effect.tryPromise(() =>
          client.connect(
            new StreamableHTTPClientTransport(address, {
              requestInit: { headers: mcpTestHeaders },
            }),
          ),
        ),
        () => Effect.tryPromise(() => client.close()).pipe(Effect.ignore),
      );
      const status = yield* Effect.tryPromise(() =>
        client.callTool({ name: "status", arguments: {} }),
      );
      expect(status.structuredContent).toEqual({ kind: "unregistered" });
      yield* Fiber.interrupt(daemon);
    }),
  );

const reportsListenerFailure = () =>
  withDaemonStore(stateDirectory(), () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const error = yield* runDaemonRuntime(
        {
          bootstrap: fixture.bootstrap,
          registration: { kind: "unregistered" },
        },
        dependencies(() => Effect.fail(new Error("port unavailable"))),
      ).pipe(withoutNetwork, Effect.flip);
      expect(error).toEqual(new DaemonRuntimeError({ phase: "listener" }));
    }),
  );

// @agent-code-guard/regression-only: an unregistered process must serve authenticated registration and status before network activation.
it(
  "serves authenticated status before registration over its HTTP listener",
  servesStartupStatus,
);

it(
  "reports listener acquisition failure without activating communication",
  reportsListenerFailure,
);
