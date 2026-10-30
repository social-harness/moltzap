/** @file Firewall installation, checking and incoming admission ports. */

// safer-arch-ignore no-inventory-barrel: Admission exposes installation, the shared environment, retained check decoding and the incoming worker as the ports policy and delivery consume.

/** Checking and delivery share the installed firewall and its execution environment. */
export { type FirewallEnvironment } from "./firewall-checks.js";
/** The decisions feed decodes retained checks independently of private storage. */
export { decodeFirewallAuditEntry } from "./audit-records.js";
/** Delivery supplies verified context to the incoming admission worker. */
export { type AdmissionContext, runAdmission } from "./incoming-worker.js";
