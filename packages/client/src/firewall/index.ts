/** @file Personal firewall evaluation, policy, admission and operator audit. */

/** Code and English policies use one evaluator contract. */
export {
  CheckInputError,
  type DecisionProvider,
  DecisionProviderError,
  type DecisionRequest,
  type DecisionResponse,
  EnglishPolicySettings,
  EnglishRule,
  type Firewall,
  firewallDecisionsRequestSchema,
  firewallDecisionsSchema,
  FirewallPolicyError,
  type FirewallPolicyOperations,
  FirewallSettings,
  makeEnglishPolicy,
  makeFirewall,
  makeJevDecisionProvider,
  Message,
  MessageContext,
  type MessageMiddleware,
  MiddlewareError,
  type MiddlewareInput,
  type MiddlewareResult,
  policyReadSchema,
  policyUpdateResultSchema,
  policyUpdateSchema,
  proposalDecisionSchema,
  proposalsRequestSchema,
  proposalsResultSchema,
  RuleDescription,
} from "./evaluator/index.js";
/** Trusted composition installs policy before admitting application traffic. */
export {
  collectiveAdmission,
  type FirewallOptions,
  installFirewall,
} from "./admission/index.js";
/** The daemon retains one installed admission capability. */
export type { InstalledFirewall } from "./admission/index.js";
/** Operator audit stays outside runtime-visible guidance. */
export { beginFirewallAudit } from "./audit/firewall-audit.js";
/** Retained judgments have a versioned operator representation. */
export { FirewallAuditRecord } from "./admission/index.js";
/** Owner edits preserve the daemon resource lifetime. */
export { installEditableFirewall } from "./policy/index.js";
/** Policy documents and their composition share one firewall boundary. */
export {
  decodeMessagePolicy,
  type FirewallInstallation,
  firewallInstallation,
  MessagePolicy,
  MessagePolicyConfigurationError,
  messagePolicyFirewall,
  policyInstallationError,
} from "./policy/index.js";

/** Policy loading requires no daemon bootstrap authority. */
export type { MessagePolicyConfigurationFailure } from "./policy/index.js";

/** Delivery supplies context and drains the firewall's incoming queue. */
export {
  type AdmissionContext,
  type FirewallEnvironment,
  runAdmission,
} from "./admission/index.js";
