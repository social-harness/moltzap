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
  type CollectiveNorms,
  collectiveNorms,
  credentialsPolicy,
  openRequestsPolicy,
  plainLanguagePolicy,
} from "../rules/index.js";
import {
  type CredentialReader,
  MessagePolicyConfigurationError,
  type PolicyConfiguration,
} from "./configuration.js";
import { loadMessagePolicy, policyConfigurationError } from "./load.js";

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
 * The firewall installation of one message-policy document: its built-in
 * middleware in chain order, its English rules assessed by `provider`, and
 * its settings. This is the trusted-composition hook: a composition that
 * brings its own decision provider installs the result with
 * `Daemon.withFirewall`. `codeDigest` is the SHA-256 of the Client release,
 * the mode, each registration's id and revision, the fixed English rules
 * and behavior bytes, the decision provider and the settings. It leaves out
 * what differs between the agents of one arm: the facilitator role, which no revision holds, the
 * allowed-sender list and the initial editable rules, so every member
 * records the same digest.
 * Nonempty behavior paths fail with `CheckInputError` (`registration`); only
 * file loading resolves behavior paths.
 * @param policy A decoded document with inline rules and no behavior paths.
 * @param provider The service that assesses its English rules and the
 *     collective norms; unused when the document installs neither.
 * @returns The options `Daemon.withFirewall` installs.
 */
export const messagePolicyFirewall = Effect.fn("messagePolicyFirewall")(
  function* (policy: MessagePolicy, provider: DecisionProvider) {
    if (hasBehaviorPaths(policy)) {
      return yield* new CheckInputError({ reason: "registration" });
    }
    return yield* composeFirewall(policy, provider, []);
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
            ? composeFirewall(
                policy,
                provider,
                fixedBehaviorDigests ?? [],
              ).pipe(
                Effect.mapError(() =>
                  policyConfigurationError("message-policy"),
                ),
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
 * The configuration failure for a document whose rules the daemon could not
 * install against its store, such as an initial rule reusing a code rule's
 * id.
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
  const base = policyConfigurationError("message-policy");
  const location =
    path === undefined
      ? ""
      : `; invalid at ${path} (duplicate-id). Docs: https://github.com/social-harness/moltzap/blob/main/docs/spec/harness/message-policy.md#behaviors`;
  return new MessagePolicyConfigurationError({
    reason: "message-policy",
    behaviorReason: path === undefined ? undefined : "duplicate-id",
    message: `${base.message}; its rules could not be installed (${cause.reason})${location}`,
  });
}

/** Only file loading resolves paths into rules before trusted composition. */
function hasBehaviorPaths(policy: MessagePolicy) {
  return (
    (policy.english?.fixedBehaviors?.length ?? 0) !== 0 ||
    (policy.english?.initialBehaviors?.length ?? 0) !== 0
  );
}

/** File loading supplies byte digests after resolving behavior paths into rules. */
function composeFirewall(
  policy: MessagePolicy,
  provider: DecisionProvider,
  fixedBehaviorDigests: readonly string[],
): Effect.Effect<FirewallOptions, CheckInputError> {
  return Effect.gen(function* () {
    const bundle = yield* Effect.cached(
      collectiveNorms(
        provider,
        policy.englishSettings,
        policy.maximumHistoryRecords,
      ),
    );
    const incomingChain = yield* Effect.forEach(
      policy.incoming,
      (entry) => incoming(entry, bundle),
      { concurrency: 1 },
    );
    const outgoingChain = yield* Effect.forEach(
      policy.outgoing,
      (entry) => outgoing(entry, bundle),
      { concurrency: 1 },
    );
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
      english:
        policy.english === undefined
          ? undefined
          : {
              fixedRules: policy.english.fixedRules,
              initialRules: policy.english.initialRules,
              provider,
              settings: policy.englishSettings,
            },
    };
  });
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
        fixedRules: policy.english?.fixedRules ?? null,
        ...(fixedBehaviorDigests.length === 0 ? {} : { fixedBehaviorDigests }),
        decisionProvider: policy.decisionProvider ?? null,
        englishSettings: policy.englishSettings,
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
  const english = options.english === undefined ? "" : " and English rules";
  return Effect.logInfo(
    `Message policy installed in ${options.mode} mode with ${middleware}${english}.`,
  );
}

/** The bundle, built once for the first entry that names it. */
type Bundle = Effect.Effect<CollectiveNorms, CheckInputError>;

function incoming(
  entry: IncomingMiddlewareEntry,
  bundle: Bundle,
): Effect.Effect<MessageMiddleware, CheckInputError> {
  switch (entry.use) {
    case "acknowledgements":
      return Effect.succeed(acknowledgementsPolicy());
    case "allowed-senders":
      return Effect.succeed(allowedSendersPolicy(entry.agentIds));
    case "collective-norms":
      return Effect.map(bundle, (norms) => norms.incoming);
    default:
      return entry satisfies never;
  }
}

function outgoing(
  entry: OutgoingMiddlewareEntry,
  bundle: Bundle,
): Effect.Effect<MessageMiddleware, CheckInputError> {
  switch (entry.use) {
    case "credentials":
      return Effect.succeed(credentialsPolicy());
    case "plain-language":
      return Effect.succeed(plainLanguagePolicy(entry));
    case "collective-norms":
      return Effect.map(bundle, (norms) => norms.outgoing(entry.facilitator));
    case "open-requests":
      return Effect.succeed(openRequestsPolicy());
    case "acknowledgements":
      return Effect.succeed(acknowledgementsPolicy());
    default:
      return entry satisfies never;
  }
}
