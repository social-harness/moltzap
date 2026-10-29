/** @file Builds the daemon firewall a message-policy document describes. */

import { Effect, Option } from "effect";
import { createHash } from "node:crypto";
import type { FirewallOptions } from "../admission/index.js";
import type {
  IncomingMiddlewareEntry,
  MessagePolicy,
  OutgoingMiddlewareEntry,
} from "./document/index.js";
import { packageVersion } from "../../release/index.js";
import {
  CheckInputError,
  type DecisionProvider,
  type FirewallPolicyError,
  type MessageMiddleware,
} from "../evaluator/index.js";
import {
  acknowledgementsPolicy,
  ALLOWED_SENDERS_ID,
  allowedSendersPolicy,
  credentialsPolicy,
  openRequestsPolicy,
  plainLanguagePolicy,
} from "../rules/index.js";
import {
  type CredentialReader,
  MessagePolicyConfigurationError,
  type PolicyConfiguration,
} from "./configuration.js";
import {
  FIREWALL_GUIDE,
  loadMessagePolicy,
  policyConfigurationError,
  policyFailureMessage,
} from "./load.js";

/**
 * The firewall a daemon installs, if any.
 * `fromPolicyFile` marks one the environment's message-policy file
 * describes, so an installation failure names that setting.
 */
export interface FirewallInstallation {
  readonly options?: FirewallOptions;
  readonly fromPolicyFile?: boolean;
  readonly behaviorRulePaths?: ReadonlyMap<string, string>;
}

/**
 * Compose a decoded inline policy for `Daemon.withFirewall`, using the supplied
 * provider for natural-language rules. A code-only policy does not
 * use the provider.
 *
 * Nonempty behavior lists fail with `CheckInputError` (`registration`) because
 * only file loading resolves them. The generated code digest follows the
 * [policy contract](https://docs.moltzap.xyz/reference/spec/firewall/message-policy#message-policy-file).
 */
export const messagePolicyFirewall = Effect.fn("messagePolicyFirewall")(
  function* (policy: MessagePolicy, provider: DecisionProvider) {
    if (listsBehaviors(policy)) {
      return yield* new CheckInputError({ reason: "registration" });
    }
    return composeFirewall(policy, provider, []);
  },
);

/**
 * The firewall a composition installs, or else the one the environment's
 * message-policy file describes, which is logged with its registrations. A
 * composition with its own firewall refuses that file.
 * @param configuration The policy and provider file locations.
 * @param readCredential The daemon-owned secret-file reader.
 * @param composed The firewall the composition installs itself, if any.
 * @returns What the daemon installs; neither field is set without a firewall.
 */
export const firewallInstallation = (
  configuration: PolicyConfiguration,
  readCredential: CredentialReader,
  composed?: FirewallInstallation,
): Effect.Effect<FirewallInstallation, MessagePolicyConfigurationError> =>
  loadMessagePolicy(configuration, readCredential).pipe(
    Effect.flatMap((configured) =>
      Option.match(configured, {
        onNone: () => Effect.succeed(composed ?? {}),
        onSome: ({
          policy,
          provider,
          behaviorRulePaths,
          fixedBehaviorDigests,
        }) =>
          composed === undefined
            ? Effect.succeed(
                composeFirewall(policy, provider, fixedBehaviorDigests ?? []),
              ).pipe(
                Effect.tap((options) =>
                  validateBehaviorIds(options, behaviorRulePaths),
                ),
                Effect.tap(logInstalled),
                Effect.map((options) => ({
                  options,
                  fromPolicyFile: true,
                  behaviorRulePaths,
                })),
              )
            : Effect.fail(policyConfigurationError("message-policy-composed")),
      }),
    ),
  );

/**
 * Where a rule installation failure's fix is written: the rules-not-installed
 * entry for a rule the file or the store holds, and nowhere for a build or
 * storage failure, which has no operator fix to link.
 */
const installationDocs: Readonly<
  Record<Exclude<FirewallPolicyError["reason"], "not-configured">, string>
> = {
  "invalid-rule": `${FIREWALL_GUIDE}#rules-not-installed`,
  "fixed-rule": `${FIREWALL_GUIDE}#rules-not-installed`,
  "owner-rule": `${FIREWALL_GUIDE}#rules-not-installed`,
  "build-failed": "",
  "persistence-failed": "",
};

/**
 * The configuration failure for a document whose rules the daemon could not
 * install against its store, such as an initial rule reusing a code rule's
 * id. `not-configured` here means the store holds editable natural-language rules
 * that a document without `text` cannot install; the document itself is
 * valid, so that message names the stored rules instead.
 * @param cause The closed installation failure.
 * @param behaviorRulePaths The source entry for each file-loaded behavior.
 * @returns The failure naming `SHARNESS_MESSAGE_POLICY_FILE` and the reason.
 */
export function policyInstallationError(
  cause: FirewallPolicyError,
  behaviorRulePaths?: ReadonlyMap<string, string>,
): MessagePolicyConfigurationError {
  const path =
    cause.ruleId === undefined
      ? undefined
      : behaviorRulePaths?.get(cause.ruleId);
  const location =
    path === undefined ? "" : `; invalid at ${path} (duplicate-id)`;
  return new MessagePolicyConfigurationError({
    reason: "message-policy",
    behaviorReason: path === undefined ? undefined : "duplicate-id",
    message:
      cause.reason === "not-configured"
        ? `SHARNESS_MESSAGE_POLICY_FILE configures no natural-language policy, but the state directory holds natural-language rules an earlier policy added; restore the text block, remove those rules with policy_update, then remove the block. Docs: ${FIREWALL_GUIDE}#stored-text-rules`
        : policyFailureMessage(
            "message-policy",
            `; its rules could not be installed (${cause.reason})${location}`,
            { path: path ?? "", docs: installationDocs[cause.reason] },
          ),
  });
}

/** Only file loading resolves behaviors into rules before trusted composition. */
function listsBehaviors(policy: MessagePolicy) {
  const text = policy.text;
  if (text === undefined) {
    return false;
  }
  return [
    text.fixedBehaviors,
    text.builtinBehaviors,
    text.initialBehaviors,
  ].some((entries) => entries !== undefined && entries.length !== 0);
}

/** File loading supplies byte digests after resolving behaviors into rules. */
function composeFirewall(
  policy: MessagePolicy,
  provider: DecisionProvider,
  fixedBehaviorDigests: readonly string[],
): FirewallOptions {
  const incomingChain = policy.incoming.map(incoming);
  const outgoingChain = policy.outgoing.map(outgoing);
  return {
    mode: policy.mode,
    incoming: incomingChain,
    outgoing: outgoingChain,
    settings: policy.settings,
    facts: policy.facts,
    codeDigest: armDigest(
      policy,
      [...incomingChain, ...outgoingChain],
      fixedBehaviorDigests,
    ),
    maximumHistoryRecords: policy.maximumHistoryRecords,
    maximumConcurrentChecks: policy.maximumConcurrentChecks,
    text:
      policy.text === undefined
        ? undefined
        : {
            fixedRules: policy.text.fixedRules,
            initialRules: policy.text.initialRules,
            provider,
            settings: policy.textSettings,
          },
  };
}

function validateBehaviorIds(
  options: FirewallOptions,
  behaviorRulePaths: ReadonlyMap<string, string>,
) {
  const codeIds = new Set(
    [...options.incoming, ...options.outgoing].flatMap((middleware) =>
      middleware.rules.map((rule) => rule.id),
    ),
  );
  const collision = [...behaviorRulePaths].find(([id]) => codeIds.has(id));
  return collision === undefined
    ? Effect.void
    : Effect.fail(
        policyConfigurationError(
          "message-policy",
          collision[1],
          "duplicate-id",
        ),
      );
}

/** The digest every agent of one arm shares; see {@link messagePolicyFirewall}. */
function armDigest(
  policy: MessagePolicy,
  registrations: readonly MessageMiddleware[],
  fixedBehaviorDigests: readonly string[],
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        client: packageVersion,
        mode: policy.mode,
        registrations: registrations.map(({ id, revision }) =>
          id === ALLOWED_SENDERS_ID ? { id } : { id, revision },
        ),
        fixedRules: policy.text?.fixedRules ?? null,
        ...(fixedBehaviorDigests.length === 0 ? {} : { fixedBehaviorDigests }),
        decisionProvider: policy.decisionProvider ?? null,
        textSettings: policy.textSettings,
        settings: policy.settings,
        maximumHistoryRecords: policy.maximumHistoryRecords ?? null,
        maximumConcurrentChecks: policy.maximumConcurrentChecks ?? null,
      }),
    )
    .digest("hex");
}

function logInstalled(options: FirewallOptions) {
  const registrations = new Set(
    [...options.incoming, ...options.outgoing].map(
      (entry) => `${entry.id} at ${entry.revision}`,
    ),
  );
  const middleware =
    registrations.size === 0
      ? "no code middleware"
      : [...registrations].join(", ");
  const text = options.text === undefined ? "" : " and natural-language rules";
  return Effect.logInfo(
    `Message policy installed in ${options.mode} mode with ${middleware}${text}.`,
  );
}

function incoming(entry: IncomingMiddlewareEntry): MessageMiddleware {
  switch (entry.use) {
    case "acknowledgements":
      return acknowledgementsPolicy();
    case "allowed-senders":
      return allowedSendersPolicy(entry.agentIds);
    default:
      return entry satisfies never;
  }
}

function outgoing(entry: OutgoingMiddlewareEntry): MessageMiddleware {
  switch (entry.use) {
    case "credentials":
      return credentialsPolicy();
    case "plain-language":
      return plainLanguagePolicy(entry);
    case "open-requests":
      return openRequestsPolicy();
    case "acknowledgements":
      return acknowledgementsPolicy();
    default:
      return entry satisfies never;
  }
}
