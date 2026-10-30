/** @file Serialized policy edits replace immutable chains without replacing daemon resources. */

import { Clock, Effect, Schema, Struct } from "effect";
import type { FirewallActivation, FirewallStore } from "../store/index.js";
import {
  decodeRuntimeValue,
  encodeRuntimeValue,
} from "../../communication/store/index.js";
import { exactStruct } from "../../encoding/exact.js";
import {
  decodeFrozen,
  makeTextPolicy,
  PrivateCheckTrace,
  type RuleDescription,
  TextPolicySettings,
  TextRule,
} from "../evaluator/index.js";
import {
  buildFirewall,
  captureInstallation,
  type FirewallOptions,
  type InstalledFirewall,
} from "./installation.js";
import { localGuidanceImpersonationRule } from "../rules/index.js";
import {
  editableDocumentSchema,
  FirewallPolicyError,
  type FirewallPolicyOperations,
  MAXIMUM_EDITABLE_RULES,
  type PolicyAuthority,
  type PolicyProblem,
  policyReadSchema,
  policyUpdateSchema,
} from "./contract.js";
import { readDecisions } from "./decision-history.js";
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
  const fixed = yield* captureInstallation(options);
  return {
    fixed,
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
      return yield* buildFirewall(
        options.fixed,
        options.fixed.incoming,
        options.fixed.outgoing,
      );
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
    return yield* buildFirewall(
      options.fixed,
      [...options.fixed.incoming, text],
      [...options.fixed.outgoing, text],
    );
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
    ...(rule.notifySender === undefined
      ? {}
      : { notifySender: rule.notifySender }),
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
      applies: rule.applies,
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
  function* (options: FirewallOptions, store: FirewallStore) {
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
      decisions: (request) =>
        readDecisions(store, request, textId).pipe(
          Effect.mapError(persistenceFailure),
        ),
    };
    return liveInstallation(state, policy);
  },
);

/** Live handles follow policy edits; captured handles keep one installation throughout a check. */
function liveInstallation(
  state: PolicyState,
  policy: FirewallPolicyOperations,
): InstalledFirewall {
  const current = (): InstalledFirewall => {
    const snapshot: InstalledFirewall = Object.freeze({
      ...state.active,
      current: () => snapshot,
      policy,
    });
    return snapshot;
  };
  return Object.freeze({ ...current(), current });
}

function persistRules(
  store: FirewallStore,
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

/** A behavior supplies the same direction and registered advice as an inline rule. */
function behaviorRule(text: string, path: PolicyEditPath) {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length > MAXIMUM_BEHAVIOR_BYTES) {
    return Effect.fail(invalidRule("too-large", { path }));
  }
  return decodeBehavior(bytes, (problem) => invalidRule(problem, { path }));
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
  store: FirewallStore,
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
