/** @file The daemon's loaded configuration and bootstrap authority, and the closed failure that loading them returns. */

import { Data, type Effect, type Redacted } from "effect";
import type { MessagePolicyConfigurationFailure } from "../firewall/index.js";
import type {
  HarnessMcpCredentials,
  HarnessMcpOperations,
} from "../harness/mcp/index.js";
import type {
  AgentSigningAuthority,
  Ed25519PublicKey as Ed25519PublicKeyValue,
} from "../identity/keys.js";

/** Closed reason that daemon configuration cannot become startup authority. */
export type DaemonConfigurationFailure =
  | "legacy-key"
  | "environment"
  | "agent-private-key-file"
  | "agent-private-key"
  | "admission-credential-file"
  | "admission-credential"
  | "mcp-runtime-credential-file"
  | "mcp-owner-credential-file"
  | "mcp-credential"
  | MessagePolicyConfigurationFailure;

/** Daemon configuration failure with a safe operator message. */
export class DaemonConfigurationError extends Data.TaggedError(
  "DaemonConfigurationError",
)<{
  readonly reason: DaemonConfigurationFailure;
  readonly message: string;
  readonly keys?: readonly string[];
}> {}

/** Exact non-secret values and redacted secret-file locations for one daemon. */
export interface DaemonProcessConfiguration {
  readonly registration?: Parameters<HarnessMcpOperations["register"]>[0];
  readonly stateDirectory: string;
  readonly mcpPort: number;
  readonly registryOrigin: URL;
  readonly registrySignerPublicKey: Ed25519PublicKeyValue;
  readonly routerOrigin: URL;
  readonly agentPrivateKeyFile: Redacted.Redacted;
  /**
   * Admission credential file an unregistered daemon requires; a daemon whose
   * state directory holds a registered identity never reads it. An empty
   * value is the same as an unset one.
   */
  readonly admissionCredentialFile?: Redacted.Redacted;
  /**
   * File the daemon appends its delivered and sent messages to, one JSON
   * line each, when the operator asks for that record.
   */
  readonly historyExport?: string;
  readonly mcpRuntimeCredentialFile?: Redacted.Redacted;
  readonly mcpOwnerCredentialFile?: Redacted.Redacted;
  /** The message-policy document the daemon installs as its firewall; unset, it installs none. */
  readonly messagePolicyFile?: string;
  /** The key of the decision provider a message policy names. */
  readonly decisionProviderKeyFile?: Redacted.Redacted;
  /** Where a message-policy daemon publishes its firewall audit on graceful shutdown. */
  readonly firewallAuditExport?: string;
}

/** Loaded private authority required by daemon registration and network calls. */
export interface DaemonBootstrap {
  readonly configuration: DaemonProcessConfiguration;
  readonly signingAuthority: AgentSigningAuthority;
  readonly agentPublicKey: Ed25519PublicKeyValue;
  /**
   * Reads and validates the admission credential file on first use, then
   * replays that outcome. Loading the bootstrap never reads the file.
   */
  readonly admissionCredential: Effect.Effect<
    Redacted.Redacted,
    DaemonConfigurationError
  >;
  readonly mcpCredentials?: HarnessMcpCredentials;
}
