/** @file Serialized owner edits replace immutable chains without replacing daemon resources. */

import { Clock, Effect, Option, Schema } from "effect";
import {
  decodeRuntimeValue,
  encodeRuntimeValue,
  type EndpointStore,
  type FirewallActivation,
  type FirewallAuditEntry,
} from "../../communication/store/index.js";
import { exactStruct } from "../../encoding/exact.js";
import {
  captureRegistration,
  decodeFirewallAuditEntry,
  type FirewallOptions,
  type InstalledFirewall,
  installFirewall,
} from "../admission/index.js";
import {
  type DecidingRule,
  decidingRules,
  decodeFrozen,
  editableDocumentSchema,
  englishPolicyFormat,
  EnglishPolicySettings,
  EnglishRule,
  firewallDecisionsSchema,
  FirewallPolicyError,
  type FirewallPolicyOperations,
  makeEnglishPolicy,
  policyReadSchema,
  policyUpdateSchema,
  PrivateCheckTrace,
  type RuleDescription,
} from "../evaluator/index.js";
import { localGuidanceImpersonationRule } from "../rules/index.js";
import { migrateAutonomyRule } from "./document/index.js";

type FixedRules = typeof policyReadSchema.fields.fixedRules.Type;
const englishId = "org.social-harness/english";

const persistenceFailure = () =>
  new FirewallPolicyError({ reason: "persistence-failed" });
const invalidRule = () => new FirewallPolicyError({ reason: "invalid-rule" });

/** Stored editable rules share the live exact members plus the historical safety mapping. */
function decodeStoredRules(bytes: Uint8Array) {
  const migratedRuleIds: string[] = [];
  const retainedEditableRule = Schema.Union(
    policyReadSchema.fields.rules.value,
    Schema.transformOrFail(
      exactStruct({
        id: EnglishRule.fields.id,
        text: EnglishRule.fields.text,
        kind: Schema.Literal("autonomy"),
        guidance: EnglishRule.fields.guidance,
        feedback: EnglishRule.fields.feedback,
      }),
      policyReadSchema.fields.rules.value.members[1],
      {
        strict: true,
        decode: (rule) => {
          migratedRuleIds.push(rule.id);
          return migrateAutonomyRule(rule);
        },
        encode: (rule) =>
          Effect.succeed({ ...rule, kind: "autonomy" as const }),
      },
    ),
  );

  return decodeRuntimeValue(
    Schema.Array(retainedEditableRule).pipe(Schema.maxItems(256)),
    bytes,
  ).pipe(
    Effect.tap((rules) =>
      Effect.sync(() => {
        for (const rule of rules) {
          if (rule.feedback !== undefined) {
            Object.freeze(rule.feedback);
          }
          Object.freeze(rule);
        }
        Object.freeze(rules);
      }),
    ),
    Effect.map((rules) => ({ rules, migratedRuleIds })),
    Effect.mapError(persistenceFailure),
  );
}

const captureEnglish = Effect.fn("captureEnglishOptions")(function* (
  english: FirewallOptions["english"],
) {
  if (english === undefined) {
    return undefined;
  }
  const fixedRules = yield* decodeFrozen(
    Schema.Array(EnglishRule),
    english.fixedRules ?? [],
  );
  yield* validateIds(fixedRules, [localGuidanceImpersonationRule.id]);
  const initialRules = yield* decodeFrozen(
    editableDocumentSchema,
    english.initialRules ?? [],
  );
  const settings = yield* decodeFrozen(EnglishPolicySettings, english.settings);
  const provenance =
    english.provider.provenance === undefined
      ? undefined
      : yield* decodeFrozen(PrivateCheckTrace, english.provider.provenance);
  return {
    fixedRules: yield* decodeFrozen(Schema.Array(EnglishRule), [
      ...fixedRules,
      localGuidanceImpersonationRule,
    ]),
    initialRules,
    settings,
    provider: {
      decide: english.provider.decide.bind(english.provider),
      ...(provenance === undefined ? {} : { provenance }),
    },
  };
});

/** Fixed code and provider identity are captured once, before any owner operation can run. */
const captureOptions = Effect.fn("capturePolicyOptions")(function* (
  options: FirewallOptions,
) {
  const incoming = yield* Effect.forEach(
    options.incoming,
    captureRegistration,
    { concurrency: 1 },
  );
  const outgoing = yield* Effect.forEach(
    options.outgoing,
    captureRegistration,
    { concurrency: 1 },
  );
  const base = yield* installFirewall({ ...options, incoming, outgoing });
  return {
    base,
    fixed: {
      ...base.configuration,
      settings: base.metadata.settings,
      incoming,
      outgoing,
    },
    english: yield* captureEnglish(options.english),
  };
});

type CapturedOptions = Effect.Effect.Success<ReturnType<typeof captureOptions>>;

/** Build failures, including trusted factory defects, leave the active reference untouched. */
function buildPolicy(options: CapturedOptions, rules: readonly EnglishRule[]) {
  return Effect.gen(function* () {
    const documents = [...(options.english?.fixedRules ?? []), ...rules];
    if (documents.length === 0) {
      return options.base;
    }
    if (options.english === undefined) {
      return yield* new FirewallPolicyError({ reason: "not-configured" });
    }
    const english = yield* makeEnglishPolicy({
      id: englishId,
      rules: documents,
      provider: options.english.provider,
      settings: options.english.settings,
      fixedRuleIds: options.english.fixedRules.map((rule) => rule.id),
    });
    return yield* installFirewall({
      ...options.fixed,
      incoming: [...options.fixed.incoming, english],
      outgoing: [...options.fixed.outgoing, english],
    });
  }).pipe(
    Effect.catchTag("CheckInputError", () =>
      Effect.fail(new FirewallPolicyError({ reason: "build-failed" })),
    ),
    Effect.catchAllDefect(() =>
      Effect.fail(new FirewallPolicyError({ reason: "build-failed" })),
    ),
  );
}

function described(rule: RuleDescription) {
  return {
    id: rule.id,
    kind: rule.kind,
    ...(rule.guidance === undefined ? {} : { guidance: rule.guidance }),
    ...(rule.feedback === undefined ? {} : { feedback: rule.feedback }),
  };
}

/**
 * Fixed rules in installation order, code incoming then code outgoing then
 * fixed English; an id declared more than once is listed at its first
 * declaration, as one middleware registered in both directions declares its
 * rules twice.
 */
function fixedRules(options: CapturedOptions): FixedRules {
  const declared: FixedRules = [
    ...[...options.fixed.incoming, ...options.fixed.outgoing].flatMap(
      (middleware) =>
        middleware.rules.map((rule) => ({
          from: "code" as const,
          middleware: middleware.id,
          ...described(rule),
        })),
    ),
    ...(options.english?.fixedRules ?? []).map((rule) => ({
      from: "english" as const,
      ...described(rule),
      text: rule.text,
    })),
  ];
  const first = new Map<string, FixedRules[number]>();
  for (const rule of declared) {
    if (!first.has(rule.id)) {
      first.set(rule.id, rule);
    }
  }
  return [...first.values()];
}

function validateIds(
  rules: readonly EnglishRule[],
  fixedRuleIds: readonly string[],
) {
  const collision = rules.find((rule) => fixedRuleIds.includes(rule.id));
  if (collision !== undefined) {
    return Effect.fail(
      new FirewallPolicyError({ reason: "fixed-rule", ruleId: collision.id }),
    );
  }
  return new Set(rules.map((rule) => rule.id)).size === rules.length
    ? Effect.void
    : Effect.fail(invalidRule());
}

interface PolicyState {
  rules: typeof editableDocumentSchema.Type;
  readonly fixedRuleIds: readonly string[];
  active: InstalledFirewall;
}

/** Persist-before-swap is uninterruptible; cancellation cannot split desired and active state. */
export const installEditableFirewall = Effect.fn("installEditableFirewall")(
  function* (options: FirewallOptions, store: EndpointStore) {
    const captured = yield* captureOptions(options).pipe(
      Effect.catchTags({
        CheckInputError: () =>
          Effect.fail(new FirewallPolicyError({ reason: "build-failed" })),
        ParseError: () =>
          Effect.fail(new FirewallPolicyError({ reason: "build-failed" })),
      }),
    );
    const fixed = fixedRules(captured);
    const fixedRuleIds = fixed.map((rule) => rule.id);
    const stored = yield* store
      .readFirewallPolicy()
      .pipe(Effect.mapError(persistenceFailure));
    const retained =
      stored === undefined
        ? { rules: captured.english?.initialRules ?? [], migratedRuleIds: [] }
        : yield* decodeStoredRules(stored);
    const rules = retained.rules;
    yield* validateIds(rules, fixedRuleIds);
    const active = yield* buildPolicy(captured, rules);
    const state: PolicyState = { rules, active, fixedRuleIds };
    yield* persistStartupRules(
      store,
      retained,
      active.configurationDigest,
      stored,
    );
    const gate = yield* Effect.makeSemaphore(1);
    const policy: FirewallPolicyOperations = {
      read: () =>
        Effect.sync(() => ({
          rules: state.rules,
          fixedRules: fixed,
          activeRevision: state.active.configurationDigest,
        })),
      update: (request) =>
        gate.withPermits(1)(updatePolicy(captured, store, state, request)),
      decisions: (request) => readDecisions(store, request),
    };
    return Object.freeze({
      ...active,
      permits: captured.base.permits,
      current: () => state.active,
      policy,
    }) satisfies InstalledFirewall;
  },
);

/** Startup writes only a new or changed document and records the migrated ids atomically. */
function persistStartupRules(
  store: EndpointStore,
  retained: {
    readonly rules: readonly EnglishRule[];
    readonly migratedRuleIds: readonly string[];
  },
  activeRevision: string,
  stored?: Uint8Array,
) {
  return Effect.gen(function* () {
    const { rules, migratedRuleIds } = retained;
    const encoded = yield* encodeRuntimeValue(rules).pipe(
      Effect.mapError(persistenceFailure),
    );
    if (
      stored !== undefined &&
      Buffer.from(stored).equals(Buffer.from(encoded))
    ) {
      return;
    }
    const activation =
      migratedRuleIds.length === 0
        ? undefined
        : {
            time: yield* Clock.currentTimeMillis,
            activeRevision,
            addedRuleIds: migratedRuleIds,
            removedRuleIds: migratedRuleIds,
          };
    yield* store
      .writeFirewallPolicy(encoded, activation)
      .pipe(Effect.mapError(persistenceFailure));
  });
}

function persistRules(
  store: EndpointStore,
  rules: readonly EnglishRule[],
  activation?: FirewallActivation,
) {
  return encodeRuntimeValue(rules).pipe(
    Effect.flatMap((bytes) => store.writeFirewallPolicy(bytes, activation)),
    Effect.mapError(persistenceFailure),
  );
}

function editedRules(
  rules: readonly EnglishRule[],
  fixedRuleIds: readonly string[],
  request: typeof policyUpdateSchema.Type,
) {
  return Effect.gen(function* () {
    const remove = request.remove ?? [];
    if (remove.some((id) => fixedRuleIds.includes(id))) {
      return yield* new FirewallPolicyError({ reason: "fixed-rule" });
    }
    if (remove.some((id) => !rules.some((rule) => rule.id === id))) {
      return yield* invalidRule();
    }
    const next = yield* decodeFrozen(editableDocumentSchema, [
      ...rules.filter((rule) => !remove.includes(rule.id)),
      ...(request.add ?? []),
    ]).pipe(Effect.mapError(invalidRule));
    yield* validateIds(next, fixedRuleIds);
    return next;
  });
}

function updatePolicy(
  captured: CapturedOptions,
  store: EndpointStore,
  state: PolicyState,
  request: typeof policyUpdateSchema.Type,
) {
  return Effect.gen(function* () {
    const change = yield* decodeFrozen(policyUpdateSchema, request).pipe(
      Effect.mapError(invalidRule),
    );
    const next = yield* editedRules(state.rules, state.fixedRuleIds, change);
    const replacement = yield* buildPolicy(captured, next);
    return yield* Effect.uninterruptible(
      persistRules(store, next, {
        time: yield* Clock.currentTimeMillis,
        activeRevision: replacement.configurationDigest,
        addedRuleIds: (change.add ?? []).map((rule) => rule.id),
        removedRuleIds: change.remove ?? [],
      }).pipe(
        Effect.zipRight(
          Effect.sync(() => {
            state.active = replacement;
            state.rules = next;
            return {
              activeRevision: replacement.configurationDigest,
              retroactive: false as const,
            };
          }),
        ),
      ),
    );
  }).pipe(Effect.withSpan("updateFirewallPolicy"));
}

/** Explicit projection prevents message content, private input, diagnostics and rule text escaping through this feed; only deciding rules' registered advice is projected. */
function readDecisions(
  store: EndpointStore,
  request: { readonly since?: number },
) {
  return Effect.gen(function* () {
    const entries = yield* store.readFirewallDecisions(request.since);
    const rows = yield* Effect.forEach(entries, decisionRows, {
      concurrency: 1,
    });
    return yield* Schema.decodeUnknown(firewallDecisionsSchema)({
      decisions: rows.flat(),
      activations: (yield* store.readFirewallActivations(request)).map(
        (entry) => entry.activation,
      ),
    });
  }).pipe(Effect.mapError(persistenceFailure));
}

function decisionRows(entry: FirewallAuditEntry & { readonly time: number }) {
  return decodeFirewallAuditEntry(entry).pipe(
    Effect.map((check) => projectDecision(check, entry.time)),
  );
}

type DecodedCheck = Effect.Effect.Success<
  ReturnType<typeof decodeFirewallAuditEntry>
>;
type DecodedResult = NonNullable<DecodedCheck["result"]>;

type DecisionRow = (typeof firewallDecisionsSchema.Type.decisions)[number];
type Registration = DecodedCheck["input"]["installation"]["incoming"][number];

const englishProvenance = Schema.parseJson(
  Schema.Struct({ fixedRuleIds: Schema.optional(Schema.Array(Schema.String)) }),
);

function projectDecision(check: DecodedCheck, time: number) {
  const result = check.result;
  if (
    result === null ||
    check.disposition === "checking" ||
    check.disposition === "interrupted"
  ) {
    return [];
  }
  const message = check.input.message;
  const peers =
    message === null ? [null] : decisionPeers(message, check.direction);
  const checkedRuleIds = [
    ...new Set(
      result.checks.flatMap((middleware) =>
        middleware.findings.map((finding) => finding.ruleId),
      ),
    ),
  ];
  const registrations = check.input.installation[check.direction];
  const deciding = decidingRules(result.reason, registrations, result.checks);
  const english = new Set(
    registrations
      .filter((entry) => entry.provenance.format === englishPolicyFormat)
      .map((entry) => entry.id),
  );
  const cause = decisionCause(result, deciding, english);
  const origin = ruleOrigin(registrations);
  const decidedBy = deciding.map((rule) => ({
    ruleId: rule.ruleId,
    from: origin(rule),
    ...(rule.advice === undefined ? {} : { advice: rule.advice }),
  }));
  return peers.map((peerAgentId) => ({
    checkId: check.checkId,
    time,
    direction: check.direction,
    peerAgentId,
    outcome: result.judgment,
    disposition: check.disposition,
    cause,
    decidedBy,
    checkedRuleIds,
    activeRevision: check.input.configurationDigest,
  }));
}

/**
 * Where a deciding rule is defined, as `policy_read` lists it: a rule of the
 * editable English middleware is `fixed` or `editable`, and any other is
 * `code`. The fixed ids come from the installation the check retained. A
 * check retained before installations recorded them reports every English
 * rule as `editable`, so owner text is never presented as built-in text.
 */
function ruleOrigin(
  registrations: readonly Registration[],
): (rule: DecidingRule) => DecisionRow["decidedBy"][number]["from"] {
  const english = registrations.find((entry) => entry.id === englishId);
  const recorded =
    english === undefined
      ? undefined
      : Option.getOrUndefined(
          Schema.decodeUnknownOption(englishProvenance)(
            english.provenance.data,
          ),
        )?.fixedRuleIds;
  const fixed = new Set(recorded ?? []);
  return (rule) => {
    if (rule.middlewareId !== englishId) {
      return "code";
    }
    return fixed.has(rule.ruleId) ? "fixed" : "editable";
  };
}

/**
 * The cause of a decision, read from its first English deciding rule, or
 * from its first deciding rule when no English rule decided it. A check
 * that could not run is `unavailable` from either kind of middleware,
 * including one that registers no rule; any other code finding is `code`.
 * Otherwise, with no deciding rule, an admission is the `default` and any
 * other outcome is the endpoint's own hold.
 */
function decisionCause(
  result: DecodedResult,
  deciding: readonly DecidingRule[],
  english: ReadonlySet<string>,
): DecisionRow["cause"] {
  const first =
    deciding.find((rule) => english.has(rule.middlewareId)) ?? deciding[0];
  if (first === undefined) {
    return emptyCause(result);
  }
  if (first.finding === "unavailable") {
    return "unavailable";
  }
  if (!english.has(first.middlewareId)) {
    return "code";
  }
  return first.finding === "uncertain" ? "uncertain" : "judgment";
}

function emptyCause(result: DecodedResult): DecisionRow["cause"] {
  if (
    result.reason === "check-unavailable" &&
    result.checks.some((check) => check.status === "unavailable")
  ) {
    return "unavailable";
  }
  return result.judgment === "allow" ? "default" : "endpoint";
}

/**
 * The agents a check's decision rows name: each recipient of an outgoing
 * message, the verified author of an incoming one, and no agent for a result
 * or failure, whose text is the endpoint's own.
 */
function decisionPeers(
  message: NonNullable<DecodedCheck["input"]["message"]>,
  direction: "incoming" | "outgoing",
): ReadonlyArray<string | null> {
  if (direction === "outgoing") {
    return message.recipients;
  }
  const kind = message.operation?.kind;
  return kind === "result" || kind === "failure" ? [null] : [message.sender];
}
