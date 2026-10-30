/** @file Inputs the daemon supplies to policy loading without granting bootstrap authority. */

import { Data, type Effect, type Redacted, type Schema } from "effect";

/** Closed reasons the policy settings cannot start the daemon. */
export type MessagePolicyConfigurationFailure =
  | "message-policy-file"
  | "message-policy"
  | "message-policy-composed"
  | "decision-provider-key-file"
  | "decision-provider-key";

/** Behavior diagnostics reveal only a closed category and the policy entry. */
export type BehaviorFailure =
  | "missing"
  | "too-large"
  | "not-a-file"
  | "frontmatter"
  | "schema"
  | "duplicate-id"
  | "editable-limit";

/** Only policy and provider file locations enter the loader. */
export interface PolicyConfiguration {
  readonly messagePolicyFile?: string;
  readonly decisionProviderKeyFile?: Redacted.Redacted;
}

/** Policy loading fails with a closed reason and a safe operator message. */
export class MessagePolicyConfigurationError extends Data.TaggedError(
  "MessagePolicyConfigurationError",
)<{
  readonly reason: MessagePolicyConfigurationFailure;
  readonly message: string;
  readonly behaviorReason?: BehaviorFailure;
}> {}

/** The daemon supplies secret-file access without granting policy loading bootstrap authority. */
export type CredentialReader = (
  path: Redacted.Redacted,
  grammar: Schema.Schema<string>,
) => Effect.Effect<Redacted.Redacted, { readonly stage: "file" | "value" }>;

const POLICY_SPEC =
  "https://docs.moltzap.xyz/reference/spec/firewall/message-policy";

/** The message-firewall guide, whose troubleshooting entries policy failures link. */
export const FIREWALL_GUIDE =
  "https://docs.moltzap.xyz/guides/message-firewall";

/** Each failure's operator text and the troubleshooting entry that matches it. */
const failureMessages: Readonly<
  Record<
    MessagePolicyConfigurationFailure,
    { readonly text: string; readonly docs: string }
  >
> = {
  "message-policy-file": {
    text: "SHARNESS_MESSAGE_POLICY_FILE must name a readable regular file of at most 1 MiB",
    docs: `${FIREWALL_GUIDE}#message-policy-file`,
  },
  "message-policy": {
    text: "SHARNESS_MESSAGE_POLICY_FILE must contain a valid org.social-harness/message-policy/v2 document",
    docs: `${FIREWALL_GUIDE}#message-policy-document`,
  },
  "message-policy-composed": {
    text: "SHARNESS_MESSAGE_POLICY_FILE cannot be set for a daemon whose composition installs its own firewall",
    docs: `${FIREWALL_GUIDE}#message-policy-composed`,
  },
  "decision-provider-key-file": {
    text: "SHARNESS_DECISION_PROVIDER_KEY_FILE must name a readable file for the message policy's jev decision provider",
    docs: `${FIREWALL_GUIDE}#decision-provider-key-file`,
  },
  "decision-provider-key": {
    text: "SHARNESS_DECISION_PROVIDER_KEY_FILE must contain one key without inner whitespace",
    docs: `${FIREWALL_GUIDE}#decision-provider-key`,
  },
};

/**
 * The configuration failure for a message-policy setting, with its fixed
 * operator message.
 * @param reason Why the setting cannot start the daemon.
 * @param path The indexed behavior entry, if one fails.
 * @param behaviorReason The closed behavior failure category.
 * @returns The failure, naming no configured value.
 */
export function policyConfigurationError(
  reason: MessagePolicyConfigurationFailure,
  path = "",
  behaviorReason?: BehaviorFailure,
): MessagePolicyConfigurationError {
  const category = behaviorReason === undefined ? "" : ` (${behaviorReason})`;
  return new MessagePolicyConfigurationError({
    reason,
    behaviorReason,
    message: policyFailureMessage(
      reason,
      path === "" ? "" : `; invalid at ${path}${category}`,
      { path },
    ),
  });
}

/**
 * The operator message for a message-policy failure: its text, any detail,
 * and one `Docs:` link. An entry under a behavior list links the behavior
 * rules, `docs` replaces the failure's own troubleshooting entry, and an
 * empty `docs` leaves the link out for a failure with no fix to point at.
 * @param reason The closed failure.
 * @param detail Text after the failure's own, starting with `; `.
 * @param link The entry to link in place of the failure's own.
 * @param link.path The failing policy entry, which links the behavior rules
 *     when it names a behavior list.
 * @param link.docs Another entry to link, or empty for none.
 * @returns The message, naming no configured value.
 */
export function policyFailureMessage(
  reason: MessagePolicyConfigurationFailure,
  detail: string,
  link: { readonly path?: string; readonly docs?: string } = {},
): string {
  const docs = failureDocs(reason, link);
  return docs === ""
    ? `${failureMessages[reason].text}${detail}`
    : `${failureMessages[reason].text}${detail}. Docs: ${docs}`;
}

function failureDocs(
  reason: MessagePolicyConfigurationFailure,
  link: { readonly path?: string; readonly docs?: string },
): string {
  const path = link.path ?? "";
  if (path.startsWith("text.builtinBehaviors.")) {
    return `${POLICY_SPEC}#built-in-behaviors`;
  }
  if (/^text\.(?:fixed|initial)Behaviors\./u.test(path)) {
    return `${POLICY_SPEC}#behaviors`;
  }
  return link.docs ?? failureMessages[reason].docs;
}
