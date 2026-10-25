/** @file Operator-visible contracts of daemon management, startup, sends and audit exports. */

/** The daemon register tool reports this kind after committing its identity. */
export const registrationResultKind = "registered";

/** The daemon status tool reports this kind when its persisted identity is active. */
export const registeredDaemonStatus = "active";

/** Daemon read_conversation marks an anchor with this kind after Router recovery. */
export const completedReanchorKind = "completed_reanchor";

/** Daemon startup reports this phase when its persisted database cannot be opened. */
export const storageStartupPhase = "storage";

/** Daemon startup reports this reason when retained outbound bytes have left the live window. */
export const outboxTooOldReason = "outbox-too-old";

/** Daemon startup tells operators to drain retained outbound bytes with the previous release. */
export const outboxTooOldRemedy = "Drain the outbox on the previous release";

/** Daemon startup reports this reason when the database schema is newer than the binary. */
export const newerSchemaReason = "newer-schema";

/** Service startup reports this reason when a retired environment key is set. */
export const legacySettingReason = "legacy-key";

/** Daemon startup reports this reason for populated state from before the reset release. */
export const preResetReason = "pre-reset";

/** Daemon startup asks operators to register a fresh state directory when retained state predates the reset. */
export const preResetRemedy =
  "Start with a fresh state directory and register again";

/** Daemon startup links this upgrade heading when retained state requires a reset release. */
export const resetReleaseDocsAnchor =
  "docs/guides/upgrades.mdx#apply-a-reset-release";

/** Daemon startup names this setting when its message-policy document is invalid. */
export const messagePolicyFileSetting = "SHARNESS_MESSAGE_POLICY_FILE";

/** The daemon send_message tool returns this remedy when its code rule refuses credential-shaped text. */
export const credentialRefusalRemedy = "Remove credential-shaped text";

/** The daemon firewall audit export opens with this record kind when the firewall starts. */
export const auditStartKind = "start";

/** The daemon firewall audit export ends with this record kind after shutdown flushes its checks. */
export const auditCompleteKind = "complete";
