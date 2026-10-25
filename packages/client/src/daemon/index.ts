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

// safer-arch-ignore no-large-public-surface: Trusted process composition and its operator audit decoder share this service-only boundary; moving the decoder to another entrypoint would split one fixed installation contract.

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
  type EnglishPolicySettings,
  type EnglishRule,
  type Firewall,
  FirewallAuditRecord,
  FirewallPolicyError,
  type FirewallSettings,
  makeEnglishPolicy,
  makeFirewall,
  makeJevDecisionProvider,
  type Message,
  type MessageContext,
  type MessageMiddleware,
  MessagePolicy,
  messagePolicyFirewall,
  MiddlewareError,
  type MiddlewareInput,
  type MiddlewareResult,
  type RuleDescription,
} from "../firewall/index.js";

// eslint-disable-next-line @typescript-eslint/no-namespace -- The published service subpath intentionally merges its runtime values with the closed startup-error type.
export namespace Daemon {
  /** Usage text listing the daemon process's environment variables. */
  export const help = processHelp;

  /** Trusted process composition fixes code and evidence while owner tools edit English rules. */
  export type FirewallOptions = InstalledFirewallOptions & {
    /**
     * Dedicated file and adjacent `.partial` staging name for this endpoint's
     * state directory, privately owned by the daemon and published on shutdown.
     */
    readonly auditExport?: string;
  };

  /** Closed startup phase with sanitized configuration details. */
  export class StartupError extends Data.TaggedError("DaemonStartupError")<{
    readonly phase: "configuration" | "storage" | "listener";
    readonly reason?:
      | "outbox-too-old"
      | "newer-schema"
      | "pre-reset"
      | "legacy-key";
    readonly keys?: readonly string[];
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
      if (this.reason === "pre-reset") {
        remedy =
          ". Start with a fresh state directory and register again; see https://github.com/social-harness/moltzap/blob/main/docs/guides/upgrades.mdx#apply-a-reset-release.";
      } else if (this.reason === "outbox-too-old") {
        remedy =
          ". Drain the outbox on the previous release before upgrading, or apply a reset release; see https://github.com/social-harness/moltzap/blob/main/docs/guides/upgrades.mdx#apply-a-reset-release.";
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
        auditExport: installation.auditExport,
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
   * Fixed middleware and persisted English rules are installed before the daemon accepts host calls.
   * The environment must not also name a message-policy document.
   * @param options Fixed chains, provider settings and initial editable English documents.
   * @returns The complete daemon layer with both message boundaries checked.
   */
  export const withFirewall = (
    options: FirewallOptions,
  ): Layer.Layer<never, StartupError> => {
    const { auditExport, ...policyOptions } = options;
    return Layer.scopedDiscard(
      runDaemon({ options: policyOptions, auditExport }),
    ).pipe(Layer.provide(telemetry));
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
        daemonPolicyConfigurationError(policyInstallationError(cause)),
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
      ...(cause instanceof DaemonConfigurationError &&
      cause.reason === "legacy-key"
        ? { reason: "legacy-key" as const, keys: cause.keys }
        : {}),
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
export { Registry } from "../identity/registry/capability.js";

/** Closed network operation values and client failures for service embedders. */
export { Router } from "../communication/router/api/capability.js";
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
  RegistryListRequest,
  type RegistryListResult,
  RegistryLookupRequest,
  type RegistryLookupResult,
  RegistryRegisterRequest,
  type RegistryRegisterResult,
  RegistryRequestTimeoutError,
} from "../identity/registry/contract.js";
