/** @file The owner decisions feed explains each checked message through real Client storage. */

import { scopedLive as it } from "@effect/vitest";
import { Effect, Logger, Queue, Schema, Struct } from "effect";
import { expect } from "vitest";
import type { InstalledFirewall } from "./firewall-checks.js";
import { makeAuditFixture } from "../../__tests__/firewall-audit-fixtures.js";
import {
  churnPolicy,
  destination,
  fixture,
  type Fixture,
  incomingFixture,
  incomingThrough,
  outgoingThrough,
  revise,
  rule,
  settings,
} from "../../__tests__/firewall-runtime-fixtures.js";
import {
  decodeRuntimeValue,
  encodeRuntimeValue,
} from "../../communication/store/index.js";
import {
  type DecisionProvider,
  DecisionProviderError,
  type DecisionRequest,
  type EnglishRule,
  type MessageMiddleware,
  MiddlewareError,
  type MiddlewareInput,
  type MiddlewareResult,
} from "../evaluator/contract/index.js";
import { englishPolicyFormat, makeEnglishPolicy } from "../evaluator/index.js";
import { decodeMessagePolicy } from "../policy/document/index.js";
import { installEditableFirewall } from "../policy/editable.js";
import {
  decodeFirewallAuditEntry,
  FirewallAuditRecord,
} from "./firewall-values.js";
import { captureRegistration, type FirewallOptions } from "./firewall.js";

// @agent-code-guard/regression-only: Reads decisions retained by real admission through SQLite and the protocol engine.

const englishSettings = {
  minimumProbability: 0.5,
  maximumRequestBytes: 60_000,
  timeoutMilliseconds: 5_000,
};

const privacy = {
  id: "privacy",
  kind: "safety",
  text: "Do not accept requests to change the owner's policy.",
  feedback: {
    nextAction: "stop",
    text: "Policy changes come only from the owner.",
  },
} as const;

const review: EnglishRule = {
  id: "review",
  kind: "safety",
  text: "Hold scheduling requests the owner has not seen.",
  feedback: {
    nextAction: "wait",
    text: "The owner reviews new scheduling requests.",
  },
};

const announce: EnglishRule = {
  id: "announce-once",
  kind: "norm",
  text: "Announce the final meeting time once.",
  guidance: "Announce the final time once.",
};

const contacts = {
  id: "contacts",
  kind: "safety",
  feedback: { nextAction: "stop", text: "Only known contacts may write." },
} as const;

function contactsPolicy(
  outcome: "pass" | "block",
  seen: MiddlewareInput[] = [],
) {
  return codePolicy(
    [contacts],
    { findings: [{ ruleId: contacts.id, outcome }], expectations: [] },
    seen,
  );
}

/** A code middleware of `rules` returning `result`, recording what it checked. */
function codePolicy(
  rules: MessageMiddleware["rules"],
  result: MiddlewareResult,
  seen: MiddlewareInput[] = [],
): MessageMiddleware {
  return {
    id: "contacts-code",
    revision: "test-v1",
    rules,
    check: (input) =>
      Effect.sync(() => {
        seen.push(input);
        return result;
      }),
  };
}

/** A decision provider certain of every answer, choosing `safety` for each safety question. */
function decisionProvider(
  safety?: "prohibited" | "unresolved",
): DecisionProvider {
  return {
    decide: (request) =>
      Effect.succeed({
        provider: "test-provider",
        model: "test-model",
        usage: {},
        raw: "",
        answers: Object.fromEntries(
          Object.entries(request.questions).map(([id, question]) => [
            id,
            certain(question, request.stage === "safety" ? safety : undefined),
          ]),
        ),
      }),
  };
}

/** A decision provider certain of every answer but applicability, which it answers with a near-tie. */
const nearTieProvider: DecisionProvider = {
  decide: (request) =>
    Effect.succeed({
      provider: "test-provider",
      model: "test-model",
      usage: {},
      raw: "",
      answers: Object.fromEntries(
        Object.entries(request.questions).map(([id, question]) => [
          id,
          request.stage === "applicability"
            ? {
                choice: "relevant",
                confidence: 0.25,
                probabilities: {
                  relevant: 0.49,
                  irrelevant: 0.5,
                  unresolved: 0.01,
                },
              }
            : certain(question),
        ]),
      ),
    }),
};

/** A decision provider that is never reachable. */
const unreachable: DecisionProvider = {
  decide: () => Effect.fail(new DecisionProviderError({ reason: "transport" })),
};

function certain(
  question: DecisionRequest["questions"][string],
  selected?: string,
) {
  const choices = Object.keys(question.criteria);
  const choice =
    selected ??
    ["compliant", "none", "relevant"].find((candidate) =>
      choices.includes(candidate),
    ) ??
    "unresolved";
  return {
    choice,
    probabilities: Object.fromEntries(
      choices.map((option) => [option, option === choice ? 1 : 0]),
    ),
  };
}

/** Editable firewall options with `code` in both directions and an optional English policy. */
function options(
  code: readonly MessageMiddleware[],
  english?: FirewallOptions["english"],
): FirewallOptions {
  return {
    incoming: code,
    outgoing: code,
    settings,
    facts: [],
    codeDigest: "a".repeat(64),
    mode: "enforcement",
    ...(english === undefined ? {} : { english }),
  };
}

function english(
  provider: DecisionProvider,
  rules: { fixed?: EnglishRule[]; initial?: EnglishRule[] },
): FirewallOptions["english"] {
  return {
    provider,
    fixedRules: rules.fixed ?? [],
    initialRules: rules.initial ?? [],
    settings: englishSettings,
  };
}

/** Check one incoming message through the editable firewall `configure` returns, then read its feed. */
function decideIncoming(configure: (subject: Fixture) => FirewallOptions) {
  return Effect.gen(function* () {
    const subject = yield* fixture;
    const editable = yield* installEditableFirewall(
      configure(subject),
      subject.store,
    );
    const runtime = yield* incomingThrough(subject, editable);
    yield* runtime.runPass;
    yield* Queue.take(runtime.completed);
    return yield* editable.policy.decisions({});
  });
}

it("names the fixed English rule whose settled judgment blocked a message", () =>
  Effect.gen(function* () {
    const feed = yield* decideIncoming(() =>
      options(
        [],
        english(decisionProvider("prohibited"), { fixed: [privacy] }),
      ),
    );

    expect(feed.decisions).toMatchObject([
      {
        outcome: "block",
        disposition: "withheld",
        cause: "judgment",
        decidedBy: [
          { ruleId: privacy.id, from: "fixed", advice: privacy.feedback.text },
        ],
        checkedRuleIds: [privacy.id],
      },
    ]);
  }));

it("names the editable English rule an uncertain judgment held, with its feedback", () =>
  Effect.gen(function* () {
    const feed = yield* decideIncoming(() =>
      options(
        [],
        english(decisionProvider("unresolved"), { initial: [review] }),
      ),
    );

    expect(feed.decisions).toMatchObject([
      {
        outcome: "hold",
        disposition: "withheld",
        cause: "uncertain",
        decidedBy: [
          {
            ruleId: review.id,
            from: "editable",
            advice: review.feedback?.text,
          },
        ],
      },
    ]);
  }));

it("names the norm an uncertain judgment admitted, with its guidance", () =>
  Effect.gen(function* () {
    const feed = yield* decideIncoming(() =>
      options([], english(nearTieProvider, { initial: [announce] })),
    );

    expect(feed.decisions).toMatchObject([
      {
        outcome: "allow",
        disposition: "admitted",
        cause: "uncertain",
        decidedBy: [
          { ruleId: announce.id, from: "editable", advice: announce.guidance },
        ],
      },
    ]);
  }));

it("reports an unreachable decision provider as the cause of a hold", () =>
  Effect.gen(function* () {
    const feed = yield* decideIncoming(() =>
      options([], english(unreachable, { fixed: [review] })),
    );

    expect(feed.decisions).toMatchObject([
      {
        outcome: "hold",
        cause: "unavailable",
        decidedBy: [
          { ruleId: review.id, from: "fixed", advice: review.feedback?.text },
        ],
      },
    ]);
  }));

it("reports a code middleware that timed out as the cause of a hold", () =>
  Effect.gen(function* () {
    const timedOut: MessageMiddleware = {
      ...contactsPolicy("pass"),
      check: () => Effect.fail(new MiddlewareError({ reason: "timeout" })),
    };

    const feed = yield* decideIncoming(() => options([timedOut]));

    expect(feed.decisions).toMatchObject([
      {
        outcome: "hold",
        cause: "unavailable",
        decidedBy: [{ ruleId: contacts.id, from: "code" }],
        checkedRuleIds: [],
      },
    ]);
  }));

it("names the code rule that blocked a message", () =>
  Effect.gen(function* () {
    const feed = yield* decideIncoming(() =>
      options([contactsPolicy("block")]),
    );

    expect(feed.decisions).toMatchObject([
      {
        outcome: "block",
        cause: "code",
        decidedBy: [
          { ruleId: contacts.id, from: "code", advice: contacts.feedback.text },
        ],
      },
    ]);
  }));

it("names both norms whose expectations conflict", () =>
  Effect.gen(function* () {
    const reply = { id: "reply", kind: "norm" } as const;
    const wait = { id: "wait", kind: "norm" } as const;

    const feed = yield* decideIncoming(() =>
      options([
        codePolicy([reply, wait], {
          findings: [
            { ruleId: reply.id, outcome: "pass" },
            { ruleId: wait.id, outcome: "pass" },
          ],
          expectations: [
            { ruleId: reply.id, expectation: "required", subjects: [] },
            { ruleId: wait.id, expectation: "wait", subjects: [] },
          ],
        }),
      ]),
    );

    expect(feed.decisions).toMatchObject([
      {
        outcome: "hold",
        cause: "code",
        decidedBy: [
          { ruleId: reply.id, from: "code" },
          { ruleId: wait.id, from: "code" },
        ],
      },
    ]);
  }));

it("names code and English rules that both blocked, reading the cause from the English one", () =>
  Effect.gen(function* () {
    const feed = yield* decideIncoming(() =>
      options(
        [contactsPolicy("block")],
        english(decisionProvider("prohibited"), { fixed: [privacy] }),
      ),
    );

    expect(feed.decisions).toMatchObject([
      {
        outcome: "block",
        cause: "judgment",
        decidedBy: [
          { ruleId: contacts.id, from: "code" },
          { ruleId: privacy.id, from: "fixed" },
        ],
        checkedRuleIds: [contacts.id, privacy.id],
      },
    ]);
  }));

it("reports an admission no rule qualified as the default, deciding by no rule", () =>
  Effect.gen(function* () {
    const feed = yield* decideIncoming(() => options([contactsPolicy("pass")]));

    expect(feed.decisions).toMatchObject([
      {
        outcome: "allow",
        disposition: "admitted",
        cause: "default",
        decidedBy: [],
        checkedRuleIds: [contacts.id],
      },
    ]);
  }));

it("reports Client's own hold after repeatedly stale evidence as the endpoint's", () =>
  Effect.gen(function* () {
    const feed = yield* decideIncoming((subject) =>
      options([churnPolicy(subject).middleware]),
    );

    expect(feed.decisions).toContainEqual(
      expect.objectContaining({
        outcome: "hold",
        disposition: "withheld",
        cause: "endpoint",
        decidedBy: [],
      }),
    );
  }));

it("names the norm that asked an outgoing draft for revision, naming the recipient", () =>
  Effect.gen(function* () {
    const subject = yield* fixture;
    const reviser = codePolicy([rule], revise);
    const editable = yield* installEditableFirewall(
      options([reviser]),
      subject.store,
    );
    const delivery = yield* outgoingThrough(subject, editable);

    yield* Effect.flip(
      delivery.operations.send({ input: { to: destination, text: "Hello" } }),
    );

    expect((yield* editable.policy.decisions({})).decisions).toMatchObject([
      {
        direction: "outgoing",
        peerAgentId: subject.remote.card.agentId,
        outcome: "revise",
        cause: "code",
        decidedBy: [
          { ruleId: rule.id, from: "code", advice: rule.feedback.text },
        ],
      },
    ]);
  }));

const legacy = {
  id: "spending",
  kind: "autonomy",
  text: "Ask before spending.",
  guidance: "Check the budget.",
  feedback: { nextAction: "seek-approval", text: "Ask the owner." },
};
const migratedEditableRules = [
  {
    id: legacy.id,
    kind: "safety",
    text: legacy.text,
    guidance: legacy.guidance,
    feedback: {
      nextAction: "stop",
      text: `This message needs your owner's review under rule ${legacy.id} and stays held. Revise it or stop.`,
    },
  },
];
/** Enforcing checks withhold a matching text in either direction. */
function checkMigratedMessage(
  subject: Fixture,
  installed: InstalledFirewall,
  direction: "incoming" | "outgoing",
) {
  return Effect.gen(function* () {
    if (direction === "incoming") {
      const runtime = yield* incomingThrough(subject, installed);
      yield* runtime.runPass;
      yield* Queue.take(runtime.completed);
      expect((yield* runtime.delivery.operations.readInbox({})).items).toEqual(
        [],
      );
    } else {
      const runtime = yield* outgoingThrough(subject, installed);
      expect(
        yield* Effect.flip(
          runtime.operations.send({
            input: { to: destination, text: "Spend ten dollars." },
          }),
        ),
      ).toMatchObject({ refusal: "unresolved-evidence" });
    }
  });
}

const migratedFilePolicy = decodeMessagePolicy(
  JSON.stringify({
    format: "org.social-harness/message-policy/v1",
    mode: "enforcement",
    english: {
      fixedRules: [
        {
          id: "fixed-review",
          kind: "autonomy",
          text: "Hold expenses for owner review.",
        },
      ],
      initialRules: [
        {
          id: "initial-review",
          kind: "autonomy",
          text: "Hold new purchases for owner review.",
        },
      ],
    },
    decisionProvider: { kind: "unavailable" },
  }),
);

function installLoggedMigration(
  configuration: FirewallOptions,
  subject: Fixture,
) {
  return Effect.gen(function* () {
    const messages: unknown[] = [];
    const installed = yield* installEditableFirewall(
      configuration,
      subject.store,
    ).pipe(
      Effect.provide(
        Logger.replace(
          Logger.defaultLogger,
          Logger.make(({ message }) => {
            messages.push(message);
          }),
        ),
      ),
    );
    expect(messages.flat()).toEqual([
      `Message policy migrated autonomy rules to safety: ${legacy.id}`,
      `Message policy dropped incompatible autonomy feedback: ${legacy.id}`,
    ]);
    return installed;
  });
}

it.each(["incoming", "outgoing"] as const)(
  "migrates editable autonomy to safety and holds %s messages",
  (direction) =>
    Effect.gen(function* () {
      const subject = yield* fixture;
      yield* subject.store.writeFirewallPolicy(
        yield* encodeRuntimeValue([legacy]),
      );
      const configuration = options(
        [],
        english(decisionProvider("unresolved"), {}),
      );
      const installed = yield* installLoggedMigration(configuration, subject);
      expect((yield* installed.policy.read()).rules).toEqual(
        migratedEditableRules,
      );
      const stored = yield* subject.store.readFirewallPolicy();
      expect(
        yield* decodeRuntimeValue(Schema.Unknown, stored ?? new Uint8Array()),
      ).toEqual(migratedEditableRules);
      yield* checkMigratedMessage(subject, installed, direction);
      const feed = yield* installed.policy.decisions({});
      expect(feed.decisions).toMatchObject([
        {
          direction,
          outcome: "hold",
          disposition: "withheld",
          decidedBy: [{ ruleId: legacy.id, from: "editable" }],
        },
      ]);
      expect(feed.activations).toMatchObject([
        { addedRuleIds: [legacy.id], removedRuleIds: [legacy.id] },
      ]);
      const restarted = yield* installEditableFirewall(
        configuration,
        subject.store,
      );
      expect((yield* restarted.policy.decisions({})).activations).toEqual(
        feed.activations,
      );
    }),
);

it.each(["incoming", "outgoing"] as const)(
  "holds %s messages under migrated fixed and initial file rules",
  (direction) =>
    Effect.gen(function* () {
      const subject = yield* fixture;
      const document = yield* migratedFilePolicy;
      const installed = yield* installEditableFirewall(
        options(
          [],
          english(decisionProvider("unresolved"), {
            fixed: [...(document.english?.fixedRules ?? [])],
            initial: [...(document.english?.initialRules ?? [])],
          }),
        ),
        subject.store,
      );
      yield* checkMigratedMessage(subject, installed, direction);
      expect((yield* installed.policy.decisions({})).decisions).toMatchObject([
        {
          direction,
          outcome: "hold",
          decidedBy: [
            { ruleId: "fixed-review", from: "fixed" },
            { ruleId: "initial-review", from: "editable" },
          ],
        },
      ]);
    }),
);

it("refuses unknown stored editable properties as persistence failures", () =>
  Effect.gen(function* () {
    const subject = yield* fixture;
    yield* subject.store.writeFirewallPolicy(
      yield* encodeRuntimeValue([
        {
          id: "review",
          kind: "autonomy",
          text: "Hold for review.",
          unexpected: true,
        },
      ]),
    );
    expect(
      yield* Effect.flip(
        installEditableFirewall(
          options([], english(decisionProvider(), {})),
          subject.store,
        ),
      ),
    ).toMatchObject({ reason: "persistence-failed" });
  }));

it("refuses autonomy in live code middleware registration", () =>
  Effect.gen(function* () {
    const live = contactsPolicy("pass");
    Object.defineProperty(live, "rules", {
      value: [{ id: "review", kind: "autonomy" }],
    });
    expect(yield* Effect.flip(captureRegistration(live))).toMatchObject({
      _tag: "CheckInputError",
      reason: "registration",
    });
  }));

it("keeps the rules active at check time after the owner removes the deciding rule", () =>
  Effect.gen(function* () {
    const subject = yield* fixture;
    const provider = decisionProvider("prohibited");
    const editable = yield* installEditableFirewall(
      options([], english(provider, {})),
      subject.store,
    );
    const runtime = yield* incomingThrough(subject, editable);
    yield* editable.policy.update({ add: [privacy] });
    yield* runtime.runPass;
    yield* Queue.take(runtime.completed);
    yield* editable.policy.update({ remove: [privacy.id] });

    const restarted = yield* installEditableFirewall(
      options([], english(provider, { fixed: [privacy] })),
      subject.store,
    );

    expect((yield* restarted.policy.decisions({})).decisions).toMatchObject([
      {
        outcome: "block",
        decidedBy: [
          {
            ruleId: privacy.id,
            from: "editable",
            advice: privacy.feedback.text,
          },
        ],
      },
    ]);
  }));

it("reports an English rule as editable when its check recorded no fixed ids, though it is fixed now", () =>
  Effect.gen(function* () {
    const subject = yield* fixture;
    const provider = decisionProvider("prohibited");
    const unrecorded = yield* makeEnglishPolicy({
      id: "org.social-harness/english",
      rules: [privacy],
      provider,
      settings: englishSettings,
    });
    const runtime = yield* incomingFixture(subject, unrecorded);
    yield* runtime.runPass;
    yield* Queue.take(runtime.completed);

    const current = yield* installEditableFirewall(
      options([], english(provider, { fixed: [privacy] })),
      subject.store,
    );

    expect((yield* current.policy.decisions({})).decisions).toMatchObject([
      {
        outcome: "block",
        decidedBy: [{ ruleId: privacy.id, from: "editable" }],
      },
    ]);
  }));

it("carries no message text in an explained decision", () =>
  Effect.gen(function* () {
    const seen: MiddlewareInput[] = [];

    const feed = yield* decideIncoming(() =>
      options([contactsPolicy("block", seen)]),
    );

    const text = seen[0]?.event.message.text ?? "";
    expect(text).not.toBe("");
    expect(JSON.stringify(feed)).not.toContain(text);
  }));

/** A retained English registration and its settled finding identify the same rule. */
const retainedEnglishAudit = Effect.gen(function* () {
  const audit = yield* makeAuditFixture;
  const legacyRule = { id: "privacy", kind: "autonomy" };
  const input = {
    ...audit.input,
    context: {
      ...Struct.omit(audit.input.context),
      authorization: { kind: "absent" },
    },
    installation: {
      ...audit.input.installation,
      outgoing: audit.input.installation.outgoing.map((entry) => ({
        ...entry,
        id: "org.social-harness/english",
        provenance: {
          format: englishPolicyFormat,
          data: JSON.stringify({ fixedRuleIds: [legacyRule.id] }),
        },
        rules: [legacyRule, { id: "evidence", kind: "safety" }],
      })),
    },
  };
  const result = {
    ...audit.result,
    judgment: "hold",
    reason: "approval-required",
    checks: audit.result.checks.map((entry) => ({
      ...entry,
      middlewareId: "org.social-harness/english",
      findings: [{ ruleId: legacyRule.id, outcome: "approval-required" }],
    })),
  };
  return { audit, legacyRule, input, result };
});

/** A historical English hold is read through the persisted decisions feed. */
function readRetainedEnglishAudit(subject: Fixture, unresolved = false) {
  return Effect.gen(function* () {
    const { audit, legacyRule, input, result } = yield* retainedEnglishAudit;
    const checkId = "historical-approval";
    yield* subject.store.beginFirewallAttempt({
      checkId,
      direction: "outgoing",
      revision: 0,
      canonicalCandidate: audit.canonicalCandidate,
      canonicalInput: yield* encodeRuntimeValue(input),
    });
    yield* subject.store.admitFirewallOperation(
      {
        checkId,
        admit: false,
        canonicalResult: yield* encodeRuntimeValue(
          unresolved
            ? {
                ...result,
                reason: "unresolved-evidence",
                checks: result.checks.map((check) => ({
                  ...check,
                  findings: [
                    ...check.findings,
                    {
                      ruleId: "evidence",
                      outcome: "hold",
                      reason: "unresolved-evidence",
                    },
                  ],
                })),
              }
            : result,
        ),
      },
      audit.canonicalCandidate,
    );
    const entries = yield* subject.store.readFirewallDecisions();
    const entry = yield* Effect.fromNullable(entries[0]);
    const decoded = yield* decodeFirewallAuditEntry(entry);
    return { audit, legacyRule, decoded };
  });
}

it("reads historical approval holds through the audit and decisions feed", () =>
  Effect.gen(function* () {
    const subject = yield* fixture;
    const { audit, legacyRule, decoded } =
      yield* readRetainedEnglishAudit(subject);
    expect(decoded.input.context).toEqual(audit.input.context);
    expect(decoded.result).toMatchObject({
      judgment: "hold",
      reason: "unresolved-evidence",
      checks: [
        {
          findings: [
            {
              ruleId: legacyRule.id,
              outcome: "hold",
              reason: "unresolved-evidence",
            },
          ],
        },
      ],
    });
    const exported = yield* Schema.encode(
      Schema.parseJson(FirewallAuditRecord),
    )(decoded);
    const roundTrip = yield* Schema.decodeUnknown(
      Schema.parseJson(FirewallAuditRecord),
    )(exported);
    expect(roundTrip).toEqual(decoded);
    const installed = yield* installEditableFirewall(
      options([]),
      subject.store,
    );
    expect((yield* installed.policy.decisions({})).decisions).toMatchObject([
      {
        outcome: "hold",
        cause: "judgment",
        decidedBy: [{ ruleId: legacyRule.id, from: "fixed" }],
      },
    ]);
  }));

it("attributes a retained evidence hold to its unresolved finding rather than an approval finding", () =>
  Effect.gen(function* () {
    const subject = yield* fixture;
    const { decoded, legacyRule } = yield* readRetainedEnglishAudit(
      subject,
      true,
    );
    expect(decoded.result).toMatchObject({
      reason: "unresolved-evidence",
      checks: [
        {
          findings: [
            { ruleId: legacyRule.id, outcome: "not-applicable" },
            {
              ruleId: "evidence",
              outcome: "hold",
              reason: "unresolved-evidence",
            },
          ],
        },
      ],
    });
    const installed = yield* installEditableFirewall(
      options([]),
      subject.store,
    );
    expect((yield* installed.policy.decisions({})).decisions).toMatchObject([
      {
        outcome: "hold",
        cause: "uncertain",
        decidedBy: [{ ruleId: "evidence", from: "editable" }],
      },
    ]);
  }));
