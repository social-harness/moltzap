/** @file Reads the message-policy document and decision-provider key a daemon's environment names, and the behaviors Client ships. */

import {
  Effect,
  Option,
  ParseResult,
  type Redacted,
  Schedule,
  Schema,
} from "effect";
import { createHash } from "node:crypto";
// eslint-disable-next-line agent-code-guard/prefer-effect-platform -- Nonblocking descriptor opens let fstat reject special files without waiting for a writer.
import { constants } from "node:fs";
// eslint-disable-next-line agent-code-guard/prefer-effect-platform -- Configuration reads the configured policy file before the daemon composes its platform services.
import { type FileHandle, lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type DecisionProvider,
  DecisionProviderError,
  editableDocumentSchema,
  type EnglishRule,
  makeJevDecisionProvider,
} from "../evaluator/index.js";
import {
  type BehaviorFailure,
  type CredentialReader,
  MessagePolicyConfigurationError,
  type MessagePolicyConfigurationFailure,
  type PolicyConfiguration,
} from "./configuration.js";
import {
  decodeBehavior,
  decodeMessagePolicy,
  MAXIMUM_BEHAVIOR_BYTES,
  type MessagePolicy,
} from "./document/index.js";

/** Larger than any document of 256 editable rules and the fixed rules beside them. */
const MAXIMUM_POLICY_BYTES = 1_048_576;

/** The installed Client's own `behaviors/` directory, which `english.builtinBehaviors` names into. */
const BUILTIN_BEHAVIORS = fileURLToPath(
  new URL("../../../behaviors/", import.meta.url),
);

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

const POLICY_SPEC = "https://docs.moltzap.xyz/spec/harness/message-policy";

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
    text: "SHARNESS_MESSAGE_POLICY_FILE must contain a valid org.social-harness/message-policy/v1 document",
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

/** A configured document with the decision provider it names, and its behavior sources. */
export interface LoadedMessagePolicy {
  readonly policy: MessagePolicy;
  readonly fixedBehaviorDigests?: readonly string[];
  readonly provider: DecisionProvider;
  readonly behaviorRulePaths: ReadonlyMap<string, string>;
}

/**
 * The document `SHARNESS_MESSAGE_POLICY_FILE` names, or none when it is
 * unset. A `jev` decision provider reads its key from
 * `SHARNESS_DECISION_PROVIDER_KEY_FILE` and retries transient failures; the
 * key file is not read for any other provider. An unreadable or invalid
 * document and a missing or invalid key fail configuration naming no file content.
 * @param configuration The policy and provider file locations.
 * @param readCredential The daemon-owned secret-file reader.
 * @returns The document, its decision provider and resolved behavior sources.
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
      return Option.none();
    }
    const policy = yield* readPolicyText(path).pipe(
      Effect.flatMap((text) =>
        decodeMessagePolicy(text).pipe(Effect.mapError(invalidPolicy)),
      ),
    );
    const resolved = yield* resolveBehaviors(policy, dirname(path));
    return Option.some({
      policy: resolved.policy,
      fixedBehaviorDigests: resolved.fixedBehaviorDigests,
      behaviorRulePaths: resolved.behaviorRulePaths,
      provider: yield* decisionProvider(policy, configuration, readCredential),
    });
  }).pipe(Effect.withSpan("loadMessagePolicy"));

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

/**
 * A behavior Client ships, read by its pack and name, such as
 * `collectives/one-gather`, from the installed package's `behaviors/`. The
 * file is part of the installed package, so one that cannot be read is a
 * broken installation, a defect whose message says to reinstall.
 * @param name The behavior's pack and name.
 * @returns Its English rule.
 */
export function readBuiltinBehavior(name: string): Effect.Effect<EnglishRule> {
  return readBehavior(BUILTIN_BEHAVIORS, name, name).pipe(
    Effect.map(({ rule }) => rule),
    Effect.catchAll(() =>
      Effect.dieMessage(
        `Client's shipped behavior ${name} could not be read; reinstall @moltzap/social-harness. Docs: ${POLICY_SPEC}#built-in-behaviors`,
      ),
    ),
    Effect.withSpan("readBuiltinBehavior"),
  );
}

/** Reports only the policy entry; YAML diagnostics may contain private file content. */
function invalidBehavior(path: string, reason: BehaviorFailure) {
  return policyConfigurationError("message-policy", path, reason);
}

function readBehavior(root: string, directory: string, path: string) {
  const refused = (reason: BehaviorFailure) => invalidBehavior(path, reason);
  if (
    isAbsolute(directory) ||
    win32.isAbsolute(directory) ||
    directory.split(/[\\/]/u).includes("..")
  ) {
    return Effect.fail(refused("schema"));
  }
  return Effect.gen(function* () {
    const canonical = (location: string) =>
      Effect.tryPromise({
        try: () => realpath(location),
        catch: () => refused("missing"),
      });
    const locations = yield* Effect.all({
      root: canonical(root),
      directory: canonical(resolve(root, directory)),
      file: canonical(resolve(root, directory, "BEHAVIOR.md")),
    });
    if (
      !contained(locations.root, locations.directory) ||
      !contained(locations.root, locations.file)
    ) {
      return yield* refused("schema");
    }
    const bytes = yield* readBoundedFile(
      locations.file,
      MAXIMUM_BEHAVIOR_BYTES,
      refused,
    );
    const rule = yield* decodeBehavior(bytes, refused);
    return { rule, digest: createHash("sha256").update(bytes).digest("hex") };
  });
}

/** Initial behaviors are validated even when persisted editable rules already exist. */
function resolveBehaviors(policy: MessagePolicy, root: string) {
  return Effect.gen(function* () {
    const behaviorRulePaths = new Map<string, string>();
    const english = policy.english;
    if (english === undefined) {
      return { policy, behaviorRulePaths, fixedBehaviorDigests: undefined };
    }
    yield* Schema.decodeUnknown(editableDocumentSchema)(
      english.initialRules,
    ).pipe(
      Effect.mapError(() =>
        policyConfigurationError("message-policy", "english.initialRules"),
      ),
    );
    const state = {
      root,
      ids: new Set(
        [...english.fixedRules, ...english.initialRules].map((rule) => rule.id),
      ),
      behaviorRulePaths,
      initialRuleCount: english.initialRules.length,
    };
    const fixed = yield* loadFixedBehaviors(english, state);
    const initial = yield* loadBehaviors(
      english.initialBehaviors ?? [],
      "initialBehaviors",
      state,
    );
    const resolved: MessagePolicy = {
      ...policy,
      english: {
        fixedRules: [...english.fixedRules, ...fixed.map(({ rule }) => rule)],
        initialRules: [
          ...english.initialRules,
          ...initial.map(({ rule }) => rule),
        ],
      },
    };
    return {
      policy: resolved,
      behaviorRulePaths,
      fixedBehaviorDigests:
        fixed.length === 0 ? undefined : fixed.map(({ digest }) => digest),
    };
  });
}

/** Fixed behaviors from the policy's directory, then built-in behaviors from Client's own. */
function loadFixedBehaviors(
  english: NonNullable<MessagePolicy["english"]>,
  state: BehaviorState,
) {
  return Effect.all([
    loadBehaviors(english.fixedBehaviors ?? [], "fixedBehaviors", state),
    loadBehaviors(english.builtinBehaviors ?? [], "builtinBehaviors", {
      ...state,
      root: BUILTIN_BEHAVIORS,
    }),
  ]).pipe(Effect.map((loaded) => loaded.flat()));
}

interface BehaviorState {
  readonly root: string;
  readonly ids: Set<string>;
  readonly behaviorRulePaths: Map<string, string>;
  readonly initialRuleCount: number;
}

function loadBehaviors(
  directories: readonly string[],
  field: "fixedBehaviors" | "builtinBehaviors" | "initialBehaviors",
  state: BehaviorState,
) {
  let count = state.initialRuleCount;
  return Effect.forEach(
    directories,
    (directory, index) =>
      Effect.gen(function* () {
        const path = `english.${field}.${index}`;
        const behavior = yield* readBehavior(state.root, directory, path);
        if (state.ids.has(behavior.rule.id)) {
          return yield* invalidBehavior(path, "duplicate-id");
        }
        if (field === "initialBehaviors") {
          count += 1;
          if (count > 256) {
            return yield* invalidBehavior(path, "editable-limit");
          }
        }
        state.ids.add(behavior.rule.id);
        state.behaviorRulePaths.set(behavior.rule.id, path);
        return behavior;
      }),
    { concurrency: 1 },
  );
}

/** Relative paths must stay in the canonical root, the policy directory or Client's `behaviors/`, after symlink resolution. */
function contained(root: string, path: string) {
  const child = relative(root, path);
  return !isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`);
}

function readPolicyText(path: string) {
  return Effect.tryPromise({
    try: () => realpath(path),
    catch: () => policyConfigurationError("message-policy-file"),
  }).pipe(
    Effect.flatMap((canonical) =>
      readBoundedFile(canonical, MAXIMUM_POLICY_BYTES, () =>
        policyConfigurationError("message-policy-file"),
      ),
    ),
    Effect.map((bytes) => bytes.toString("utf8")),
  );
}

/** The descriptor owns both the file-kind check and the bounded read. */
function readBoundedFile(
  path: string,
  maximumBytes: number,
  refused: (reason: BehaviorFailure) => MessagePolicyConfigurationError,
) {
  return Effect.gen(function* () {
    const before = yield* Effect.tryPromise({
      try: () => lstat(path),
      catch: () => refused("missing"),
    });
    const file = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () =>
          open(
            path,
            constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
          ),
        catch: () => refused("missing"),
      }),
      (file) =>
        Effect.tryPromise({
          try: () => file.close(),
          catch: () => refused("missing"),
        }).pipe(Effect.orDie),
    );
    const stat = yield* Effect.tryPromise({
      try: () => file.stat(),
      catch: () => refused("missing"),
    });
    if (!stat.isFile()) {
      return yield* refused("not-a-file");
    }
    if (stat.dev !== before.dev || stat.ino !== before.ino) {
      return yield* refused("missing");
    }
    const bytes = yield* readDescriptor(file, maximumBytes).pipe(
      Effect.mapError(() => refused("missing")),
    );
    if (bytes.byteLength > maximumBytes) {
      return yield* refused("too-large");
    }
    return bytes;
  }).pipe(Effect.scoped);
}

/** A short read need not be EOF; stop only at EOF or the extra byte. */
function readDescriptor(file: FileHandle, maximumBytes: number) {
  return Effect.gen(function* () {
    const buffer = Buffer.alloc(maximumBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const offset = length;
      const read = yield* Effect.tryPromise(() =>
        file.read(buffer, offset, buffer.length - offset, null),
      );
      if (read.bytesRead === 0) {
        break;
      }
      length += read.bytesRead;
    }
    return buffer.subarray(0, length);
  });
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
    message: policyFailureMessage(
      "message-policy",
      `; invalid at ${paths.join(", ")}`,
    ),
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

function failureDocs(
  reason: MessagePolicyConfigurationFailure,
  link: { readonly path?: string; readonly docs?: string },
): string {
  const path = link.path ?? "";
  if (path.startsWith("english.builtinBehaviors.")) {
    return `${POLICY_SPEC}#built-in-behaviors`;
  }
  if (/^english\.(?:fixed|initial)Behaviors\./u.test(path)) {
    return `${POLICY_SPEC}#behaviors`;
  }
  return link.docs ?? failureMessages[reason].docs;
}
