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
