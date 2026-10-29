/** @file Serialized policy edits replace immutable chains without replacing daemon resources. */

import { Clock, Effect, Schema, Struct } from "effect";
import {
  decodeRuntimeValue,
  encodeRuntimeValue,
  type EndpointStore,
  EndpointStoreError,
  type FirewallActivation,
  type FirewallAuditEntry,
} from "../../communication/store/index.js";
import { exactStruct } from "../../encoding/exact.js";
import {
  buildFirewall,
  captureRegistration,
  decodeFirewallAuditEntry,
  type FirewallOptions,
  type InstalledFirewall,
} from "../admission/index.js";
import {
  type DecidingRule,
  decidingRules,
  decodeFrozen,
  editableDocumentSchema,
  firewallDecisionsSchema,
  FirewallPolicyError,
  type FirewallPolicyOperations,
  makeTextPolicy,
  MAXIMUM_EDITABLE_RULES,
  type PolicyAuthority,
  type PolicyProblem,
  policyReadSchema,
  policyUpdateSchema,
  PrivateCheckTrace,
  type RuleDescription,
  textPolicyFormat,
  TextPolicySettings,
  TextRule,
} from "../evaluator/index.js";
import { localGuidanceImpersonationRule } from "../rules/index.js";
import { decodeBehavior, MAXIMUM_BEHAVIOR_BYTES } from "./document/index.js";

type FixedRules = typeof policyReadSchema.fields.fixedRules.Type;
const textId = "org.social-harness/text";
const storedPolicyFormat = "org.social-harness/text-rules/v1";
const ownedRulesSchema = policyReadSchema.fields.rules.pipe(
  Schema.maxItems(MAXIMUM_EDITABLE_RULES),
);
const storedPolicySchema = exactStruct({
  format: Schema.Literal(storedPolicyFormat),
  rules: ownedRulesSchema,
});
type OwnedRule = (typeof ownedRulesSchema.Type)[number];

const persistenceFailure = () =>
  new FirewallPolicyError({ reason: "persistence-failed" });
const invalidRule = (
  problem: PolicyProblem,
  at: { readonly path?: PolicyEditPath; readonly ruleId?: string } = {},
) => new FirewallPolicyError({ reason: "invalid-rule", problem, ...at });

type PolicyEditPath = NonNullable<FirewallPolicyError["path"]>;

/** The reset store accepts only daemon-assigned rule ownership. */
function decodeStoredRules(bytes: Uint8Array) {
  return decodeRuntimeValue(storedPolicySchema, bytes).pipe(
    Effect.map(({ rules }) => rules),
    Effect.mapError(persistenceFailure),
  );
}

const captureText = Effect.fn("captureTextOptions")(function* (
  text: FirewallOptions["text"],
) {
  if (text === undefined) {
    return undefined;
  }
  const fixedRules = yield* decodeFrozen(
    Schema.Array(TextRule),
    text.fixedRules ?? [],
  );
  yield* validateIds(fixedRules, [localGuidanceImpersonationRule.id]);
  const initialRules = yield* decodeFrozen(
    editableDocumentSchema,
    text.initialRules ?? [],
  );
  const settings = yield* decodeFrozen(TextPolicySettings, text.settings);
  const provenance =
    text.provider.provenance === undefined
      ? undefined
      : yield* decodeFrozen(PrivateCheckTrace, text.provider.provenance);
  return {
    fixedRules: yield* decodeFrozen(Schema.Array(TextRule), [
      ...fixedRules,
      localGuidanceImpersonationRule,
    ]),
    initialRules,
    settings,
    provider: {
      decide: text.provider.decide.bind(text.provider),
      ...(provenance === undefined ? {} : { provenance }),
    },
  };
});

/** Fixed code and provider identity are captured once, before any policy operation can run. */
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
  const base = yield* buildFirewall({ ...options, incoming, outgoing });
  return {
    base,
    fixed: {
      ...base.configuration,
      settings: base.metadata.settings,
      incoming,
      outgoing,
    },
    text: yield* captureText(options.text),
  };
});

type CapturedOptions = Effect.Effect.Success<ReturnType<typeof captureOptions>>;

/** Build failures, including trusted factory defects, leave the active reference untouched. */
function buildPolicy(options: CapturedOptions, rules: readonly OwnedRule[]) {
  return Effect.gen(function* () {
    const documents = [
      ...(options.text?.fixedRules ?? []),
      ...rules.map(Struct.omit("owner")),
    ];
    if (documents.length === 0) {
      return options.base;
    }
    if (options.text === undefined) {
      return yield* new FirewallPolicyError({ reason: "not-configured" });
    }
    const text = yield* makeTextPolicy({
      id: textId,
      rules: documents,
      provider: options.text.provider,
      settings: options.text.settings,
      fixedRuleIds: options.text.fixedRules.map((rule) => rule.id),
      runtimeRuleIds: rules
        .filter((rule) => rule.owner === "runtime")
        .map((rule) => rule.id),
    });
    return yield* buildFirewall({
      ...options.fixed,
      incoming: [...options.fixed.incoming, text],
      outgoing: [...options.fixed.outgoing, text],
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
 * fixed text; an id declared more than once is listed at its first
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
    ...(options.text?.fixedRules ?? []).map((rule) => ({
      from: "text" as const,
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
  rules: readonly TextRule[],
  fixedRuleIds: readonly string[],
) {
  const collision = rules.find((rule) => fixedRuleIds.includes(rule.id));
  if (collision !== undefined) {
    return Effect.fail(
      new FirewallPolicyError({ reason: "fixed-rule", ruleId: collision.id }),
    );
  }
  const repeated = rules.find(
    (rule, index) => rules.findIndex(({ id }) => id === rule.id) !== index,
  );
  return repeated === undefined
    ? Effect.void
    : Effect.fail(invalidRule("duplicate-id", { ruleId: repeated.id }));
}

interface PolicyState {
  rules: readonly OwnedRule[];
  readonly fixedRuleIds: readonly string[];
  active: Omit<InstalledFirewall, "current" | "policy">;
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
    const rules =
      stored === undefined
        ? (captured.text?.initialRules ?? []).map((rule) => ({
            ...rule,
            owner: "owner" as const,
          }))
        : yield* decodeStoredRules(stored);
    yield* validateIds(rules, fixedRuleIds);
    const active = yield* buildPolicy(captured, rules);
    const state: PolicyState = { rules, active, fixedRuleIds };
    if (stored === undefined) {
      yield* persistRules(store, rules);
    }
    const gate = yield* Effect.makeSemaphore(1);
    const policy: FirewallPolicyOperations = {
      read: () =>
        Effect.sync(() => ({
          rules: state.rules,
          fixedRules: fixed,
          activeRevision: state.active.configurationDigest,
        })),
      update: (request, authority) =>
        gate.withPermits(1)(
          updatePolicy(captured, store, state, { request, authority }),
        ),
      decisions: (request) => readDecisions(store, request),
    };
    return liveInstallation(state, captured.base.permits, policy);
  },
);

/** Live handles follow policy edits; captured handles keep one installation throughout a check. */
function liveInstallation(
  state: PolicyState,
  permits: Effect.Semaphore,
  policy: FirewallPolicyOperations,
): InstalledFirewall {
  const current = (): InstalledFirewall => {
    const snapshot: InstalledFirewall = Object.freeze({
      ...state.active,
      permits,
      current: () => snapshot,
      policy,
    });
    return snapshot;
  };
  return Object.freeze({ ...current(), current });
}

function persistRules(
  store: EndpointStore,
  rules: readonly OwnedRule[],
  activation?: FirewallActivation,
) {
  return encodeRuntimeValue({ format: storedPolicyFormat, rules }).pipe(
    Effect.flatMap((bytes) => store.writeFirewallPolicy(bytes, activation)),
    Effect.mapError(persistenceFailure),
  );
}

interface RuleChange {
  readonly add: typeof editableDocumentSchema.Type;
  readonly remove: readonly string[];
}

/** Each `{behavior}` addition becomes its rule; a behavior the policy file would refuse is an invalid rule at its place in `add`. */
function resolvedChange(change: typeof policyUpdateSchema.Type) {
  return Effect.forEach(
    change.add ?? [],
    (item, index) =>
      "behavior" in item
        ? behaviorRule(item.behavior, ["add", index])
        : Effect.succeed(item),
    { concurrency: 1 },
  ).pipe(
    Effect.map((add): RuleChange => ({ add, remove: change.remove ?? [] })),
  );
}

/** A shared norm is kind `norm`, so a peer's text never adds a rule that holds uncertain messages. */
function behaviorRule(text: string, path: PolicyEditPath) {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length > MAXIMUM_BEHAVIOR_BYTES) {
    return Effect.fail(invalidRule("too-large", { path }));
  }
  return decodeBehavior(bytes, (problem) =>
    invalidRule(problem, { path }),
  ).pipe(
    Effect.filterOrFail(
      (rule) => rule.kind === "norm",
      (rule) => invalidRule("not-norm", { path, ruleId: rule.id }),
    ),
  );
}

/**
 * The editable document an edit leaves, or the first item it cannot apply:
 * a fixed id, a removal of an id the document lacks, an addition whose id the
 * document keeps or the edit adds twice, or more rules than the limit.
 */
function editedRules(
  rules: readonly OwnedRule[],
  fixedRuleIds: readonly string[],
  { add, remove }: RuleChange,
  authority: PolicyAuthority,
) {
  return Effect.gen(function* () {
    yield* Effect.forEach(
      remove,
      (ruleId, index) =>
        removable(rules, fixedRuleIds, { ruleId, index, authority }),
      { concurrency: 1, discard: true },
    );
    const kept = rules.filter((rule) => !remove.includes(rule.id));
    yield* Effect.forEach(
      add,
      (rule, index) =>
        addable([...kept, ...add.slice(0, index)], fixedRuleIds, rule, index),
      { concurrency: 1, discard: true },
    );
    if (kept.length + add.length > MAXIMUM_EDITABLE_RULES) {
      return yield* invalidRule("editable-limit");
    }
    if (authority === "runtime") {
      const invalidIndex = add.findIndex((rule) => rule.kind !== "norm");
      const invalid = add[invalidIndex];
      if (invalid !== undefined) {
        return yield* invalidRule("not-norm", {
          path: ["add", invalidIndex],
          ruleId: invalid.id,
        });
      }
    }
    return yield* decodeFrozen(ownedRulesSchema, [
      ...kept,
      ...add.map((rule) => ({ ...rule, owner: authority })),
    ]).pipe(Effect.mapError(() => invalidRule("schema")));
  });
}

function removable(
  rules: readonly OwnedRule[],
  fixedRuleIds: readonly string[],
  {
    ruleId,
    index,
    authority,
  }: {
    readonly ruleId: string;
    readonly index: number;
    readonly authority: PolicyAuthority;
  },
) {
  const path: PolicyEditPath = ["remove", index];
  if (fixedRuleIds.includes(ruleId)) {
    return Effect.fail(
      new FirewallPolicyError({ reason: "fixed-rule", ruleId, path }),
    );
  }
  const rule = rules.find((entry) => entry.id === ruleId);
  if (rule?.owner === "owner" && authority === "runtime") {
    return Effect.fail(
      new FirewallPolicyError({ reason: "owner-rule", ruleId, path }),
    );
  }
  return rule !== undefined
    ? Effect.void
    : Effect.fail(invalidRule("unknown-id", { path, ruleId }));
}

function addable(
  before: readonly TextRule[],
  fixedRuleIds: readonly string[],
  rule: TextRule,
  index: number,
) {
  const path: PolicyEditPath = ["add", index];
  if (fixedRuleIds.includes(rule.id)) {
    return Effect.fail(
      new FirewallPolicyError({ reason: "fixed-rule", ruleId: rule.id, path }),
    );
  }
  return before.some(({ id }) => id === rule.id)
    ? Effect.fail(invalidRule("duplicate-id", { path, ruleId: rule.id }))
    : Effect.void;
}

function updatePolicy(
  captured: CapturedOptions,
  store: EndpointStore,
  state: PolicyState,
  {
    request,
    authority,
  }: {
    readonly request: typeof policyUpdateSchema.Type;
    readonly authority: PolicyAuthority;
  },
) {
  return Effect.gen(function* () {
    const change = yield* decodeFrozen(policyUpdateSchema, request).pipe(
      Effect.mapError(() => invalidRule("schema")),
      Effect.flatMap((decoded) => resolvedChange(decoded)),
    );
    const next = yield* editedRules(
      state.rules,
      state.fixedRuleIds,
      change,
      authority,
    );
    const replacement = yield* buildPolicy(captured, next);
    return yield* Effect.uninterruptible(
      persistRules(store, next, {
        time: yield* Clock.currentTimeMillis,
        activeRevision: replacement.configurationDigest,
        addedRuleIds: change.add.map((rule) => rule.id),
        removedRuleIds: change.remove,
      }).pipe(
        Effect.zipRight(
          Effect.sync(() => {
            state.active = replacement;
            state.rules = next;
            return { activeRevision: replacement.configurationDigest };
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
    Effect.flatMap((check) =>
      ruleOrigin(check.input.installation[check.direction]).pipe(
        Effect.flatMap((origin) => projectDecision(check, entry.time, origin)),
      ),
    ),
  );
}

type DecodedCheck = Effect.Effect.Success<
  ReturnType<typeof decodeFirewallAuditEntry>
>;
type DecodedResult = NonNullable<DecodedCheck["result"]>;

type DecisionRow = (typeof firewallDecisionsSchema.Type.decisions)[number];
type Registration = DecodedCheck["input"]["installation"]["incoming"][number];

const textProvenance = Schema.parseJson(
  Schema.Struct({
    fixedRuleIds: Schema.Array(Schema.String),
    runtimeRuleIds: Schema.Array(Schema.String),
  }),
);

type RuleOrigin = (
  rule: DecidingRule,
) => Pick<DecisionRow["decidedBy"][number], "from" | "owner">;

function projectDecision(
  check: DecodedCheck,
  time: number,
  origin: RuleOrigin,
) {
  const result = check.result;
  if (
    result === null ||
    check.disposition === "checking" ||
    check.disposition === "interrupted"
  ) {
    return Effect.succeed([]);
  }
  const message = check.input.message;
  const peers =
    message === null ? [null] : decisionPeers(message, check.direction);
  const rules = decisionRules(
    result,
    check.input.installation[check.direction],
    origin,
  );
  return Effect.forEach(
    peers,
    (peerAgentId) => {
      const peer =
        peerAgentId === null
          ? null
          : check.input.agents.find((agent) => agent.agentId === peerAgentId);
      return peer === undefined
        ? Effect.fail(new EndpointStoreError({ reason: "corrupt" }))
        : Effect.succeed({
            checkId: check.checkId,
            time,
            direction: check.direction,
            peer,
            outcome: result.judgment,
            disposition: check.disposition,
            ...rules,
            activeRevision: check.input.configurationDigest,
          });
    },
    { concurrency: 1 },
  );
}

function decisionRules(
  result: DecodedResult,
  registrations: readonly Registration[],
  origin: RuleOrigin,
) {
  const checkedRuleIds = [
    ...new Set(
      result.checks.flatMap((middleware) =>
        middleware.findings.map((finding) => finding.ruleId),
      ),
    ),
  ];
  const deciding = decidingRules(result.reason, registrations, result.checks);
  const text = new Set(
    registrations
      .filter((entry) => entry.provenance.format === textPolicyFormat)
      .map((entry) => entry.id),
  );
  const cause = decisionCause(result, deciding, text);
  const decidedBy = deciding.map((rule) => ({
    ruleId: rule.ruleId,
    ...origin(rule),
    ...(rule.advice === undefined ? {} : { advice: rule.advice }),
  }));
  return { cause, decidedBy, checkedRuleIds };
}

/**
 * Where a deciding rule is defined, as `policy_read` lists it: a rule of the
 * editable text middleware is `fixed` or `editable`, and any other is
 * `code`. The fixed ids come from the installation the check retained. Runtime ownership is
 * also captured there, so later edits cannot rewrite an earlier decision.
 */
function ruleOrigin(registrations: readonly Registration[]) {
  return Effect.gen(function* () {
    const text = registrations.find(
      (entry) =>
        entry.id === textId && entry.provenance.format === textPolicyFormat,
    );
    const recorded =
      text === undefined
        ? { fixedRuleIds: [], runtimeRuleIds: [] }
        : yield* Schema.decodeUnknown(textProvenance)(text.provenance.data);
    const fixed = new Set(recorded.fixedRuleIds);
    const runtime = new Set(recorded.runtimeRuleIds);
    return (rule: DecidingRule): ReturnType<RuleOrigin> => {
      if (rule.middlewareId !== text?.id) {
        return { from: "code" };
      }
      return fixed.has(rule.ruleId)
        ? { from: "fixed", owner: "owner" }
        : {
            from: "editable",
            owner: runtime.has(rule.ruleId) ? "runtime" : "owner",
          };
    };
  });
}

function decisionCause(
  result: DecodedResult,
  deciding: readonly DecidingRule[],
  text: ReadonlySet<string>,
): DecisionRow["cause"] {
  const first =
    deciding.find((rule) => text.has(rule.middlewareId)) ?? deciding[0];
  if (first === undefined) {
    return emptyCause(result);
  }
  if (first.finding === "unavailable") {
    return "unavailable";
  }
  if (!text.has(first.middlewareId)) {
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
