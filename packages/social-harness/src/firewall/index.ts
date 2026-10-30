/** @file One firewall owns active rules, checks, edits and retained owner queries. */

import { Clock, Effect, Schedule, Schema, Struct } from "effect";
import { createHash, randomBytes } from "node:crypto";
import {
  decodeRuntimeValue,
  encodeRuntimeValue,
  EndpointStoreError,
} from "../communication/store/index.js";
import {
  exitOutcome,
  markRetries,
} from "../communication/conversations/index.js";
import { exactStruct } from "../encoding/exact.js";
import { MAXIMUM_RUNTIME_ITEM_BYTES } from "../encoding/limits.js";
import { AgentView } from "../identity/cards.js";
import {
  captureRegistration,
  checkMessage,
  CheckInputError,
  type CheckedGuidance,
  decodeFrozen,
  type DecisionProvider,
  DecisionProviderError,
  ENDPOINT_SENDER,
  type FirewallCheck,
  Message,
  MessageContext,
  type MessageMiddleware,
  projectFeedback,
  textMetadata,
  validateChecks,
} from "./check.js";
import {
  decodeBehavior,
  editableDocumentSchema,
  type FirewallConfiguration,
  firewallConfigurationSchema,
  type FirewallInstallation,
  FirewallPolicyError,
  type FirewallPolicyOperations,
  FirewallSettings,
  type LoadedMessagePolicy,
  MAXIMUM_BEHAVIOR_BYTES,
  MAXIMUM_EDITABLE_RULES,
  type PolicyAuthority,
  type PolicyProblem,
  policyReadSchema,
  policyUpdateSchema,
  PrivateCheckTrace,
  type RuleDescription,
  TextPolicySettings,
  TextRule,
} from "./config.js";
import { makeJevDecisionProvider } from "./jev.js";
import {
  type FirewallActivation,
  type FirewallLocalAdmission,
  type FirewallCompletion,
  type FirewallStore,
  readDecisions,
  withoutTraces,
} from "./store/index.js";

/** Fixed code and provider resources live for the process; owner tools edit only text rules. */
export interface FirewallOptions {
  readonly mode: "guidance" | "enforcement";
  readonly incoming: readonly MessageMiddleware[];
  readonly outgoing: readonly MessageMiddleware[];
  readonly settings: FirewallSettings;
  readonly facts: MessageContext["facts"];
  readonly codeDigest: string;
  readonly maximumHistoryRecords?: number;
  readonly maximumConcurrentChecks?: number;
  readonly text?: {
    readonly fixedRules?: readonly TextRule[];
    readonly initialRules?: readonly TextRule[];
    readonly provider: DecisionProvider;
    readonly settings: TextPolicySettings;
  };
}

/** The daemon supplies exact projected text and verified, authorized evidence. */
export interface PreparedFirewallCheck {
  readonly direction: "incoming" | "outgoing";
  readonly canonicalCandidate: Uint8Array;
  readonly message?: Message;
  readonly context: MessageContext;
  readonly agents: readonly AgentView[];
}

/** The caller commits the completion with the message's delivery disposition. */
export interface CheckedMessage {
  readonly completion: FirewallCompletion;
  readonly result: FirewallCheck;
  readonly guidance?: CheckedGuidance;
}

/** Checks capture active rules locally; one batch keeps the same rules for all its messages. */
export interface Firewall {
  readonly configuration: FirewallConfiguration;
  readonly policy: FirewallPolicyOperations;
  readonly check: (
    input: PreparedFirewallCheck,
  ) => Effect.Effect<CheckedMessage, EndpointStoreError>;
  readonly checkMany: (
    inputs: readonly PreparedFirewallCheck[],
  ) => Effect.Effect<readonly CheckedMessage[], EndpointStoreError>;
  readonly recordEndpoint: (
    input: PreparedFirewallCheck & { readonly message: Message },
  ) => Effect.Effect<
    NonNullable<FirewallLocalAdmission["deterministic"]>,
    EndpointStoreError
  >;
}

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
type PolicyEditPath = NonNullable<FirewallPolicyError["path"]>;
const invalidRule = (
  problem: PolicyProblem,
  at: { readonly path?: PolicyEditPath; readonly ruleId?: string } = {},
) => new FirewallPolicyError({ reason: "invalid-rule", problem, ...at });

/** Construction validates the complete policy before seeding a missing document. */
export const makeFirewall = Effect.fn("makeFirewall")(function* (
  source: FirewallOptions | LoadedMessagePolicy,
  store: FirewallStore,
): Effect.fn.Return<Firewall, FirewallPolicyError> {
  const options =
    "policy" in source ? yield* configuredOptions(source) : source;
  const captured = yield* captureOptions(options).pipe(
    Effect.catchTags({
      CheckInputError: () =>
        Effect.fail(new FirewallPolicyError({ reason: "build-failed" })),
      ParseError: () =>
        Effect.fail(new FirewallPolicyError({ reason: "build-failed" })),
    }),
    Effect.catchAllDefect(() =>
      Effect.fail(new FirewallPolicyError({ reason: "build-failed" })),
    ),
  );
  const fixed = yield* decodeFrozen(
    policyReadSchema.fields.fixedRules,
    fixedRules(captured),
  ).pipe(
    Effect.mapError(() => new FirewallPolicyError({ reason: "build-failed" })),
  );
  const fixedRuleIds = fixed.map((rule) => rule.id);
  const stored = yield* store
    .readFirewallPolicy()
    .pipe(Effect.mapError(persistenceFailure));
  const loadedRules =
    stored === undefined
      ? (captured.text?.initialRules ?? []).map((rule) => ({
          ...rule,
          owner: "owner" as const,
        }))
      : yield* decodeRuntimeValue(storedPolicySchema, stored).pipe(
          Effect.map((value) => value.rules),
          Effect.mapError(persistenceFailure),
        );
  const rules = yield* decodeFrozen(ownedRulesSchema, loadedRules).pipe(
    Effect.mapError(
      () =>
        new FirewallPolicyError({
          reason: stored === undefined ? "build-failed" : "persistence-failed",
        }),
    ),
  );
  yield* validateIds(rules, fixedRuleIds);
  const active = yield* buildPolicy(captured, rules);
  const state: PolicyState = { rules, active, fixedRuleIds };
  if (stored === undefined) yield* persistRules(store, rules);
  const edits = yield* Effect.makeSemaphore(1);
  const permits = yield* Effect.makeSemaphore(
    captured.configuration.maximumConcurrentChecks,
  );
  const policy: FirewallPolicyOperations = {
    read: () =>
      Effect.sync(() => ({
        rules: state.rules,
        fixedRules: fixed,
        activeRevision: state.active.configurationDigest,
      })),
    update: (request, authority) =>
      edits.withPermits(1)(
        updatePolicy(captured, store, state, { request, authority }),
      ),
    decisions: (request) =>
      readDecisions(store, request, textId).pipe(
        Effect.mapError(persistenceFailure),
      ),
  };
  const firewall: Firewall = {
    configuration: captured.configuration,
    policy,
    check: (input) =>
      Effect.suspend(() => {
        const current = state.active;
        return permits.withPermits(1)(assess(captured, current, store, input));
      }),
    checkMany: (inputs) =>
      Effect.suspend(() => {
        const current = state.active;
        return Effect.forEach(
          inputs,
          (input) =>
            permits.withPermits(1)(assess(captured, current, store, input)),
          { concurrency: captured.configuration.maximumConcurrentChecks },
        );
      }),
    recordEndpoint: (input) =>
      Effect.suspend(() => endpointRecord(captured, state.active, input)),
  };
  return Object.freeze(firewall);
});

function configuredOptions(loaded: LoadedMessagePolicy) {
  return Effect.gen(function* () {
    const policy = loaded.policy;
    const codeDigest = yield* digest({
      policy: {
        mode: policy.mode,
        settings: policy.settings,
        facts: policy.facts,
        decisionProvider: policy.decisionProvider ?? null,
        textSettings: policy.textSettings,
        maximumHistoryRecords: policy.maximumHistoryRecords ?? null,
        maximumConcurrentChecks: policy.maximumConcurrentChecks ?? null,
        fixedRules: policy.text?.fixedRules ?? [],
      },
      fixedBehaviorDigests: loaded.fixedBehaviorDigests ?? [],
    }).pipe(
      Effect.mapError(
        () => new FirewallPolicyError({ reason: "build-failed" }),
      ),
    );
    const provider: DecisionProvider =
      loaded.provider.kind === "jev"
        ? retryingTransientFailures(makeJevDecisionProvider(loaded.provider))
        : {
            decide: () =>
              Effect.fail(new DecisionProviderError({ reason: "transport" })),
          };
    return {
      mode: policy.mode,
      incoming: [],
      outgoing: [],
      settings: policy.settings,
      facts: policy.facts,
      codeDigest,
      ...(policy.maximumHistoryRecords === undefined
        ? {}
        : { maximumHistoryRecords: policy.maximumHistoryRecords }),
      ...(policy.maximumConcurrentChecks === undefined
        ? {}
        : { maximumConcurrentChecks: policy.maximumConcurrentChecks }),
      ...(policy.text === undefined
        ? {}
        : {
            text: {
              fixedRules: policy.text.fixedRules,
              initialRules: policy.text.initialRules,
              settings: policy.textSettings,
              provider,
            },
          }),
    } satisfies FirewallOptions;
  });
}

function captureOptions(options: FirewallOptions) {
  return Effect.gen(function* () {
    const configuration = yield* decodeFrozen(firewallConfigurationSchema, {
      mode: options.mode,
      facts: options.facts,
      codeDigest: options.codeDigest,
      maximumHistoryRecords: options.maximumHistoryRecords ?? 256,
      maximumConcurrentChecks: options.maximumConcurrentChecks ?? 4,
    });
    const settings = yield* decodeFrozen(FirewallSettings, options.settings);
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
    const selected = options.text;
    const text =
      selected === undefined
        ? undefined
        : {
            fixedRules: yield* decodeFrozen(
              Schema.Array(TextRule),
              selected.fixedRules ?? [],
            ),
            initialRules: yield* decodeFrozen(
              editableDocumentSchema,
              selected.initialRules ?? [],
            ),
            settings: yield* decodeFrozen(
              TextPolicySettings,
              selected.settings,
            ),
            provider: {
              decide: selected.provider.decide.bind(selected.provider),
              ...(selected.provider.provenance === undefined
                ? {}
                : {
                    provenance: yield* decodeFrozen(
                      PrivateCheckTrace,
                      selected.provider.provenance,
                    ),
                  }),
            },
          };
    return { configuration, settings, incoming, outgoing, text };
  });
}
type CapturedOptions = Effect.Effect.Success<ReturnType<typeof captureOptions>>;

function buildPolicy(options: CapturedOptions, rules: readonly OwnedRule[]) {
  return Effect.gen(function* () {
    const documents = [
      ...(options.text?.fixedRules ?? []),
      ...rules.map(Struct.omit("owner")),
    ];
    if (documents.length > 0 && options.text === undefined)
      return yield* new FirewallPolicyError({ reason: "not-configured" });
    const revision = yield* digest({
      rules: documents,
      settings: options.text?.settings ?? null,
    });
    const fixedRuleIds = (options.text?.fixedRules ?? []).map(
      (rule) => rule.id,
    );
    const runtimeRuleIds = rules
      .filter((rule) => rule.owner === "runtime")
      .map((rule) => rule.id);
    yield* validateChecks({
      incoming: options.incoming,
      outgoing: options.outgoing,
      rules: documents,
      settings: options.settings,
      revision,
      ...(options.text === undefined
        ? {}
        : { textSettings: options.text.settings }),
    });
    const text =
      documents.length === 0
        ? undefined
        : textMetadata({
            rules: documents,
            textSettings: options.text?.settings,
            provider: options.text?.provider,
            revision,
            fixedRuleIds,
            runtimeRuleIds,
          });
    const describe = ({
      id,
      revision,
      rules,
      provenance,
    }: MessageMiddleware) => ({
      id,
      revision,
      rules,
      provenance: provenance ?? {
        format: "unavailable",
        data: "No descriptive provenance was declared.",
      },
    });
    const metadata: FirewallInstallation = {
      configuration: options.configuration,
      settings: options.settings,
      incoming: [
        ...options.incoming.map(describe),
        ...(text === undefined ? [] : [text]),
      ],
      outgoing: [
        ...options.outgoing.map(describe),
        ...(text === undefined ? [] : [text]),
      ],
    };
    return {
      metadata,
      configurationDigest: yield* digest(metadata),
      rules: documents,
      revision,
      fixedRuleIds,
      runtimeRuleIds,
    };
  }).pipe(
    Effect.catchTags({
      CheckInputError: () =>
        Effect.fail(new FirewallPolicyError({ reason: "build-failed" })),
      EndpointStoreError: () =>
        Effect.fail(new FirewallPolicyError({ reason: "build-failed" })),
    }),
    Effect.catchAllDefect(() =>
      Effect.fail(new FirewallPolicyError({ reason: "build-failed" })),
    ),
  );
}
type ActiveRules = Effect.Effect.Success<ReturnType<typeof buildPolicy>>;
interface PolicyState {
  rules: readonly OwnedRule[];
  readonly fixedRuleIds: readonly string[];
  active: ActiveRules;
}

function digest(value: unknown) {
  return encodeRuntimeValue(value).pipe(
    Effect.map((bytes) => createHash("sha256").update(bytes).digest("hex")),
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
    ...[...options.incoming, ...options.outgoing].flatMap((middleware) =>
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

/** Only transient transport, rate-limit and server failures share the stage's bounded retry window. */
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
          while: (error) =>
            error.reason === "transport" ||
            (error.reason === "http" &&
              ((error.status ?? 0) === 429 || (error.status ?? 0) >= 500)),
        }),
      ),
  };
}

/** The retained input and the evaluator receive the same captured message and evidence. */
function capturePrepared(
  configuration: FirewallConfiguration,
  input: PreparedFirewallCheck,
) {
  return Effect.gen(function* () {
    const context = yield* decodeFrozen(MessageContext, {
      ...input.context,
      facts: configuration.facts,
    });
    const message =
      input.message === undefined
        ? undefined
        : yield* decodeFrozen(Message, input.message);
    const agents = yield* decodeFrozen(Schema.Array(AgentView), input.agents);
    return {
      direction: input.direction,
      canonicalCandidate: input.canonicalCandidate.slice(),
      context,
      agents,
      ...(message === undefined ? {} : { message }),
    };
  }).pipe(
    Effect.catchTag("ParseError", () =>
      Effect.fail(new EndpointStoreError({ reason: "corrupt" })),
    ),
  );
}

/** Recording starts before inference; the daemon commits the returned disposition with delivery. */
const assess = Effect.fn("assessMessage")(function* (
  options: CapturedOptions,
  active: ActiveRules,
  store: FirewallStore,
  requested: PreparedFirewallCheck,
) {
  const input = yield* capturePrepared(options.configuration, requested);
  const checkId = mintCheckId();
  yield* store.beginFirewallAttempt({
    checkId,
    direction: input.direction,
    canonicalCandidate: input.canonicalCandidate,
    canonicalInput: yield* retainedInput(active, input),
  });
  const assessed = yield* (
    input.message === undefined
      ? Effect.succeed(unavailable())
      : checkMessage({
          event: { direction: input.direction, message: input.message },
          context: input.context,
          code: options[input.direction],
          rules: active.rules,
          settings: options.settings,
          revision: active.revision,
          fixedRuleIds: active.fixedRuleIds,
          runtimeRuleIds: active.runtimeRuleIds,
          ...(options.text === undefined
            ? {}
            : {
                textSettings: options.text.settings,
                provider: options.text.provider,
              }),
        }).pipe(
          Effect.catchTag("CheckInputError", () =>
            Effect.succeed(unavailable()),
          ),
        )
  ).pipe(
    markRetries("firewall-check", input.direction, (exit) =>
      exitOutcome(exit, "checked"),
    ),
  );
  const projection = yield* guidanceProjection(assessed, input, {
    mode: options.configuration.mode,
    checkId,
  });
  const admit =
    options.configuration.mode === "guidance" ||
    projection.result.judgment === "allow";
  return {
    result: projection.result,
    completion: {
      checkId,
      admit,
      canonicalResult: yield* encodeRuntimeValue(
        withoutTraces(projection.result),
      ),
    },
    ...(admit && projection.guidance !== undefined
      ? { guidance: projection.guidance }
      : {}),
  } satisfies CheckedMessage;
});

/** Endpoint-authored local items retain an audit in the caller's atomic publication transaction. */
function endpointRecord(
  options: CapturedOptions,
  active: ActiveRules,
  requested: PreparedFirewallCheck & { readonly message: Message },
) {
  return Effect.gen(function* () {
    const input = yield* capturePrepared(options.configuration, requested);
    return {
      checkId: mintCheckId(),
      direction: input.direction,
      canonicalCandidate: input.canonicalCandidate,
      canonicalInput: yield* retainedInput(active, input),
      canonicalResult: yield* encodeRuntimeValue({
        judgment: "allow",
        reason: "eligible",
        feedback: [],
        guidance: [],
        checks: [],
      }),
    } satisfies NonNullable<FirewallLocalAdmission["deterministic"]>;
  });
}

function retainedInput(active: ActiveRules, input: PreparedFirewallCheck) {
  return encodeRuntimeValue({
    configurationDigest: active.configurationDigest,
    installation: active.metadata,
    context: input.context,
    agents: input.agents,
    message: input.message ?? null,
  });
}

/** A local reference correlates an assessment without granting lookup authority. */
function mintCheckId() {
  return `chk_${randomBytes(32).toString("hex")}`;
}

/** Missing or invalid assessment input holds without inventing a deciding rule. */
function unavailable(): FirewallCheck {
  return {
    judgment: "hold",
    reason: "check-unavailable",
    feedback: projectFeedback([], [], "check-unavailable"),
    guidance: [],
    checks: [],
  };
}

/** Registered advice includes only the message references already visible to this agent. */
function guidanceProjection(
  result: FirewallCheck,
  input: PreparedFirewallCheck,
  capture: {
    readonly mode: "guidance" | "enforcement";
    readonly checkId: string;
  },
) {
  return Effect.gen(function* () {
    const instructions =
      input.direction === "incoming" || capture.mode === "guidance"
        ? result.guidance
        : result.guidance.filter((entry) => "uncertain" in entry);
    if (instructions.length === 0) return { result };
    const selected = new Set(
      instructions.flatMap((entry) =>
        "subjects" in entry ? entry.subjects : [],
      ),
    );
    const subjects = guidanceSubjects(selected, input);
    const guidance: CheckedGuidance = {
      checkId: capture.checkId,
      instructions,
      subjects,
    };
    const bytes = yield* encodeRuntimeValue(guidance);
    return subjects.length !== selected.size ||
      bytes.byteLength + input.canonicalCandidate.byteLength >
        MAXIMUM_RUNTIME_ITEM_BYTES
      ? { result: { ...unavailable(), checks: result.checks } }
      : { result, guidance };
  });
}

function guidanceSubjects(
  selected: ReadonlySet<string>,
  input: PreparedFirewallCheck,
): CheckedGuidance["subjects"] {
  const agents = new Map<string, AgentView>(
    input.agents.map((agent) => [agent.agentId, agent]),
  );
  const available = input.context.history.filter(
    (entry) => entry.visibility === "runtime" && entry.admission === "admitted",
  );
  const subjects = new Map(
    [...available, ...(input.message === undefined ? [] : [input.message])].map(
      (entry) => [entry.id, entry],
    ),
  );
  return [...subjects.values()]
    .filter((entry) => selected.has(entry.id))
    .flatMap((entry) => {
      const sender =
        entry.sender === ENDPOINT_SENDER
          ? ENDPOINT_SENDER
          : agents.get(entry.sender);
      const recipients = entry.recipients.flatMap((identity) => {
        const agent = agents.get(identity);
        return agent === undefined ? [] : [agent];
      });
      return sender === undefined ||
        recipients.length !== entry.recipients.length
        ? []
        : [{ id: entry.id, sender, recipients, text: entry.text }];
    });
}
