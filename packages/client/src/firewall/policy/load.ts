/** @file Reads the message-policy document and decision-provider key a daemon's environment names. */

import {
  Effect,
  Option,
  ParseResult,
  type Redacted,
  Schedule,
  Schema,
} from "effect";
// eslint-disable-next-line agent-code-guard/prefer-effect-platform -- Configuration reads the configured policy file before the daemon composes its platform services.
import { lstat, readFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import {
  type DecisionProvider,
  DecisionProviderError,
  makeJevDecisionProvider,
} from "../evaluator/index.js";
import {
  type CredentialReader,
  MessagePolicyConfigurationError,
  type MessagePolicyConfigurationFailure,
  type PolicyConfiguration,
} from "./configuration.js";
import { decodeMessagePolicy, type MessagePolicy } from "./document/index.js";

/** Larger than any document of 256 editable rules and the fixed rules beside them. */
const MAXIMUM_POLICY_BYTES = 1_048_576;

/** A key is one token; surrounding whitespace, such as a trailing newline, is ignored. */
const decisionProviderKey = Schema.Trim.pipe(
  Schema.compose(
    Schema.String.pipe(
      Schema.minLength(1),
      Schema.maxLength(16_384),
      Schema.pattern(/^\S+$/u),
    ),
  ),
);

/** Every English check this provider is asked for is unavailable. */
const unavailableProvider: DecisionProvider = {
  decide: () =>
    Effect.fail(new DecisionProviderError({ reason: "configuration" })),
};

const failureMessages: Readonly<
  Record<MessagePolicyConfigurationFailure, string>
> = {
  "message-policy-file":
    "SHARNESS_MESSAGE_POLICY_FILE must name a readable file of at most 1 MiB",
  "message-policy":
    "SHARNESS_MESSAGE_POLICY_FILE must contain a valid org.social-harness/message-policy/v1 document",
  "message-policy-required":
    "SHARNESS_FIREWALL_AUDIT_EXPORT requires SHARNESS_MESSAGE_POLICY_FILE",
  "firewall-audit-export":
    "SHARNESS_FIREWALL_AUDIT_EXPORT must be an absolute path in an existing directory owned by the daemon's user with no group or other access",
  "message-policy-composed":
    "SHARNESS_MESSAGE_POLICY_FILE cannot be set for a daemon whose composition installs its own firewall",
  "decision-provider-key-file":
    "SHARNESS_DECISION_PROVIDER_KEY_FILE must name a readable file for the message policy's jev decision provider",
  "decision-provider-key":
    "SHARNESS_DECISION_PROVIDER_KEY_FILE must contain one key without inner whitespace",
};

/** A configured document with the decision provider it names, and where its audit goes. */
export interface LoadedMessagePolicy {
  readonly policy: MessagePolicy;
  readonly provider: DecisionProvider;
  readonly auditExport?: string;
}

/**
 * The document `SHARNESS_MESSAGE_POLICY_FILE` names, or none when it is
 * unset. A `jev` decision provider reads its key from
 * `SHARNESS_DECISION_PROVIDER_KEY_FILE` and retries transient failures; the
 * key file is not read for any other provider. An audit export without a
 * policy or outside a private directory of the daemon's user, an unreadable
 * or invalid document, and a missing or invalid key fail configuration naming
 * no file content.
 * @param configuration The policy and provider file locations.
 * @param readCredential The daemon-owned secret-file reader.
 * @returns The document, its decision provider and its audit export path.
 */
export const loadMessagePolicy = (
  configuration: PolicyConfiguration,
  readCredential: CredentialReader,
): Effect.Effect<
  Option.Option<LoadedMessagePolicy>,
  MessagePolicyConfigurationError
> =>
  Effect.gen(function* () {
    const path = configuration.messagePolicyFile;
    if (path === undefined) {
      return configuration.firewallAuditExport === undefined
        ? Option.none()
        : yield* policyConfigurationError("message-policy-required");
    }
    const policy = yield* readPolicyText(path).pipe(
      Effect.flatMap((text) =>
        decodeMessagePolicy(text).pipe(Effect.mapError(invalidPolicy)),
      ),
    );
    const auditExport = configuration.firewallAuditExport;
    if (auditExport !== undefined) {
      yield* requirePrivateParent(auditExport);
    }
    return Option.some({
      policy,
      provider: yield* decisionProvider(policy, configuration, readCredential),
      auditExport,
    });
  }).pipe(Effect.withSpan("loadMessagePolicy"));

/**
 * The configuration failure for a message-policy setting, with its fixed
 * operator message.
 * @param reason Why the setting cannot start the daemon.
 * @returns The failure, naming no configured value.
 */
export function policyConfigurationError(
  reason: MessagePolicyConfigurationFailure,
): MessagePolicyConfigurationError {
  return new MessagePolicyConfigurationError({
    reason,
    message: failureMessages[reason],
  });
}

/** The audit export's directory exists, belongs to the daemon's user and admits no one else. */
function requirePrivateParent(path: string) {
  const refused = () => policyConfigurationError("firewall-audit-export");
  if (!isAbsolute(path)) {
    return Effect.fail(refused());
  }
  return Effect.tryPromise({
    try: () => lstat(dirname(path)),
    catch: refused,
  }).pipe(
    Effect.filterOrFail(
      (parent) =>
        parent.isDirectory() &&
        parent.uid === process.getuid?.() &&
        (parent.mode & 0o077) === 0,
      refused,
    ),
    Effect.asVoid,
  );
}

function readPolicyText(path: string) {
  return Effect.tryPromise({
    try: () => readFile(path),
    catch: () => policyConfigurationError("message-policy-file"),
  }).pipe(
    Effect.filterOrFail(
      (bytes) => bytes.byteLength <= MAXIMUM_POLICY_BYTES,
      () => policyConfigurationError("message-policy-file"),
    ),
    Effect.map((bytes) => bytes.toString("utf8")),
  );
}

/** Names where the document is invalid, never what it holds there. */
function invalidPolicy(
  error: ParseResult.ParseError,
): MessagePolicyConfigurationError {
  const paths = [
    ...new Set(
      ParseResult.ArrayFormatter.formatErrorSync(error).map((issue) =>
        issue.path.length === 0 ? "(document)" : issue.path.join("."),
      ),
    ),
  ];
  return new MessagePolicyConfigurationError({
    reason: "message-policy",
    message: `${failureMessages["message-policy"]}; invalid at ${paths.join(", ")}`,
  });
}

function decisionProvider(
  policy: MessagePolicy,
  configuration: PolicyConfiguration,
  readCredential: CredentialReader,
): Effect.Effect<DecisionProvider, MessagePolicyConfigurationError> {
  const setting = policy.decisionProvider;
  switch (setting?.kind) {
    case undefined:
      return Effect.succeed(unavailableProvider);
    case "unavailable":
      return Effect.logWarning(
        "The message policy names no decision provider service; every English check is unavailable, which holds the message in enforcement mode and admits it in guidance mode.",
      ).pipe(Effect.as(unavailableProvider));
    case "jev":
      return jevKey(configuration, readCredential).pipe(
        Effect.map((apiKey) =>
          retryingTransientFailures(
            makeJevDecisionProvider({ apiKey, model: setting.model }),
          ),
        ),
      );
    default:
      return setting satisfies never;
  }
}

function jevKey(
  configuration: PolicyConfiguration,
  readCredential: CredentialReader,
): Effect.Effect<Redacted.Redacted, MessagePolicyConfigurationError> {
  const path = configuration.decisionProviderKeyFile;
  return path === undefined
    ? Effect.fail(policyConfigurationError("decision-provider-key-file"))
    : readCredential(path, decisionProviderKey).pipe(
        Effect.mapError((error) =>
          policyConfigurationError(
            error.stage === "file"
              ? "decision-provider-key-file"
              : "decision-provider-key",
          ),
        ),
      );
}

/**
 * The provider with up to two more attempts, a quarter second and then half
 * a second apart, after a transient failure: an unreachable service, a rate
 * limit or a server error. Each English stage's timeout still bounds the
 * attempts together, so a service that stays down leaves the check
 * unavailable; a refusal such as an invalid key is not retried.
 */
function retryingTransientFailures(
  provider: DecisionProvider,
): DecisionProvider {
  return {
    ...(provider.provenance === undefined
      ? {}
      : { provenance: provider.provenance }),
    decide: (request) =>
      Effect.suspend(() => provider.decide(request)).pipe(
        Effect.retry({
          times: 2,
          schedule: Schedule.exponential("250 millis"),
          while: isTransient,
        }),
      ),
  };
}

function isTransient(error: DecisionProviderError): boolean {
  const status = error.status ?? 0;
  return (
    error.reason === "transport" ||
    (error.reason === "http" && (status === 429 || status >= 500))
  );
}
