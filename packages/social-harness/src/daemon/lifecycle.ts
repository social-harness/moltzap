/** @file Private lifecycle composition for one registered endpoint daemon. */

import type { Implementation } from "@modelcontextprotocol/server";
import { NodeFileSystem } from "@effect/platform-node";
import { SqlClient } from "@effect/sql";
import { Console, Effect, type Scope } from "effect";
import type { Router } from "../communication/router/api/client.js";
import type { Registry } from "../identity/registry/index.js";
import { makeEndpointEngine } from "../communication/conversations/index.js";
import { makeRouterWorker } from "../communication/router/index.js";
import { FirewallPolicyError } from "../firewall/config.js";
import { readDecisions } from "../firewall/store/index.js";
import { WIRE_VERSION } from "../identity/wire-version.js";
import { packageVersion } from "../release/index.js";
import { DaemonRuntimeError, runtimeFailure } from "./errors.js";
import {
  type HistoryExportPort,
  makeHistoryExport,
  noHistoryExport,
} from "./inbox/host-traffic-log.js";
import {
  type DaemonManagementOperations,
  makeDaemonManagementOperations,
} from "./management/index.js";
import {
  acquireHarnessMcpHttpServer,
  type HarnessMcpEventHandler,
  LOOPBACK_HOST,
  makeHarnessMcpHttpHandler,
  type ManagementRegisterRequest,
} from "./mcp/index.js";
import {
  type DaemonStartup,
  makeDaemon,
  type ProtocolEdges,
  type RunningDaemon,
} from "./runtime/index.js";

/** Closed daemon startup and supervision failure. */
export { DaemonRuntimeError };

/** Replaceable process edges used by focused lifecycle tests. */
export interface DaemonRuntimeDependencies extends ProtocolEdges {
  readonly makeHandler: typeof makeHarnessMcpHttpHandler;
  readonly acquireListener: (input: {
    readonly port: number;
    readonly handler: HarnessMcpEventHandler;
  }) => Effect.Effect<void, Error, Scope.Scope>;
  /** Opens the operator-configured history export against one file. */
  readonly makeHistoryExport: (
    path: string,
  ) => Effect.Effect<HistoryExportPort>;
}

const DAEMON_IMPLEMENTATION = {
  name: "sharnessd",
  version: packageVersion,
} satisfies Implementation;

const productionDependencies: DaemonRuntimeDependencies = {
  makeWorker: (input) => makeRouterWorker(input),
  makeEngine: makeEndpointEngine,
  makeHandler: makeHarnessMcpHttpHandler,
  acquireListener: ({ port, handler }) =>
    acquireHarnessMcpHttpServer({ port, handler }).pipe(Effect.asVoid),
  makeHistoryExport: (path) =>
    makeHistoryExport(path).pipe(Effect.provide(NodeFileSystem.layer)),
};

/**
 * Run all daemon-owned protocol and MCP resources until a supervised failure.
 * @param input The store, bootstrap and registration state read at startup.
 * @param dependencies Replaceable process edges used by focused lifecycle tests.
 * @returns A scoped process effect that ends only when a supervised resource fails.
 */
export const runDaemonRuntime = (
  input: DaemonStartup,
  dependencies: DaemonRuntimeDependencies = productionDependencies,
): Effect.Effect<
  never,
  DaemonRuntimeError,
  Registry | Router | Scope.Scope | SqlClient.SqlClient
> =>
  Effect.gen(function* () {
    const historyExport = yield* openHistoryExport(input, dependencies);
    const daemon = yield* makeDaemon({
      ...input,
      historyExport,
      edges: dependencies,
    });
    const management = yield* makeDaemonManagementOperations({
      bootstrap: input.bootstrap,
      registration: daemon,
    });
    return yield* Effect.gen(function* () {
      yield* daemon.activateAtStart;
      yield* registerAtStart(
        management,
        daemon.readRegistration().kind === "active",
        daemon,
        input.bootstrap.configuration.registration,
      );
      const handler = yield* makeHandler(
        input,
        dependencies,
        management,
        daemon,
      );
      yield* daemon.installHandler(handler);
      yield* daemon.runSubscriptions.pipe(Effect.forkScoped);
      yield* dependencies
        .acquireListener({
          port: input.bootstrap.configuration.mcpPort,
          handler,
        })
        .pipe(Effect.mapError(() => runtimeFailure("listener")));
      yield* Console.log(
        `sharnessd listening on http://${LOOPBACK_HOST}:${input.bootstrap.configuration.mcpPort}/mcp (package ${packageVersion}; WIRE_VERSION ${WIRE_VERSION})`,
      );
      return yield* daemon.awaitFailure;
    }).pipe(Effect.raceFirst(daemon.awaitFailure));
  }).pipe(Effect.withSpan("runDaemonRuntime"));

/** The handler shares the daemon's delivery operations and fixed bootstrap credentials. */
function makeHandler(
  input: DaemonStartup,
  dependencies: DaemonRuntimeDependencies,
  management: DaemonManagementOperations,
  daemon: RunningDaemon,
) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* dependencies
      .makeHandler({
        implementation: DAEMON_IMPLEMENTATION,
        operations: Object.freeze({
          ...management,
          readDecisions: (request: { readonly since?: number }) =>
            readDecisions(request).pipe(
              Effect.provideService(SqlClient.SqlClient, sql),
              Effect.catchTag("EndpointStoreError", () =>
                Effect.fail(
                  new FirewallPolicyError({ reason: "persistence-failed" }),
                ),
              ),
            ),
          ...(input.firewall === undefined
            ? {}
            : {
                readPolicy: input.firewall.readPolicy,
                updatePolicy: input.firewall.updatePolicy,
              }),
          ...daemon.deliveryOperations,
          protocolActive: daemon.protocolActive,
        }),
        credential: input.bootstrap.mcpCredential,
        eventStore: daemon.eventStore,
        onSubscriptionActiveChange: daemon.subscriptionChanged,
      })
      .pipe(Effect.mapError(() => runtimeFailure("storage")));
  });
}

/** The existing management operation commits and activates a new registration before MCP listens. */
function registerAtStart(
  management: DaemonManagementOperations,
  active: boolean,
  daemon: RunningDaemon,
  request?: ManagementRegisterRequest,
) {
  if (request === undefined || active) {
    return Effect.void;
  }
  return management.register(request).pipe(
    Effect.mapError(registrationFailure),
    Effect.catchAllCause((cause) =>
      daemon.readRegistration().kind === "active"
        ? daemon.awaitFailure
        : Effect.failCause(cause),
    ),
    Effect.flatMap((result) =>
      result.kind === "registered"
        ? Effect.void
        : Effect.fail(
            new DaemonRuntimeError({
              phase: "registration",
              reason: result.kind,
            }),
          ),
    ),
  );
}

/** An unset export path leaves certified history in endpoint-owned storage. */
function openHistoryExport(
  input: DaemonStartup,
  dependencies: DaemonRuntimeDependencies,
) {
  const path = input.bootstrap.configuration.historyExport;
  return path === undefined
    ? Effect.succeed(noHistoryExport)
    : dependencies.makeHistoryExport(path);
}

/** Only registration failures cross into startup before the identity binds. */
function registrationFailure(error: {
  readonly reason: string;
}): DaemonRuntimeError {
  switch (error.reason) {
    case "admission-refused":
    case "dependency-unavailable":
    case "persistence-failed":
      return new DaemonRuntimeError({
        phase: "registration",
        reason: error.reason,
      });
    default:
      return new DaemonRuntimeError({
        phase: "registration",
        reason: "incompatible-daemon",
      });
  }
}
