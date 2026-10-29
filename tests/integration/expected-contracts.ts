/** @file Operator-visible contracts of daemon management, startup and sends. */

/** The daemon register tool reports this kind after committing its identity. */
export const registrationResultKind = "registered";

/** The daemon status tool reports this kind when its persisted identity is active. */
export const registeredDaemonStatus = "active";

/** Daemon read_conversation marks an anchor with this kind after Router recovery. */
export const completedReanchorKind = "completed_reanchor";

/** Daemon startup reports this phase when its persisted state or identity row refuses this binary. */
export const storageStartupPhase = "storage";

/** Daemon.StartupError.phase reports this value when startup configuration is invalid. */
export const configurationStartupPhase = "configuration";

/** Daemon startup reports this reason when retained outbound bytes have left the live window. */
export const outboxTooOldReason = "outbox-too-old";

/** Daemon startup tells operators to drain retained outbound bytes with the previous release. */
export const outboxTooOldRemedy = "Drain the outbox on the previous release";

/** Daemon startup reports this reason when the database schema is newer than the binary. */
export const newerSchemaReason = "newer-schema";

/** Daemon startup reports this reason for populated state from before the reset release. */
export const preResetReason = "pre-reset";

/** Daemon startup asks operators to register a fresh state directory when retained state predates the reset. */
export const preResetRemedy =
  "Start with a fresh state directory and register again";

/** Daemon startup links this upgrade heading when retained state requires a reset release. */
export const resetReleaseDocsAnchor = "how-to/upgrades#apply-a-reset-release";

/** Daemon startup names this setting when its message-policy document is invalid. */
export const messagePolicyFileSetting = "SHARNESS_MESSAGE_POLICY_FILE";

/** The daemon send_message tool returns this remedy when its code rule refuses credential-shaped text. */
export const credentialRefusalRemedy = "Remove credential-shaped text";

/** A Router authentication rejection after reset stops the daemon at its listener boundary. */
export const agentNotAdmittedDiagnostic =
  "sharnessd startup failed in phase listener (agent-not-admitted)";

/** Daemon startup explains the lost registration and the operator's recovery action. */
export const agentNotAdmittedRemedy =
  "network was reset; reset the agent and register again";

/** The recovery guide ends the daemon's network-reset diagnostic. */
export const agentResetDocsLink =
  "Docs: https://docs.moltzap.xyz/how-to/run-sharnessd#reset-an-agent-after-the-network-restarts";
