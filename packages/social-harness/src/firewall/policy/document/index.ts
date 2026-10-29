/** @file The message-policy document `sharnessd` installs as its firewall, and the `BEHAVIOR.md` rules it and `policy_update` add. */

import { Effect, Schema, Struct } from "effect";
import { parseDocument } from "yaml";
import { exactStruct } from "../../../encoding/exact.js";
import { AgentId } from "../../../identity/agents.js";
import {
  EnglishPolicySettings,
  EnglishRule,
  FirewallSettings,
  MessageContext,
  policyReadSchema,
} from "../../evaluator/index.js";

/** The `format` every message-policy document names. */
const messagePolicyFormat = "org.social-harness/message-policy/v1";

/** A tool name as hosts register it: letters, digits and underscores. */
const toolName = Schema.String.pipe(Schema.pattern(/^\w+$/u));
const toolNames = Schema.optionalWith(Schema.Array(toolName), {
  default: () => [],
});

/** The built-in code middleware a document may install on received messages. */
const incomingMiddleware = Schema.Union(
  Schema.Struct({ use: Schema.Literal("acknowledgements") }),
  Schema.Struct({
    use: Schema.Literal("allowed-senders"),
    agentIds: Schema.Array(AgentId),
  }),
  Schema.Struct({ use: Schema.Literal("collective-norms") }),
);

/**
 * The built-in code middleware a document may install on sends.
 * `plain-language` refuses the host's tool names in prose: `toolNames`
 * anywhere, a name starting with one of `toolNamePrefixes` anywhere, and
 * `invocationToolNames`, which are ordinary words, only where the text formats
 * or invokes them as a tool.
 */
const outgoingMiddleware = Schema.Union(
  Schema.Struct({ use: Schema.Literal("credentials") }),
  Schema.Struct({
    use: Schema.Literal("plain-language"),
    toolNames,
    toolNamePrefixes: toolNames,
    invocationToolNames: toolNames,
  }),
  Schema.Struct({
    use: Schema.Literal("collective-norms"),
    facilitator: Schema.Boolean,
  }),
  Schema.Struct({ use: Schema.Literal("open-requests") }),
  Schema.Struct({ use: Schema.Literal("acknowledgements") }),
);

/** One received-message middleware entry of a document. */
export type IncomingMiddlewareEntry = typeof incomingMiddleware.Type;

/** One send middleware entry of a document. */
export type OutgoingMiddlewareEntry = typeof outgoingMiddleware.Type;

/**
 * The service that assesses English rules. `jev` needs the key file the
 * daemon names in `SHARNESS_DECISION_PROVIDER_KEY_FILE`; `unavailable`
 * installs the rules with no service, so every English check is unavailable:
 * enforcement holds the message and guidance admits it.
 */
const decisionProvider = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("jev"),
    model: Schema.NonEmptyTrimmedString,
  }),
  Schema.Struct({ kind: Schema.Literal("unavailable") }),
);

/** Retained autonomy rules decode as safety rules with compatible registered advice. */
const storedEnglishRule = Schema.transformOrFail(
  Schema.Struct({
    ...EnglishRule.fields,
    kind: Schema.Literal("safety", "norm", "autonomy"),
  }),
  Schema.Struct(EnglishRule.fields),
  {
    strict: true,
    decode: (rule) =>
      rule.kind === "autonomy"
        ? migrateAutonomyRule(rule)
        : Effect.succeed({ ...rule, kind: rule.kind }),
    encode: (rule) => Effect.succeed(rule),
  },
);

/**
 * Safety retains compatible advice and registers owner-review advice for permanent holds.
 * @param rule Retained owner text and registered advice.
 * @returns A logged migration with feedback valid for a safety finding.
 */
export function migrateAutonomyRule(rule: Omit<EnglishRule, "kind">) {
  return Effect.gen(function* () {
    const feedback = rule.feedback;
    const compatible =
      feedback?.nextAction === "stop" || feedback?.nextAction === "wait";
    yield* Effect.logInfo(
      `Message policy migrated autonomy rules to safety: ${rule.id}`,
    );
    if (feedback !== undefined && !compatible) {
      yield* Effect.logInfo(
        `Message policy dropped incompatible autonomy feedback: ${rule.id}`,
      );
    }
    return {
      ...Struct.omit(rule, "feedback"),
      kind: "safety" as const,
      feedback: compatible
        ? feedback
        : {
            nextAction: "stop" as const,
            text: `This message needs your owner's review under rule ${rule.id} and stays held. Revise it or stop.`,
          },
    };
  }).pipe(Effect.withSpan("migrateAutonomyRule"));
}

const englishRules = Schema.optionalWith(Schema.Array(EnglishRule), {
  default: () => [],
});
const retainedEnglishRules = Schema.optionalWith(
  Schema.Array(storedEnglishRule),
  {
    default: () => [],
  },
);

/** English assessment defaults: the lowest routing probability Client accepts, and the request bounds the collective norms are sized to. */
const defaultEnglishSettings = {
  minimumProbability: 0.5,
  maximumRequestBytes: 384_000,
  timeoutMilliseconds: 15_000,
};

/** Per-check bounds sized for English assessment of a full history window. */
const defaultSettings = {
  timeoutMilliseconds: 150_000,
  middlewareTimeoutMilliseconds: 70_000,
  maximumInputBytes: 512_000,
  maximumResultBytes: 2_000_000,
};

/** A behavior Client ships, named by its pack and name as its directory under `behaviors/` is, such as `policy/no-policy-changes`. */
const builtinBehaviorName = Schema.String.pipe(
  Schema.pattern(/^[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*$/u),
);

const englishDocument = Schema.Struct({
  fixedRules: englishRules,
  initialRules: englishRules,
  fixedBehaviors: Schema.optional(Schema.Array(Schema.String)),
  initialBehaviors: Schema.optional(Schema.Array(Schema.String)),
  builtinBehaviors: Schema.optional(Schema.Array(builtinBehaviorName)),
});

const document = Schema.Struct({
  format: Schema.Literal(messagePolicyFormat),
  mode: Schema.Literal("guidance", "enforcement"),
  incoming: Schema.optionalWith(Schema.Array(incomingMiddleware), {
    default: () => [],
  }),
  outgoing: Schema.optionalWith(Schema.Array(outgoingMiddleware), {
    default: () => [],
  }),
  english: Schema.optional(englishDocument),
  decisionProvider: Schema.optional(decisionProvider),
  englishSettings: Schema.optionalWith(
    Schema.Struct(EnglishPolicySettings.fields),
    { default: () => defaultEnglishSettings },
  ),
  settings: Schema.optionalWith(Schema.Struct(FirewallSettings.fields), {
    default: () => defaultSettings,
  }),
  facts: Schema.optionalWith(MessageContext.fields.facts, {
    default: () => [],
  }),
  maximumHistoryRecords: Schema.optional(
    Schema.Int.pipe(Schema.between(1, 1024)),
  ),
  maximumConcurrentChecks: Schema.optional(
    Schema.Int.pipe(Schema.between(1, 32)),
  ),
});

/* eslint-disable @typescript-eslint/naming-convention, @typescript-eslint/no-redeclare -- The document Schema shares its domain name with the value it decodes. */

/**
 * The message policy of one daemon: its firewall mode, the built-in code
 * middleware of each direction in chain order, its fixed and initial
 * editable English rules, the decision provider those rules and the
 * collective norms need, and the check bounds. Absent settings take Client's
 * defaults. English rules or the collective norms without a decision
 * provider, the collective norms with the `unavailable` provider, which would
 * leave every one of their English checks unavailable, and an English rule
 * id given twice across the fixed and initial rules are refused.
 */
export const MessagePolicy = document.pipe(
  Schema.filter(
    (policy) =>
      policy.decisionProvider !== undefined || !needsDecisionProvider(policy),
    {
      message: () =>
        "decisionProvider is required for English rules and the collective norms",
    },
  ),
  Schema.filter(
    (policy) =>
      policy.decisionProvider?.kind !== "unavailable" ||
      !installsCollectiveNorms(policy),
    {
      message: () => "the collective norms need an available decisionProvider",
    },
  ),
  Schema.filter((policy) => uniqueEnglishRuleIds(policy), {
    message: () =>
      "english rule ids must be unique across fixedRules and initialRules",
  }),
);

/** One decoded message-policy document, with Client's defaults filled in. */
export type MessagePolicy = typeof MessagePolicy.Type;

/* eslint-enable @typescript-eslint/naming-convention, @typescript-eslint/no-redeclare -- Restore naming after the Schema/type pair. */

/**
 * Decodes the text of a message-policy document, refusing any property it
 * does not name, so a misspelled or newer setting never silently weakens the
 * policy.
 */
export const decodeMessagePolicy = Schema.decodeUnknown(
  Schema.parseJson(
    Schema.compose(
      Schema.Struct({
        ...document.fields,
        english: Schema.optional(
          Schema.Struct({
            ...englishDocument.fields,
            fixedRules: retainedEnglishRules,
            initialRules: retainedEnglishRules,
          }),
        ),
      }),
      MessagePolicy,
    ),
  ),
  { onExcessProperty: "error" },
);

/** The Behaviors spec limits each BEHAVIOR.md to 64 KiB: docs/reference/spec/harness/message-policy.md#behaviors. */
export const MAXIMUM_BEHAVIOR_BYTES = 65_536;

/** YAML owns frontmatter syntax; only Social Harness metadata is a closed namespace. */
const behaviorFrontmatter = Schema.Struct({
  name: Schema.NonEmptyTrimmedString,
  description: Schema.NonEmptyString,
  metadata: Schema.Struct({
    "social-harness": exactStruct({
      kind: Schema.optionalWith(EnglishRule.fields.kind, {
        default: () => "norm" as const,
      }),
      guidance: EnglishRule.fields.guidance,
      feedback: EnglishRule.fields.feedback,
    }),
  }),
});

/** The closed categories a `BEHAVIOR.md` that does not map to a rule fails with. */
type BehaviorRefusal = "frontmatter" | "schema";

/**
 * Maps one `BEHAVIOR.md` to its editable English rule. YAML parser
 * diagnostics stay private; only a closed category reaches `refused`, which
 * builds the caller's own failure.
 * @param bytes The behavior's bytes; callers bound them by {@link MAXIMUM_BEHAVIOR_BYTES}.
 * @param refused The caller's failure for a closed category.
 * @returns The rule.
 */
export function decodeBehavior<Failure>(
  bytes: Buffer,
  refused: (reason: BehaviorRefusal) => Failure,
) {
  return Effect.gen(function* () {
    const parts = /^---\r?\n([\s\S]*?)^---[ \t]*(?:\r?\n|$)([\s\S]*)/mu.exec(
      bytes.toString("utf8").replace(/^\uFEFF/u, ""),
    );
    if (
      parts?.[1] === undefined ||
      parts[2] === undefined ||
      parts.index !== 0
    ) {
      return yield* Effect.fail(refused("frontmatter"));
    }
    const frontmatter = yield* decodeFrontmatter(parts[1], refused);
    const metadata = frontmatter.metadata["social-harness"];
    const rules = yield* Schema.decodeUnknown(policyReadSchema.fields.rules)([
      {
        id: frontmatter.name,
        text: parts[2].trim(),
        ...metadata,
      },
    ]).pipe(Effect.mapError(() => refused("schema")));
    return yield* Effect.fromNullable(rules[0]).pipe(
      Effect.mapError(() => refused("schema")),
    );
  }).pipe(Effect.withSpan("decodeBehavior"));
}

function needsDecisionProvider(policy: typeof document.Type): boolean {
  return policy.english !== undefined || installsCollectiveNorms(policy);
}

function installsCollectiveNorms(policy: typeof document.Type): boolean {
  return [...policy.incoming, ...policy.outgoing].some(
    (entry) => entry.use === "collective-norms",
  );
}

function uniqueEnglishRuleIds(policy: typeof document.Type): boolean {
  const ids = [
    ...(policy.english?.fixedRules ?? []),
    ...(policy.english?.initialRules ?? []),
  ].map((rule) => rule.id);
  return new Set(ids).size === ids.length;
}

/**
 * Decodes the YAML between a behavior's `---` lines. Parser diagnostics,
 * including unresolved tags, stay inside this boundary.
 * @param text The frontmatter YAML.
 * @param refused The caller's failure for a closed category.
 * @returns The frontmatter fields.
 */
function decodeFrontmatter<Failure>(
  text: string,
  refused: (reason: BehaviorRefusal) => Failure,
) {
  return Effect.gen(function* () {
    const doc = yield* Effect.try({
      try: () =>
        parseDocument(text, {
          schema: "core",
          resolveKnownTags: false,
          logLevel: "error",
        }),
      catch: () => refused("frontmatter"),
    });
    if (doc.errors.length !== 0 || doc.warnings.length !== 0) {
      return yield* Effect.fail(refused("frontmatter"));
    }
    return yield* Effect.try({
      try: (): unknown => doc.toJS(),
      catch: () => refused("frontmatter"),
    }).pipe(
      Effect.flatMap((value) =>
        Schema.decodeUnknown(behaviorFrontmatter)(value).pipe(
          Effect.mapError(() => refused("schema")),
        ),
      ),
    );
  });
}
