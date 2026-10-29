/**
 * @file Production composition for one explicitly configured endpoint daemon.
 * @module service
 */

import { NodeHttpClient } from "@effect/platform-node";
import { Data, Duration, Effect, Layer } from "effect";
import { Router } from "../communication/router/api/client.js";
import {
  type EndpointStoreError,
  inspectEndpointStore,
  openEndpointStore,
  type OutboxTooOldError,
} from "../communication/store/index.js";
import {
  type FirewallInstallation,
  firewallInstallation,
  type FirewallPolicyError,
  type FirewallOptions as InstalledFirewallOptions,
  installEditableFirewall,
  type MessagePolicyConfigurationError,
  policyInstallationError,
} from "../firewall/index.js";
import { registrationAdmissionRefusalMessage } from "../harness/protocol/index.js";
import { Registry } from "../identity/registry/index.js";
import { wireVersions } from "../identity/wire-version.js";
import {
  DaemonConfigurationError,
  type DaemonProcessConfiguration,
} from "./bootstrap.js";
import {
  loadDaemonBootstrap,
  loadDaemonProcessConfiguration,
  processHelp,
} from "./configuration.js";
import { readCredential } from "./credentials.js";
import { type DaemonRuntimeError, runDaemonRuntime } from "./lifecycle.js";
import {
  type DaemonRegistrationPersistenceError,
  type DaemonRegistrationRepresentationError,
  readDaemonRegistrationState,
  requireAdmission,
  requireAdmissionToCreate,
} from "./registration/index.js";
import { spanExport } from "./telemetry.js";

// safer-arch-ignore no-large-public-surface: Daemon process composition, firewall installation and the actual Registry and Router client tags with their operation values share the trusted service embedding boundary.

const REGISTRY_REQUEST_TIMEOUT = Duration.seconds(30);
const ROUTER_SEND_TIMEOUT = Duration.seconds(30);
const ROUTER_POLL_TIMEOUT = Duration.seconds(35);

const liveWireVersions = wireVersions.liveSet;

/** Policy composition exposes checking factories, owner documents, and their validated contracts. */
export {
  CheckInputError,
  type DecisionProvider,
  DecisionProviderError,
  type DecisionRequest,
  type DecisionResponse,
  decodeMessagePolicy,
  type Firewall,
  FirewallPolicyError,
  type FirewallSettings,
  makeFirewall,
  makeTextPolicy,
  type Message,
  type MessageContext,
  type MessageMiddleware,
  MessagePolicy,
  messagePolicyFirewall,
  MiddlewareError,
  type MiddlewareInput,
  type MiddlewareResult,
  type RuleDescription,
  type TextPolicySettings,
  type TextRule,
} from "../firewall/index.js";

// eslint-disable-next-line @typescript-eslint/no-namespace -- The published service subpath intentionally merges its runtime values with the closed startup-error type.
export namespace Daemon {
  /** Usage text listing the daemon process's environment variables. */
  export const help = processHelp;

  /**
   * Trusted composition fixes code and evidence while owner tools edit natural-language rules.
   * See {@link withFirewall} for the composition fields.
   */
  export type FirewallOptions = InstalledFirewallOptions;

  /** Closed startup phase with sanitized configuration details. */
  export class StartupError extends Data.TaggedError("DaemonStartupError")<{
    readonly phase: "configuration" | "storage" | "listener" | "registration";
    readonly reason?:
      | "outbox-too-old"
      | "newer-schema"
      | "pre-reset"
      | "agent-not-admitted"
      | "admission-refused"
      | "name_taken"
      | "key_already_registered"
      | "idempotency_conflict"
      | "dependency-unavailable"
      | "persistence-failed"
      | "incompatible-daemon";
    readonly detail?: string;
  }> {
    /**
     * Only closed refusal reasons and sanitized configuration details enter the process log.
     * @returns The startup phase and any safe operator diagnostic.
     */
    override get message(): string {
      const reason = this.reason === undefined ? "" : ` (${this.reason})`;
      const detail = this.detail === undefined ? "" : `: ${this.detail}`;
      let remedy = "";
      if (this.reason === "agent-not-admitted") {
        remedy =
          ". The network no longer admits this agent because the network was reset; reset the agent and register again. Docs: https://docs.moltzap.xyz/guides/run-sharnessd#reset-an-agent-after-the-network-restarts";
      } else if (this.reason === "admission-refused") {
        remedy = `. ${registrationAdmissionRefusalMessage}`;
      } else if (this.reason === "pre-reset") {
        remedy =
          ". Start with a fresh state directory and register again. Docs: https://docs.moltzap.xyz/guides/upgrades#apply-a-reset-release";
      } else if (this.reason === "outbox-too-old") {
        remedy =
          ". Drain the outbox on the previous release before upgrading, or apply a reset release. Docs: https://docs.moltzap.xyz/guides/upgrades#apply-a-reset-release";
      } else if (this.reason === "newer-schema") {
        remedy =
          ". A newer release wrote this state directory; run that release or a later one. Docs: https://docs.moltzap.xyz/guides/upgrades#upgrade-daemons-on-restart";
      }
      return `sharnessd startup failed in phase ${this.phase}${reason}${detail}${remedy}`;
    }
  }

  const runDaemon = (composed?: FirewallInstallation) =>
    Effect.gen(function* () {
      const configuration = yield* loadDaemonProcessConfiguration.pipe(
        Effect.mapError(configurationFailure),
      );
      const installation = yield* firewallInstallation(
        configuration,
        readCredential,
        composed,
      ).pipe(
        Effect.mapError(daemonPolicyConfigurationError),
        Effect.mapError(configurationFailure),
      );
      const bootstrap = yield* loadDaemonBootstrap(configuration).pipe(
        Effect.mapError(configurationFailure),
      );
      const opening = yield* inspectEndpointStore(
        configuration.stateDirectory,
      ).pipe(Effect.mapError(storageFailure));
      yield* requireAdmissionToCreate(opening, bootstrap).pipe(
        Effect.mapError(configurationFailure),
      );
      const store = yield* openEndpointStore(configuration.stateDirectory, {
        liveWireVersions: yield* liveWireVersions,
      }).pipe(Effect.mapError(storageFailure));
      const firewall =
        installation.options === undefined
          ? undefined
          : yield* installEditableFirewall(installation.options, store).pipe(
              Effect.mapError((cause) => installFailure(installation, cause)),
            );
      const registration = yield* readDaemonRegistrationState({
        store,
        bootstrap,
      }).pipe(Effect.mapError(storageFailure));
      yield* requireAdmission(registration, bootstrap).pipe(
        Effect.mapError(configurationFailure),
      );
      const networkContext = yield* Layer.build(networkLayer(configuration));
      return yield* runDaemonRuntime({
        store,
        bootstrap,
        registration,
        firewall,
      }).pipe(
        Effect.provide(networkContext),
        Effect.mapError(runtimeStartupFailure),
      );
    }).pipe(Effect.withSpan("Daemon.layer"));

  /**
   * The opt-in span export each composition is built inside, so it closes
   * after the daemon and flushes every span the daemon ended.
   */
  const telemetry = Layer.mapError(spanExport, configurationFailure);

  /**
   * Complete production process composition for `sharnessd`, with the
   * firewall `SHARNESS_MESSAGE_POLICY_FILE` describes when it is set.
   */
  export const layer: Layer.Layer<never, StartupError> = Layer.scopedDiscard(
    runDaemon(),
  ).pipe(Layer.provide(telemetry));

  /**
   * Fixed middleware and persisted natural-language rules are installed before the daemon accepts host calls.
   * The environment must not also name a message-policy document.
   * @param options Fixed chains, provider settings and initial editable natural-language documents.
   * @returns The complete daemon layer with both message boundaries checked.
   */
  export const withFirewall = (
    options: FirewallOptions,
  ): Layer.Layer<never, StartupError> => {
    return Layer.scopedDiscard(runDaemon({ options })).pipe(
      Layer.provide(telemetry),
    );
  };

  /**
   * Public startup failures retain the phase and actionable compatibility refusal.
   * @param error Private runtime failure to project onto the process boundary.
   * @returns The closed startup error without private runtime detail.
   */
  function runtimeStartupFailure(error: DaemonRuntimeError): StartupError {
    return new StartupError({
      phase: error.phase,
      ...(error.reason === undefined ? {} : { reason: error.reason }),
    });
  }

  /**
   * A file-described firewall that fails to install names its setting.
   * @param installation What the daemon was installing, and from where.
   * @param cause The closed installation failure.
   * @returns The configuration-phase startup failure.
   */
  function installFailure(
    installation: FirewallInstallation,
    cause: FirewallPolicyError,
  ): StartupError {
    if (installation.fromPolicyFile === true) {
      return configurationFailure(
        daemonPolicyConfigurationError(
          policyInstallationError(cause, installation.behaviorRulePaths),
        ),
      );
    }
    return configurationFailure(cause);
  }

  /**
   * Policy startup failures retain their exact reason and message at the daemon boundary.
   * @param cause The policy loader's closed configuration failure.
   * @returns The daemon configuration error with the same reason and message.
   */
  function daemonPolicyConfigurationError(
    cause: MessagePolicyConfigurationError,
  ): DaemonConfigurationError {
    return new DaemonConfigurationError({
      reason: cause.reason,
      message: cause.message,
    });
  }

  function configurationFailure(cause: unknown): StartupError {
    return new StartupError({
      phase: "configuration",
      detail:
        cause instanceof DaemonConfigurationError ? cause.message : undefined,
    });
  }

  /** Operational failures keep their storage phase; only reset boundaries add a reason. */
  const storeStartupReasons = {
    "pre-reset": "pre-reset",
    "newer-schema": "newer-schema",
    closed: undefined,
    conflict: undefined,
    corrupt: undefined,
    incompatible: undefined,
    "invalid-continuation": undefined,
    "invalid-input": undefined,
    "not-found": undefined,
    persistence: undefined,
  } satisfies Record<EndpointStoreError["reason"], StartupError["reason"]>;

  function storageFailure(
    error:
      | EndpointStoreError
      | OutboxTooOldError
      | DaemonRegistrationPersistenceError
      | DaemonRegistrationRepresentationError,
  ): StartupError {
    switch (error._tag) {
      case "DaemonRegistrationPersistenceError":
      case "DaemonRegistrationRepresentationError":
        return new StartupError({ phase: "storage" });
      case "OutboxTooOldError":
        return new StartupError({ phase: "storage", reason: "outbox-too-old" });
      case "EndpointStoreError":
        return new StartupError({
          phase: "storage",
          reason: storeStartupReasons[error.reason],
        });
      default: {
        const exhaustive: never = error;
        return exhaustive;
      }
    }
  }
}

function networkLayer(configuration: DaemonProcessConfiguration) {
  return Layer.merge(
    Registry.layer({
      origin: configuration.registryOrigin,
      registrySignerPublicKey: configuration.registrySignerPublicKey,
      requestTimeout: REGISTRY_REQUEST_TIMEOUT,
    }),
    Router.layer({
      origin: configuration.routerOrigin,
      sendTimeout: ROUTER_SEND_TIMEOUT,
      pollTimeout: ROUTER_POLL_TIMEOUT,
    }),
  ).pipe(Layer.provide(NodeHttpClient.layer));
}

/** Immutable resolution and registration require only an injected HTTP client. */
export { Registry } from "../identity/registry/index.js";

/** Closed network operation values and client failures for service embedders. */
export { Router } from "../communication/router/api/client.js";
/** Route refusals and transport failures retain separate typed channels. */
export {
  PollCursor,
  RouterConnectionError,
  RouterInstanceId,
  RouterInvalidResponseError,
  RouterPollRequest,
  RouterPollResult,
  RouterRequestTimeoutError,
  RouterSendRequest,
  RouterSendResult,
  SignedMessageDigest,
} from "../communication/router/api/contract.js";
/** Registration and immutable reads preserve exact operation errors and results. */
export {
  OperationId,
  RegistryConnectionError,
  RegistryInvalidResponseError,
  RegistryLookupRequest,
  type RegistryLookupResult,
  RegistryRegisterRequest,
  type RegistryRegisterResult,
  RegistryRequestTimeoutError,
} from "../identity/registry/contract.js";
