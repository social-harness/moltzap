/**
 * @file The running daemon: its registration state, the activation gate,
 * subscriptions, delivery passes and the fatal signal that stops it.
 */

import { Cause, Deferred, Effect, Option, Queue, Scope } from "effect";
import type { EndpointStoreError } from "../../communication/store/index.js";
import type { InstalledFirewall } from "../../firewall/index.js";
import type { VerifiedAgentCard } from "../../identity/cards.js";
import type { DaemonBootstrap } from "../bootstrap.js";
import type { HistoryExportPort } from "../inbox/host-traffic-log.js";
import type { HarnessMcpEventHandler } from "../mcp/index.js";
import type { DaemonRegistrationState } from "../registration/index.js";
import type { DaemonStore } from "../store.js";
import { CollectiveEmitError } from "../../communication/collectives/index.js";
import { Router } from "../../communication/router/index.js";
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
  readonly store: DaemonStore;
  readonly bootstrap: DaemonBootstrap;
  readonly registration: DaemonRegistrationState;
  readonly firewall?: InstalledFirewall;
}

/** The running daemon the lifecycle composes into MCP operations. */
export interface RunningDaemon {
  /** The registration status reads; active from the bind commit on. */
  readonly readRegistration: () => DaemonRegistrationState;
  /**
   * Whether the protocol is up: from the moment activation acquires the
   * engine and Router worker for the bound card. The MCP catalog reads it.
   */
  readonly protocolActive: () => boolean;
  /**
   * Marks the daemon active with the card just bound, then activates its
   * protocol. A failure or defect also stops the daemon, since the binding
   * is durable; only an interrupt leaves it running. Hosts listening for
   * tool list changes hear once the protocol is up.
   */
  readonly activateRegistered: (
    agentCard: VerifiedAgentCard,
  ) => Effect.Effect<void, DaemonActivationError>;
  readonly deliveryOperations: HostDelivery["operations"];
  readonly eventStore: HostDelivery["eventStore"];
  readonly subscriptionChanged: (active: boolean) => void;
  readonly installHandler: (
    handler: SubscriptionHandler,
  ) => Effect.Effect<void>;
  readonly runSubscriptions: Effect.Effect<never, DaemonRuntimeError>;
  readonly awaitFailure: Effect.Effect<never, DaemonRuntimeError>;
  /**
   * Activates the protocol of a daemon that started registered. A failure or
   * defect fails it in the phase registration activation would stop in.
   */
  readonly activateAtStart: Effect.Effect<void, DaemonRuntimeError>;
}

type SubscriptionHandler = Pick<
  HarnessMcpEventHandler,
  "hasActiveSubscription" | "notifyPending" | "notify"
>;

interface DaemonInput extends DaemonStartup {
  readonly historyExport: HistoryExportPort;
  readonly edges: ProtocolEdges;
}

/**
 * Binding is visible to management before protocol resources are ready.
 * See docs/reference/spec/daemon/management.md and docs/reference/spec/daemon/daemon.md.
 */
type DaemonIdentity =
  | { readonly kind: "unregistered" }
  | { readonly kind: "bound"; readonly card: VerifiedAgentCard }
  | { readonly kind: "running"; readonly protocol: ActiveProtocol };

/**
 * The identity of a daemon bound to its card and not yet running.
 * @param card The card the store committed for this daemon.
 * @returns The frozen bound identity.
 */
const boundIdentity = (card: VerifiedAgentCard): DaemonIdentity =>
  Object.freeze({ kind: "bound", card });

/**
 * The identity of a daemon whose protocol runs.
 * @param protocol The protocol resources acquired for the bound card.
 * @returns The frozen running identity.
 */
const runningIdentity = (protocol: ActiveProtocol): DaemonIdentity =>
  Object.freeze({ kind: "running", protocol });

/** Mutable daemon state shared with supervised protocol resources. */
interface DaemonState {
  identity: DaemonIdentity;
  subscriptionActive: boolean;
  handler?: SubscriptionHandler;
}

interface DaemonEnvironment extends ProtocolEnvironment {
  readonly state: DaemonState;
  readonly delivery: HostDelivery;
}

type InitializeProtocol = (
  agentCard: VerifiedAgentCard,
) => Effect.Effect<void, DaemonActivationError>;

interface DaemonAssembly {
  readonly environment: DaemonEnvironment;
  readonly changes: Queue.Queue<boolean>;
  readonly reconciler: Effect.Effect<void, DaemonRuntimeError>;
  readonly initialize: InitializeProtocol;
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
 * releases the gate, signals the storage failure, and fails with it, so
 * startup and registration stop there instead of continuing.
 * @param environment The daemon's state, delivery and fatal signal.
 * @returns Completion after every current delivery is consumed or offered.
 */
const publishPendingMessages = (
  environment: DaemonEnvironment,
): Effect.Effect<void, DaemonRuntimeError> =>
  environment.delivery
    .runPass(() => {
      const { state } = environment;
      if (state.identity.kind !== "running") {
        return undefined;
      }
      const { protocol } = state.identity;
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

/**
 * Queue an item the collective layer emitted and start a publication pass.
 * The pass is forked because the layer can emit from inside one, which holds
 * the delivery gate. An item the store cannot keep signals the storage
 * failure and fails the emission, so a pass that emitted it ends and
 * releases the gate.
 * @param environment The daemon's delivery, fatal signal and scope.
 * @param reconciler The publication pass to fork.
 * @param queued Queues the emitted result, with its provenance, or failure.
 * @returns Completion once the item is durable and the pass is forked.
 */
const emitLocalItem = (
  environment: DaemonEnvironment,
  reconciler: Effect.Effect<void, DaemonRuntimeError>,
  queued: Effect.Effect<void, EndpointStoreError>,
): Effect.Effect<void, CollectiveEmitError> =>
  queued.pipe(
    Effect.catchAll((error) =>
      reportStorageFault(environment, error).pipe(
        Effect.zipRight(Effect.fail(new CollectiveEmitError())),
      ),
    ),
    Effect.zipRight(
      Effect.forkIn(Effect.ignore(reconciler), environment.daemonScope),
    ),
    Effect.asVoid,
  );

/**
 * Activate the protocol for one immutable daemon identity and publish the
 * deliveries it recovered.
 * @param environment Daemon-owned dependencies, state and resource scope.
 * @param activationGate Serializes registration and restart activation.
 * @param reconciler Publishes durable pending deliveries after transitions.
 * @param agentCard Verified local identity to activate.
 * @returns Completion after engine and worker fibers are running and the
 *   first pass has run.
 */
const initializeProtocol = (
  environment: DaemonEnvironment,
  activationGate: Effect.Semaphore,
  reconciler: Effect.Effect<void, DaemonRuntimeError>,
  agentCard: VerifiedAgentCard,
): Effect.Effect<void, DaemonActivationError> =>
  activationGate
    .withPermits(1)(
      Effect.gen(function* () {
        const { identity } = environment.state;
        if (identity.kind === "unregistered") {
          return yield* Effect.fail(activationFailure("representation"));
        }
        const boundCard =
          identity.kind === "bound"
            ? identity.card
            : identity.protocol.agentCard;
        if (
          boundCard.agentId !== agentCard.agentId ||
          boundCard.publicKey.x !== agentCard.publicKey.x
        ) {
          return yield* Effect.fail(activationFailure("representation"));
        }
        if (identity.kind === "running") {
          return;
        }
        yield* acquireProtocol(
          environment,
          {
            retain: (protocol) => {
              environment.state.identity = runningIdentity(protocol);
              environment.state.handler?.notify.toolsChanged();
            },
            publishPending: Effect.ignore(reconciler),
            emit: (item, provenance, terminal) =>
              emitLocalItem(
                environment,
                reconciler,
                environment.delivery.queueLocalItem(item, provenance, terminal),
              ),
          },
          agentCard,
        );
        yield* reconciler.pipe(
          Effect.mapError(() => activationFailure("persistence")),
        );
      }),
    )
    .pipe(Effect.withSpan("initializeProtocol"));

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

const activateRegistered = (
  environment: DaemonEnvironment,
  initialize: InitializeProtocol,
  agentCard: VerifiedAgentCard,
): Effect.Effect<void, DaemonActivationError> =>
  Effect.sync(() => {
    if (environment.state.identity.kind !== "running") {
      environment.state.identity = boundIdentity(agentCard);
    }
  }).pipe(
    Effect.zipRight(initialize(agentCard)),
    Effect.tapErrorCause((cause) =>
      Cause.isInterruptedOnly(cause)
        ? Effect.void
        : activationStopped(cause).pipe(
            Effect.flatMap((failure) =>
              Deferred.fail(environment.fatal, failure),
            ),
          ),
    ),
  );

const activateAtStart = (
  environment: DaemonEnvironment,
  initialize: InitializeProtocol,
): Effect.Effect<void, DaemonRuntimeError> =>
  Effect.suspend(() => {
    const { identity } = environment.state;
    if (identity.kind === "unregistered") {
      return Effect.void;
    }
    return initialize(
      identity.kind === "bound" ? identity.card : identity.protocol.agentCard,
    ).pipe(
      Effect.catchAllCause((cause) =>
        Cause.isInterruptedOnly(cause)
          ? Effect.interrupt
          : activationStopped(cause).pipe(
              Effect.flatMap((failure) => Effect.fail(failure)),
            ),
      ),
    );
  });

const assembleDaemon = ({
  environment,
  changes,
  reconciler,
  initialize,
}: DaemonAssembly): RunningDaemon => ({
  readRegistration: () => {
    const { identity } = environment.state;
    return identity.kind === "unregistered"
      ? identity
      : Object.freeze({
          kind: "active",
          agentCard:
            identity.kind === "bound"
              ? identity.card
              : identity.protocol.agentCard,
        });
  },
  protocolActive: () => environment.state.identity.kind === "running",
  activateRegistered: (agentCard) =>
    activateRegistered(environment, initialize, agentCard),
  deliveryOperations: environment.delivery.operations,
  eventStore: environment.delivery.eventStore,
  subscriptionChanged: (active) => {
    changes.unsafeOffer(active);
  },
  installHandler: (handler) =>
    Effect.sync(() => {
      environment.state.handler = handler;
      changes.unsafeOffer(handler.hasActiveSubscription());
    }),
  runSubscriptions: runSubscriptionChanges(environment, changes, reconciler),
  awaitFailure: Deferred.await(environment.fatal),
  activateAtStart: activateAtStart(environment, initialize),
});

/**
 * Acquire the running daemon without activating its protocol or starting the
 * MCP listener.
 * @param input The startup state, history export and protocol edges.
 * @returns The daemon's registration port, delivery operations and
 *   supervised lifecycle effects.
 */
export const makeDaemon = (
  input: DaemonInput,
): Effect.Effect<
  RunningDaemon,
  DaemonRuntimeError,
  Registry | Router | Scope.Scope
> =>
  Effect.gen(function* () {
    const daemonScope = yield* Scope.Scope;
    const activationGate = yield* Effect.makeSemaphore(1);
    const changes = yield* Queue.unbounded<boolean>();
    const state: DaemonState = {
      identity:
        input.registration.kind === "unregistered"
          ? Object.freeze({ kind: "unregistered" })
          : boundIdentity(input.registration.agentCard),
      subscriptionActive: false,
    };
    const delivery = yield* daemonDelivery(input, state, daemonScope);
    const environment: DaemonEnvironment = {
      store: input.store,
      bootstrap: input.bootstrap,
      edges: input.edges,
      registry: yield* Registry,
      router: yield* Router,
      daemonScope,
      fatal: yield* Deferred.make<never, DaemonRuntimeError>(),
      state,
      delivery,
      ...(input.firewall === undefined ? {} : { firewall: input.firewall }),
    };
    const reconciler = publishPendingMessages(environment);
    yield* delivery.runAdmission(Effect.ignore(reconciler)).pipe(
      Effect.catchAllCause((cause) =>
        failFromBackgroundCause(environment.fatal, cause),
      ),
      Effect.forkIn(daemonScope),
    );
    return assembleDaemon({
      environment,
      changes,
      reconciler,
      initialize: (agentCard) =>
        initializeProtocol(environment, activationGate, reconciler, agentCard),
    });
  }).pipe(Effect.withSpan("makeDaemon"));

function daemonDelivery(
  input: DaemonInput,
  state: DaemonState,
  scope: Scope.Scope,
) {
  return makeHostDelivery({
    store: input.store,
    historyExport: input.historyExport,
    experiments: input.bootstrap.configuration,
    collectives: () => {
      if (state.identity.kind !== "running") {
        return undefined;
      }
      return state.identity.protocol.collectives;
    },
    ...(input.firewall === undefined
      ? {}
      : {
          firewall: input.firewall,
          firewallEnvironment: () => {
            return state.identity.kind !== "running" ||
              input.firewall === undefined
              ? undefined
              : {
                  store: input.store,
                  installed: input.firewall,
                  localAgentCard: state.identity.protocol.agentCard,
                };
          },
        }),
    scope,
  }).pipe(Effect.mapError(() => runtimeFailure("storage")));
}
