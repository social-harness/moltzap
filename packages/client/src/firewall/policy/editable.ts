/** @file Serialized owner edits replace immutable chains without replacing daemon resources. */

import { Clock, Effect, Option, Schema } from "effect";
import { randomBytes } from "node:crypto";
import {
  decodeRuntimeValue,
  encodeRuntimeValue,
  type EndpointStore,
  type FirewallActivation,
  type FirewallAuditEntry,
  type OwnerProposal,
} from "../../communication/store/index.js";
import { sameBytes } from "../../encoding/canonical-json.js";
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
  proposalsResultSchema,
  type RuleDescription,
} from "../evaluator/index.js";

const editableRules = policyReadSchema.fields.rules.pipe(Schema.maxItems(256));
type FixedRules = typeof policyReadSchema.fields.fixedRules.Type;
const englishId = "org.social-harness/english";

const persistenceFailure = () =>
  new FirewallPolicyError({ reason: "persistence-failed" });
const invalidRule = () => new FirewallPolicyError({ reason: "invalid-rule" });

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
  const initialRules = yield* decodeFrozen(
    editableRules,
    english.initialRules ?? [],
  );
  const settings = yield* decodeFrozen(EnglishPolicySettings, english.settings);
  const provenance =
    english.provider.provenance === undefined
      ? undefined
      : yield* decodeFrozen(PrivateCheckTrace, english.provider.provenance);
  return {
    fixedRules,
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
  if (rules.some((rule) => fixedRuleIds.includes(rule.id))) {
    return Effect.fail(new FirewallPolicyError({ reason: "fixed-rule" }));
  }
  return new Set(rules.map((rule) => rule.id)).size === rules.length
    ? Effect.void
    : Effect.fail(invalidRule());
}

interface PolicyState {
  rules: typeof editableRules.Type;
  readonly fixedRuleIds: readonly string[];
  active: InstalledFirewall;
}

interface EditableContext {
  readonly captured: CapturedOptions;
  readonly store: EndpointStore;
  readonly state: PolicyState;
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
        ? (captured.english?.initialRules ?? [])
        : yield* decodeRuntimeValue(editableRules, stored).pipe(
            Effect.mapError(persistenceFailure),
          );
    yield* validateIds(rules, fixedRuleIds);
    const active = yield* buildPolicy(captured, rules);
    const state: PolicyState = { rules, active, fixedRuleIds };
    if (stored === undefined) {
      yield* persistRules(store, rules);
    }
    const gate = yield* Effect.makeSemaphore(1);
    const policy = policyOperations({ captured, store, state }, gate, fixed);
    return Object.freeze({
      ...active,
      permits: captured.base.permits,
      current: () => state.active,
      policy,
    }) satisfies InstalledFirewall;
  },
);

function policyOperations(
  context: EditableContext,
  gate: Effect.Semaphore,
  fixed: FixedRules,
): FirewallPolicyOperations {
  const { store, state } = context;
  return {
    read: () =>
      Effect.sync(() => ({
        rules: state.rules,
        fixedRules: fixed,
        activeRevision: state.active.configurationDigest,
      })),
    update: (request) => gate.withPermits(1)(updatePolicy(context, request)),
    propose: (request) => gate.withPermits(1)(proposePolicy(context, request)),
    proposals: (request) => pendingProposals(store, request),
    accept: ({ id }) =>
      gate.withPermits(1)(decideProposal(context, id, "accepted")),
    decline: ({ id }) =>
      gate.withPermits(1)(decideProposal(context, id, "declined")),
    decisions: (request) => readDecisions(store, request),
  };
}

function persistRules(
  store: EndpointStore,
  rules: readonly EnglishRule[],
  activation?: FirewallActivation,
  acceptedProposalId?: string,
) {
  return encodeRuntimeValue(rules).pipe(
    Effect.flatMap((bytes) =>
      store.writeFirewallPolicy(bytes, activation, acceptedProposalId),
    ),
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
    const next = yield* decodeFrozen(editableRules, [
      ...rules.filter((rule) => !remove.includes(rule.id)),
      ...(request.add ?? []),
    ]).pipe(Effect.mapError(invalidRule));
    yield* validateIds(next, fixedRuleIds);
    return next;
  });
}

function updatePolicy(
  context: EditableContext,
  request: typeof policyUpdateSchema.Type,
  acceptedProposalId?: string,
) {
  const { captured, store, state } = context;
  return Effect.gen(function* () {
    const change = yield* decodeFrozen(policyUpdateSchema, request).pipe(
      Effect.mapError(invalidRule),
    );
    const next = yield* editedRules(state.rules, state.fixedRuleIds, change);
    const replacement = yield* buildPolicy(captured, next);
    return yield* Effect.uninterruptible(
      persistRules(
        store,
        next,
        {
          time: yield* Clock.currentTimeMillis,
          activeRevision: replacement.configurationDigest,
          addedRuleIds: (change.add ?? []).map((rule) => rule.id),
          removedRuleIds: change.remove ?? [],
        },
        acceptedProposalId,
      ).pipe(
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

/** Validation captures a detached edit without constructing or activating middleware. */
function proposePolicy(
  context: EditableContext,
  request: typeof policyUpdateSchema.Type,
) {
  const { captured, store, state } = context;
  return Effect.gen(function* () {
    const change = yield* decodeFrozen(policyUpdateSchema, request).pipe(
      Effect.mapError(invalidRule),
    );
    const next = yield* editedRules(state.rules, state.fixedRuleIds, change);
    if (next.length > 0 && captured.english === undefined) {
      return yield* new FirewallPolicyError({ reason: "not-configured" });
    }
    const canonicalRequest = yield* encodeRuntimeValue(change);
    const existing = (yield* store.readOwnerProposals()).find(
      (item) =>
        item.status === "pending" &&
        sameBytes(item.canonicalRequest, canonicalRequest),
    );
    if (existing !== undefined) {
      return { id: existing.id };
    }
    const removed = (change.remove ?? []).flatMap((id) =>
      state.rules.filter((rule) => rule.id === id),
    );
    const item: OwnerProposal = {
      id: `pol_${randomBytes(16).toString("base64url")}`,
      proposedAt: yield* Clock.currentTimeMillis,
      canonicalRequest,
      canonicalRemovedRules: yield* encodeRuntimeValue(removed),
      status: "pending",
    };
    yield* store.writeOwnerProposal(item);
    return { id: item.id };
  }).pipe(
    Effect.catchTag("EndpointStoreError", () =>
      Effect.fail(persistenceFailure()),
    ),
  );
}

function pendingProposals(
  store: EndpointStore,
  request: { readonly since?: number },
) {
  return Effect.gen(function* () {
    const items = (yield* store.readOwnerProposals()).filter(
      (item) =>
        item.status === "pending" && item.proposedAt >= (request.since ?? 0),
    );
    const proposals = yield* Effect.forEach(items, pendingProposal, {
      concurrency: 1,
    });
    return yield* decodeFrozen(proposalsResultSchema, { proposals });
  }).pipe(Effect.mapError(persistenceFailure));
}

function pendingProposal(item: OwnerProposal) {
  return Effect.gen(function* () {
    const change = yield* decodeRuntimeValue(
      policyUpdateSchema,
      item.canonicalRequest,
    );
    const remove = yield* decodeRuntimeValue(
      editableRules,
      item.canonicalRemovedRules,
    );
    return {
      id: item.id,
      kind: "policy" as const,
      proposedAt: item.proposedAt,
      add: change.add ?? [],
      remove,
    };
  });
}

/** The edit, activation and acceptance commit together before publishing the replacement chain. */
function decideProposal(
  context: EditableContext,
  id: string,
  decision: "accepted" | "declined",
) {
  const { store, state } = context;
  return Effect.gen(function* () {
    const item = (yield* store.readOwnerProposals()).find(
      (entry) => entry.id === id,
    );
    if (item === undefined) {
      return yield* new FirewallPolicyError({ reason: "unknown-proposal" });
    }
    if (item.status === decision) {
      return { id };
    }
    if (item.status !== "pending") {
      return yield* new FirewallPolicyError({ reason: "already-decided" });
    }
    if (decision === "declined") {
      yield* store.writeOwnerProposal({ ...item, status: decision });
      return { id };
    }
    const removed = yield* decodeRuntimeValue(
      editableRules,
      item.canonicalRemovedRules,
    );
    const current = removed.flatMap((rule) =>
      state.rules.filter((entry) => entry.id === rule.id),
    );
    if (
      !sameBytes(
        yield* encodeRuntimeValue(removed),
        yield* encodeRuntimeValue(current),
      )
    ) {
      return yield* new FirewallPolicyError({ reason: "proposal-stale" });
    }
    const request = yield* decodeRuntimeValue(
      policyUpdateSchema,
      item.canonicalRequest,
    );
    yield* updatePolicy(context, request, id);
    return { id };
  }).pipe(
    Effect.catchTag("EndpointStoreError", () =>
      Effect.fail(persistenceFailure()),
    ),
  );
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
