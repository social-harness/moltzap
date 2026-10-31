/**
 * @file Owns the saved identity, communication startup and supervised daemon workers.
 */

import { SqlClient } from "@effect/sql";
import {
  Cause,
  type Context,
  Deferred,
  Effect,
  Option,
  Queue,
  Scope,
  Stream,
} from "effect";
import type { EndpointStoreError } from "../../communication/store/index.js";
import type { FirewallOperations } from "../../firewall/index.js";
import type { VerifiedAgentCard } from "../../identity/cards.js";
import type { DaemonBootstrap } from "../bootstrap.js";
import type { HistoryExportPort } from "../inbox/host-traffic-log.js";
import type { HarnessMcpEventHandler } from "../mcp/index.js";
import { CollectiveEmitError } from "../../communication/collectives/index.js";
import { Router } from "../../communication/router/index.js";
import { Identity, LocalIdentity } from "../../identity/local.js";
import { Registry } from "../../identity/registry/index.js";
import {
  activationFailure,
  type DaemonActivationError,
  DaemonRuntimeError,
  runtimeFailure,
} from "../errors.js";
import { type HostDelivery, makeHostDelivery } from "../inbox/index.js";
import {
  acquireProtocol,
  type ActiveProtocol,
  failFromBackgroundCause,
  type ProtocolEdges,
  type ProtocolEnvironment,
  reportStorageFault,
} from "./protocol.js";

/** The Router worker and engine constructors the lifecycle supplies. */
export type { ProtocolEdges };

/** The state one daemon starts from, read once before the network layers. */
export interface DaemonStartup {
  readonly bootstrap: DaemonBootstrap;
  readonly firewall?: FirewallOperations;
}

/** The running daemon the lifecycle composes into MCP operations. */
export interface RunningDaemon {
  readonly deliveryOperations: HostDelivery["operations"];
  readonly eventStore: HostDelivery["eventStore"];
  readonly subscriptionChanged: (active: boolean) => void;
  readonly installHandler: (
    handler: SubscriptionHandler,
  ) => Effect.Effect<void>;
  readonly awaitFailure: Effect.Effect<never, DaemonRuntimeError>;
}

type SubscriptionHandler = Pick<
  HarnessMcpEventHandler,
  "hasActiveSubscription" | "notifyPending" | "notify"
>;

interface DaemonInput extends DaemonStartup {
  readonly historyExport: HistoryExportPort;
  readonly edges: ProtocolEdges;
}

/** Saved identity and acquired communication resources have independent lifetimes. */
interface DaemonState {
  protocol?: ActiveProtocol;
  subscriptionActive: boolean;
  handler?: SubscriptionHandler;
}

interface DaemonEnvironment extends ProtocolEnvironment {
  readonly state: DaemonState;
  readonly delivery: HostDelivery;
  readonly identity: Context.Tag.Service<typeof Identity>;
}

const activationRuntimeFailure = (
  error: DaemonActivationError,
): DaemonRuntimeError => {
  if (error.reason === "outbox-too-old") {
    return new DaemonRuntimeError({ phase: "storage", reason: error.reason });
  }
  return runtimeFailure(error.reason === "upstream" ? "listener" : "storage");
};

/**
 * Logs why an activation ended, other than by an interrupt, and gives the
 * failure the daemon stops with. A defect has no typed reason, so it stops
 * the daemon as a storage failure.
 * @param cause Why the activation ended.
 * @returns The failure the daemon stops with, once the cause is logged.
 */
const activationStopped = (
  cause: Cause.Cause<DaemonActivationError>,
): Effect.Effect<DaemonRuntimeError> =>
  Effect.logError("Protocol activation failed, daemon exits", cause).pipe(
    Effect.as(
      Option.match(Cause.failureOption(cause), {
        onNone: () => runtimeFailure("storage"),
        onSome: activationRuntimeFailure,
      }),
    ),
  );

/**
 * Classify newly durable deliveries and publish what a subscriber can take.
 * The pass runs with or without a subscriber, so the collective layer
 * consumes protocol messages even while no host is attached. The active protocol
 * and subscriber are read once the delivery gate is held. A failed pass
 * releases the gate and signals the fatal storage failure.
 * @param environment The daemon's state, delivery and fatal signal.
 * @returns Completion after every current delivery is consumed or offered.
 */
const publishPendingMessages = (
  environment: DaemonEnvironment,
): Effect.Effect<void, DaemonRuntimeError> =>
  environment.delivery
    .runPass(() => {
      const { state } = environment;
      const { protocol } = state;
      if (protocol === undefined) {
        return undefined;
      }
      const handler = state.subscriptionActive ? state.handler : undefined;
      return {
        readPending: protocol.engine.readPendingMessages(),
        engine: protocol.engine,
        classify: protocol.collectives.classify,
        ...(handler === undefined
          ? {}
          : { handler: { publish: handler.notifyPending } }),
      };
    })
    .pipe(
      Effect.catchAll((error) => {
        const failure = runtimeFailure("storage");
        return reportStorageFault(environment, error).pipe(
          Effect.zipRight(Effect.fail(failure)),
        );
      }),
    );

/** A failed durable emission stops the daemon and refuses the collective result. */
const emitLocalItem = (
  environment: DaemonEnvironment,
  queued: Effect.Effect<void, EndpointStoreError>,
): Effect.Effect<void, CollectiveEmitError> =>
  queued.pipe(
    Effect.catchAll((error) =>
      reportStorageFault(environment, error).pipe(
        Effect.zipRight(Effect.fail(new CollectiveEmitError())),
      ),
    ),
  );

/** Communication starts once, independently of the request that saves the identity. */
const runProtocol = (
  environment: DaemonEnvironment,
  registration: Stream.Stream<Option.Option<VerifiedAgentCard>>,
  ready: Deferred.Deferred<undefined>,
  reconciler: Effect.Effect<void, DaemonRuntimeError>,
): Effect.Effect<void> =>
  registration.pipe(
    Stream.filterMap((card) => card),
    Stream.take(1),
    Stream.runHead,
    Effect.flatMap((card) =>
      Option.isSome(card) ? Effect.succeed(card.value) : Effect.interrupt,
    ),
    Effect.flatMap((agentCard) =>
      acquireProtocol(
        environment,
        {
          retain: (protocol) => {
            environment.state.protocol = protocol;
          },
          publishPending: Effect.ignore(reconciler),
          emit: (item, provenance, terminal) =>
            emitLocalItem(
              environment,
              environment.delivery.queueLocalItem(item, provenance, terminal),
            ),
        },
        agentCard,
      ),
    ),
    Effect.zipRight(Deferred.succeed(ready, undefined)),
    Effect.zipRight(
      reconciler.pipe(Effect.mapError(() => activationFailure("persistence"))),
    ),
    Effect.catchAllCause((cause) =>
      Cause.isInterruptedOnly(cause)
        ? Effect.interrupt
        : activationStopped(cause).pipe(
            Effect.flatMap((failure) =>
              Deferred.fail(environment.fatal, failure),
            ),
            Effect.asVoid,
          ),
    ),
    Effect.withSpan("runProtocol"),
  );

const runSubscriptionChanges = (
  environment: DaemonEnvironment,
  changes: Queue.Queue<boolean>,
  reconciler: Effect.Effect<void, DaemonRuntimeError>,
): Effect.Effect<never, DaemonRuntimeError> =>
  Queue.take(changes).pipe(
    Effect.flatMap((active) =>
      Effect.sync(() => {
        environment.state.subscriptionActive = active;
      }).pipe(
        Effect.zipRight(active ? Effect.void : environment.delivery.detach),
        Effect.zipRight(Effect.ignore(reconciler)),
      ),
    ),
    Effect.forever,
    Effect.catchAllCause((cause) =>
      failFromBackgroundCause(environment.fatal, cause),
    ),
  );

const assembleDaemon = (
  environment: DaemonEnvironment,
  changes: Queue.Queue<boolean>,
  ready: Deferred.Deferred<undefined>,
): RunningDaemon => ({
  deliveryOperations: deliveryOperations(environment, ready),
  eventStore: environment.delivery.eventStore,
  subscriptionChanged: (active) => {
    changes.unsafeOffer(active);
  },
  installHandler: (handler) =>
    Effect.sync(() => {
      environment.state.handler = handler;
      changes.unsafeOffer(handler.hasActiveSubscription());
    }),
  awaitFailure: Deferred.await(environment.fatal),
});

/**
 * Start daemon-scoped workers; communication waits for a saved identity.
 * @param input The startup state, history export and protocol edges.
 * @returns The daemon's saved-identity port, delivery operations and fatal signal.
 */
export const makeDaemon = (input: DaemonInput) =>
  Effect.gen(function* () {
    const daemonScope = yield* Scope.Scope;
    const registration = yield* LocalIdentity;
    const identity = yield* Identity;
    const ready = yield* Deferred.make<undefined>();
    const changes = yield* Queue.unbounded<boolean>();
    const state: DaemonState = {
      subscriptionActive: false,
    };
    const environment: DaemonEnvironment = {
      sql: yield* SqlClient.SqlClient,
      bootstrap: input.bootstrap,
      edges: input.edges,
      registry: yield* Registry,
      router: yield* Router,
      daemonScope,
      fatal: yield* Deferred.make<never, DaemonRuntimeError>(),
      state,
      identity,
      delivery: yield* daemonDelivery(input, state, daemonScope),
      ...(input.firewall === undefined ? {} : { firewall: input.firewall }),
    };
    yield* superviseWorkers(environment, registration.changes, ready, changes);
    return assembleDaemon(environment, changes, ready);
  }).pipe(Effect.withSpan("makeDaemon"));

function superviseWorkers(
  environment: DaemonEnvironment,
  registration: Stream.Stream<Option.Option<VerifiedAgentCard>>,
  ready: Deferred.Deferred<undefined>,
  changes: Queue.Queue<boolean>,
) {
  const reconciler = publishPendingMessages(environment);
  return Effect.gen(function* () {
    yield* environment.delivery.inboxChanged.pipe(
      Stream.runForEach(() => Effect.ignore(reconciler)),
      Effect.catchAll((error) => reportStorageFault(environment, error)),
      Effect.catchAllCause((cause) =>
        failFromBackgroundCause(environment.fatal, cause),
      ),
      Effect.interruptible,
      Effect.forkIn(environment.daemonScope),
    );
    yield* environment.delivery.runAdmission.pipe(
      Effect.catchAllCause((cause) =>
        failFromBackgroundCause(environment.fatal, cause),
      ),
      Effect.interruptible,
      Effect.forkIn(environment.daemonScope),
    );
    yield* runProtocol(environment, registration, ready, reconciler).pipe(
      Effect.interruptible,
      Effect.forkIn(environment.daemonScope),
    );
    yield* runSubscriptionChanges(environment, changes, reconciler).pipe(
      Effect.interruptible,
      Effect.forkIn(environment.daemonScope),
    );
    yield* registration.pipe(
      Stream.drop(1),
      Stream.runForEach(() =>
        Effect.sync(() => environment.state.handler?.notify.toolsChanged()),
      ),
      Effect.forkIn(environment.daemonScope),
    );
  });
}

function daemonDelivery(
  input: DaemonInput,
  state: DaemonState,
  scope: Scope.Scope,
) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* makeHostDelivery({
      historyExport: input.historyExport,
      experiments: input.bootstrap.configuration,
      collectives: () => {
        return state.protocol?.collectives;
      },
      ...(input.firewall === undefined
        ? {}
        : {
            firewall: input.firewall,
            firewallEnvironment: () => {
              return state.protocol === undefined ||
                input.firewall === undefined
                ? undefined
                : {
                    sql,
                    firewall: input.firewall,
                    localAgentCard: state.protocol.agentCard,
                    registrySignerPublicKey:
                      input.bootstrap.configuration.registrySignerPublicKey,
                  };
            },
          }),
      scope,
    }).pipe(Effect.mapError(() => runtimeFailure("storage")));
  });
}

/** Sends wait for communication startup while inbox operations use saved state. */
function deliveryOperations(
  environment: DaemonEnvironment,
  ready: Deferred.Deferred<undefined>,
): HostDelivery["operations"] {
  const operations = environment.delivery.operations;
  return {
    ...operations,
    send: (request) =>
      environment.identity.me().pipe(
        Effect.orDie,
        Effect.flatMap((identity) =>
          identity.kind === "unregistered"
            ? operations.send(request)
            : Deferred.await(ready).pipe(
                Effect.zipRight(operations.send(request)),
              ),
        ),
      ),
  };
}
