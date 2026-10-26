/** @file Firewall installation, checking and incoming admission ports. */

// safer-arch-ignore no-inventory-barrel: Admission exposes installation, the shared environment, retained check decoding and the incoming worker as the ports policy and delivery consume.

/** Trusted composition installs immutable chains, captures their registrations and builds outgoing collective admission. */
export {
  captureRegistration,
  collectiveAdmission,
  type FirewallOptions,
  installFirewall,
} from "./firewall.js";
/** Checking and delivery share the installed firewall and its execution environment. */
export {
  type FirewallEnvironment,
  type InstalledFirewall,
} from "./firewall-checks.js";
/** The decisions feed decodes retained checks independently of private storage. */
export { decodeFirewallAuditEntry } from "./firewall-values.js";
/** Delivery supplies verified context to the incoming admission worker. */
export { type AdmissionContext, runAdmission } from "./admission.js";
