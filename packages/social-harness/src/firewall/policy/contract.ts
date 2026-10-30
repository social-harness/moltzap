/** @file Owner and runtime policy editing, ownership and decision history contracts. */

import { Data, type Effect, Schema } from "effect";
import { exactStruct } from "../../encoding/exact.js";
import { AgentView } from "../../identity/cards.js";
import {
  FirewallSettings,
  MessageContext,
  PrivateCheckTrace,
  RuleDescription,
  TextRule,
} from "../evaluator/contract/index.js";

const editableRuleSchema = exactStruct(TextRule.fields);

const policyAuthority = Schema.Literal("owner", "runtime");

/** The daemon derives edit authority from its authenticated local caller. */
export type PolicyAuthority = typeof policyAuthority.Type;

/** Ownership is assigned after authenticating the local caller. */
const ownedRuleSchema = exactStruct({
  ...TextRule.fields,
  owner: policyAuthority,
});

/** The most editable natural-language rules one daemon holds, across seeding, persistence and updates. */
export const MAXIMUM_EDITABLE_RULES = 256;

/** The complete editable document. */
export const editableDocumentSchema = Schema.Array(editableRuleSchema).pipe(
  Schema.maxItems(MAXIMUM_EDITABLE_RULES),
);

/**
 * A shared norm's `BEHAVIOR.md` exactly as proposed, mapped to its rule as a
 * policy file's behaviors are: docs/reference/spec/firewall/message-policy.md#behaviors.
 */
const behaviorAddition = exactStruct({ behavior: Schema.String });

/** Removing and adding the same editable id replaces it in one activation. */
export const policyUpdateSchema = exactStruct({
  add: Schema.optional(
    Schema.Array(Schema.Union(editableRuleSchema, behaviorAddition)).pipe(
      Schema.maxItems(MAXIMUM_EDITABLE_RULES),
    ),
  ),
  remove: Schema.optional(
    Schema.Array(TextRule.fields.id).pipe(
      Schema.maxItems(MAXIMUM_EDITABLE_RULES),
    ),
  ),
});

/**
 * A fixed rule as trusted composition installed it: natural-language text, or the
 * description a code middleware declares for a rule it checks in code.
 */
const fixedRuleSchema = Schema.Union(
  exactStruct({
    from: Schema.Literal("code"),
    middleware: Schema.NonEmptyString,
    ...RuleDescription.fields,
  }),
  exactStruct({
    from: Schema.Literal("text"),
    ...TextRule.fields,
  }),
);

/** The digest identifies the entire active installation, including fixed policy. */
export const policyReadSchema = exactStruct({
  rules: Schema.Array(ownedRuleSchema),
  fixedRules: Schema.Array(fixedRuleSchema),
  activeRevision: Schema.NonEmptyString,
});

/** Activation acknowledges future checks only; retained dispositions are unchanged. */
export const policyUpdateResultSchema = exactStruct({
  activeRevision: Schema.NonEmptyString,
});

/** Inclusive Unix milliseconds permit polling across checks completed out of start order. */
export const firewallDecisionsRequestSchema = exactStruct({
  since: Schema.optional(Schema.NonNegativeInt),
});

/** Activation metadata contains rule ids only, never their text or templates. */
const firewallActivationSchema = exactStruct({
  time: Schema.NonNegativeInt,
  activeRevision: Schema.NonEmptyString,
  addedRuleIds: Schema.Array(Schema.NonEmptyString),
  removedRuleIds: Schema.Array(Schema.NonEmptyString),
});

/**
 * How a decision's outcome came about. `judgment` is a settled natural-language
 * judgment and `uncertain` an unsettled one, admitted or held with guidance.
 * `unavailable` is a check that could not run: the decision provider failed
 * or was unreachable, or a middleware failed or timed out. `code` is a code
 * middleware's finding. `endpoint` is a hold Client makes itself without a
 * deciding rule, and `default` an admission no rule qualified.
 */
const decisionCause = Schema.Literal(
  "judgment",
  "uncertain",
  "unavailable",
  "code",
  "endpoint",
  "default",
);

/**
 * One row per peer contains no message content or provider traces. The only
 * text is `decidedBy[].advice`, the deciding rule's own registered feedback,
 * or its guidance for an admission. `decidedBy[].from` says where the rule is
 * defined, as `policy_read` lists it: a code middleware, a fixed natural-language rule,
 * or an owner-editable natural-language rule. `checkedRuleIds` lists every rule with a
 * finding in the completed chain.
 */
export const firewallDecisionsSchema = exactStruct({
  activations: Schema.Array(firewallActivationSchema),
  decisions: Schema.Array(
    exactStruct({
      checkId: Schema.NonEmptyString,
      time: Schema.NonNegativeInt,
      direction: Schema.Literal("incoming", "outgoing"),
      peer: Schema.NullOr(AgentView),
      outcome: Schema.Literal("allow", "reject", "hold"),
      disposition: Schema.Literal("stale", "admitted", "withheld"),
      cause: decisionCause,
      decidedBy: Schema.Array(
        exactStruct({
          ruleId: Schema.NonEmptyString,
          from: Schema.Literal("code", "fixed", "editable"),
          owner: Schema.optional(policyAuthority),
          advice: Schema.optional(Schema.NonEmptyString),
        }),
      ),
      checkedRuleIds: Schema.Array(Schema.NonEmptyString),
      activeRevision: Schema.NonEmptyString,
    }),
  ),
});

/**
 * What made an edit's rule invalid. A `BEHAVIOR.md` addition fails as
 * `frontmatter`, `schema` or `too-large`; an edit as
 * `duplicate-id`, `unknown-id` or `editable-limit`.
 * @inline
 */
export type PolicyProblem =
  | "duplicate-id"
  | "unknown-id"
  | "editable-limit"
  | "frontmatter"
  | "schema"
  | "too-large";

const policyProblemText: Readonly<Record<PolicyProblem, string>> = {
  "duplicate-id":
    "its id is already in the policy; remove that rule in the same update to replace it, or use another id",
  "unknown-id":
    "no editable rule has this id; policy_read lists the editable rules",
  "editable-limit": `the update would leave more than ${String(MAXIMUM_EDITABLE_RULES)} editable rules; remove some rules first`,
  frontmatter:
    "the BEHAVIOR.md needs valid YAML frontmatter between --- lines (no code fence or other text before it)",
  schema:
    "it does not map to an editable rule: a BEHAVIOR.md needs name, description and metadata.social-harness.applies; allowed policy metadata is applies, guidance, feedback and notifySender",
  "too-large": "the BEHAVIOR.md is over 64 KiB",
};

const policyReasonText: Readonly<
  Record<FirewallPolicyError["reason"], string>
> = {
  "not-configured": "the message policy has no text block",
  "invalid-rule": "the update is invalid",
  "fixed-rule":
    "it is a fixed rule of the owner's policy, which policy_update cannot add, remove or replace",
  "owner-rule":
    "it belongs to the owner; runtime policy_update can change only rules the runtime adopted",
  "build-failed": "the new rules could not be installed",
  "persistence-failed": "the rules could not be stored",
};

const editRefusalDocs =
  "Docs: https://docs.moltzap.xyz/reference/spec/firewall/message-policy#editable-text-policy";

/**
 * A failed edit never replaces the active installation or retained editable
 * document. `ruleId` and `path` name the failing rule when the edit had one:
 * `path` is its place in the update, such as `["add", 0]`. `problem` says why
 * an `invalid-rule` edit failed. The message names all three, and never the
 * text of a rejected `BEHAVIOR.md`.
 */
export class FirewallPolicyError extends Data.TaggedError(
  "FirewallPolicyError",
)<{
  readonly ruleId?: string;
  readonly problem?: PolicyProblem;
  readonly path?: readonly [field: "add" | "remove", index: number];
  readonly reason:
    | "not-configured"
    | "invalid-rule"
    | "fixed-rule"
    | "owner-rule"
    | "build-failed"
    | "persistence-failed";
}> {
  override get message(): string {
    const subject = editSubject(this.path, this.ruleId);
    const cause =
      this.problem === undefined
        ? policyReasonText[this.reason]
        : policyProblemText[this.problem];
    const text = subject === undefined ? cause : `${subject}: ${cause}`;
    return [
      "invalid-rule",
      "fixed-rule",
      "owner-rule",
      "build-failed",
    ].includes(this.reason)
      ? `${text}. ${editRefusalDocs}`
      : text;
  }

  /**
   * The fields a refusal's error data carries beside its reason.
   * @returns `ruleId`, `path` and `problem`, each when the refusal has it.
   */
  get data(): Readonly<{
    ruleId?: string;
    path?: readonly [field: "add" | "remove", index: number];
    problem?: PolicyProblem;
  }> {
    return {
      ...(this.ruleId === undefined ? {} : { ruleId: this.ruleId }),
      ...(this.path === undefined ? {} : { path: this.path }),
      ...(this.problem === undefined ? {} : { problem: this.problem }),
    };
  }
}

/**
 * The failing rule as a refusal names it: its place in the update, then its id.
 * @param path The rule's place in the update, when the refusal has one.
 * @param ruleId The rule's id, when the refusal has one.
 * @returns The subject, or undefined when the refusal names neither.
 */
function editSubject(
  path?: FirewallPolicyError["path"],
  ruleId?: string,
): string | undefined {
  const place = path === undefined ? undefined : `${path[0]}[${path[1]}]`;
  const rule = ruleId === undefined ? undefined : `rule ${ruleId}`;
  return place !== undefined && rule !== undefined
    ? `${place} (${rule})`
    : (place ?? rule);
}

/** The authenticated authority limits edits without delegating owner read access. */
export interface FirewallPolicyOperations {
  readonly read: () => Effect.Effect<
    typeof policyReadSchema.Type,
    FirewallPolicyError
  >;
  readonly update: (
    request: typeof policyUpdateSchema.Type,
    authority: PolicyAuthority,
  ) => Effect.Effect<typeof policyUpdateResultSchema.Type, FirewallPolicyError>;
  readonly decisions: (
    request: typeof firewallDecisionsRequestSchema.Type,
  ) => Effect.Effect<typeof firewallDecisionsSchema.Type, FirewallPolicyError>;
}

/** Operational evidence limits are part of the installed policy identity. */
// eslint-disable-next-line agent-code-guard/no-exported-brand-constructor -- Installation validates fixed settings with the same grammar retained audits decode.
export const firewallConfigurationSchema = Schema.Struct({
  mode: Schema.Literal("guidance", "enforcement"),
  facts: MessageContext.fields.facts,
  codeDigest: Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/u)),
  maximumHistoryRecords: Schema.Int.pipe(Schema.between(1, 1024)),
  maximumConcurrentChecks: Schema.Int.pipe(Schema.between(1, 32)),
});

/** Registration provenance is retained without giving it execution authority. */
const firewallRegistrationSchema = Schema.Struct({
  id: Schema.NonEmptyTrimmedString,
  revision: Schema.NonEmptyTrimmedString,
  rules: Schema.Array(RuleDescription),
  provenance: PrivateCheckTrace,
});

/** The exact installation used by an attempt survives later process configuration. */
// eslint-disable-next-line agent-code-guard/no-exported-brand-constructor -- Retained audit decoding composes the exact installation grammar owned by policy.
export const firewallInstallationSchema = Schema.Struct({
  configuration: firewallConfigurationSchema,
  settings: FirewallSettings,
  incoming: Schema.Array(firewallRegistrationSchema),
  outgoing: Schema.Array(firewallRegistrationSchema),
});

/** Evidence limits and fixed facts are immutable for a process installation. */
export type FirewallConfiguration = typeof firewallConfigurationSchema.Type;
/** Each retained check identifies the exact rule registrations it assessed. */
export type FirewallInstallation = typeof firewallInstallationSchema.Type;
