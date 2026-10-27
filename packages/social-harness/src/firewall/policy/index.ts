/** @file Message-policy documents, configuration, composition and persisted owner edits. */

// safer-arch-ignore no-inventory-barrel: Policy exposes document decoding, trusted installation, owner edits and closed configuration failures as one policy boundary; file loading stays private.

/** Daemon startup decides its firewall; trusted composition installs a decoded document with its own decision provider. */
export {
  type FirewallInstallation,
  firewallInstallation,
  messagePolicyFirewall,
  policyInstallationError,
} from "./compose.js";
/** Writers build documents with the schema the daemon decodes them with. */
export { decodeMessagePolicy, MessagePolicy } from "./document/index.js";
/** Owner edits persist before immutable active policy chains are replaced. */
export { installEditableFirewall } from "./editable.js";
/** Policy configuration failures carry closed reasons and safe operator messages. */
export {
  MessagePolicyConfigurationError,
  type MessagePolicyConfigurationFailure,
} from "./configuration.js";
