/** @file Personal firewall evaluation, policy, admission and owner decisions. */

/** Code and natural-language policies use one evaluator contract. */
export {
  CheckInputError,
  type DecisionProvider,
  DecisionProviderError,
  type DecisionRequest,
  type DecisionResponse,
  type Firewall,
  FirewallSettings,
  makeFirewall,
  makeTextPolicy,
  Message,
  MessageContext,
  type MessageMiddleware,
  MiddlewareError,
  type MiddlewareInput,
  type MiddlewareResult,
  RuleDescription,
  TextPolicySettings,
  TextRule,
} from "./evaluator/index.js";
/** Authenticated policy management shares one owned grammar. */
export {
  firewallDecisionsRequestSchema,
  firewallDecisionsSchema,
  FirewallPolicyError,
  type FirewallPolicyOperations,
  policyReadSchema,
  policyUpdateResultSchema,
  policyUpdateSchema,
} from "./policy/contract.js";
/** Trusted construction and its process lifetime belong to policy. */
export type {
  FirewallOptions,
  InstalledFirewall,
} from "./policy/installation.js";
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
