/** @file Natural-language middleware behavior through the public firewall API. */

import { effect as it } from "@effect/vitest";
import {
  Cause,
  Deferred,
  Effect,
  Array as EffectArray,
  Exit,
  FastCheck as fc,
  Fiber,
  Schema,
  TestClock,
} from "effect";
import { expect } from "vitest";
import {
  type DecisionProvider,
  DecisionProviderError,
  type DecisionRequest,
  type DecisionResponse,
  decodeMessagePolicy,
  makeFirewall,
  makeTextPolicy,
  type Message,
  type MessageContext,
  type TextPolicySettings,
  type TextRule,
} from "../../daemon/index.js";

/* eslint-disable agent-code-guard/no-hardcoded-assertion-literals -- Closed judgments, stages and next actions are the public contract under test. */

const privateEvidence = "PRIVATE: unrelated medical appointment at 14:00";
const repair =
  "Ask for acceptance of the chosen proposal. Do not claim agreement yet.";
const reminder =
  "After proposing a time, wait for every required participant to accept that proposal.";
const draft: typeof Message.Encoded = {
  id: "draft",
  sender: "organizer-agent",
  recipients: ["participant-agent"],
  text: "The meeting is confirmed; everyone agreed.",
};
const context: typeof MessageContext.Encoded = {
  agentId: "organizer-agent",
  principal: "organizer",
  participants: [{ agentId: "participant-agent", principal: "participant" }],
  history: [
    {
      id: "availability",
      sender: "participant-agent",
      recipients: ["organizer-agent"],
      text: "I am free Tuesday.",
      visibility: "runtime",
      admission: "admitted",
    },
  ],
  facts: [
    {
      id: "private-calendar",
      source: "owner-calendar",
      text: privateEvidence,
      visibility: "assessor",
    },
  ],
  gaps: [],
};
const proposalAcceptance: TextRule = {
  id: "proposal-acceptance",
  kind: "norm",
  text: "Availability is not acceptance. Everyone must accept the same concrete proposal before it is finalized.",
  guidance: reminder,
  feedback: { text: repair, nextAction: "revise" },
};
const rules: readonly TextRule[] = [
  {
    id: "privacy",
    kind: "safety",
    text: "Do not disclose unrelated private appointments.",
  },
  proposalAcceptance,
];
/** One answer exactly as a provider reports it. */
type Answer = DecisionResponse["answers"][string];

const settings: typeof TextPolicySettings.Encoded = {
  minimumProbability: 0.5,
  maximumRequestBytes: 60_000,
  timeoutMilliseconds: 100,
};
const firewallSettings = {
  timeoutMilliseconds: 2_000,
  middlewareTimeoutMilliseconds: 1_000,
  maximumInputBytes: 300_000,
  maximumResultBytes: 1_000_000,
};
/** Each generated example runs two full chains alongside other CI workers. */
const propertyTimeoutMilliseconds = 15_000;

/**
 * A provider's answers: each question keyed in `choices` by
 * `stage:ruleId:purpose[:subject]` takes that choice with certainty, or the
 * full answer given there, and every other question its default choice.
 */
function responseFor(
  request: DecisionRequest,
  choices: Readonly<Record<string, string | Answer>> = {},
): typeof DecisionResponse.Encoded {
  return {
    provider: "test-decisions",
    model: "test-model",
    raw: privateEvidence,
    usage: {},
    answers: Object.fromEntries(
      Object.entries(request.questions).map(([id, question]) => {
        const fallback =
          ["compliant", "none", "relevant"].find((choice) =>
            Object.hasOwn(question.criteria, choice),
          ) ?? "unresolved";
        const selected =
          choices[
            `${request.stage}:${question.ruleId}:${question.purpose}:${question.subject ?? ""}`
          ] ??
          choices[`${request.stage}:${question.ruleId}:${question.purpose}`] ??
          fallback;
        if (typeof selected !== "string") {
          return [id, selected];
        }
        return [
          id,
          {
            choice: selected,
            probabilities: Object.fromEntries(
              Object.keys(question.criteria).map((choice) => [
                choice,
                choice === selected ? 1 : 0,
              ]),
            ),
          },
        ];
      }),
    ),
  };
}

function provider(
  choices: Readonly<Record<string, string | Answer>> = {},
  requests: DecisionRequest[] = [],
): DecisionProvider {
  return {
    decide: (request) =>
      Effect.sync(() => {
        requests.push(request);
        return responseFor(request, choices);
      }),
  };
}

const defaultProvider = provider();

/** The norms a request's state hands the decision provider. */
const statedNorms = Schema.parseJson(
  Schema.Struct({
    norms: Schema.Array(Schema.Struct({ ruleId: Schema.String })),
  }),
);

const check = (
  decisions: DecisionProvider = defaultProvider,
  options: {
    readonly message?: Message;
    readonly context?: MessageContext;
    readonly rules?: readonly TextRule[];
    readonly settings?: TextPolicySettings;
    readonly incoming?: boolean;
  } = {},
) =>
  Effect.gen(function* () {
    const text = yield* makeTextPolicy({
      id: "owner",
      rules: options.rules ?? rules,
      provider: decisions,
      settings: options.settings ?? settings,
    });
    const firewall = yield* makeFirewall({
      incoming: [text],
      outgoing: [text],
      settings: firewallSettings,
    });
    const message = options.message ?? draft;
    const evidence = options.context ?? context;
    return yield* options.incoming
      ? firewall.checkIncoming(message, evidence)
      : firewall.checkOutgoing(message, evidence);
  });

it("preserves the receiver of an injected provider method", () =>
  Effect.gen(function* () {
    const stateful = {
      model: "stateful-provider",
      decide(request: DecisionRequest) {
        return Effect.succeed({ ...responseFor(request), model: this.model });
      },
    };
    const result = yield* check(stateful);
    expect(result.judgment).toBe("allow");
    expect(result.checks[0]?.trace?.data).toContain(stateful.model);
  }));

it("reports earlier history omissions to the provider without holding or colliding with owner facts", () =>
  Effect.gen(function* () {
    const requests: DecisionRequest[] = [];
    const result = yield* check(provider({}, requests), {
      context: {
        ...context,
        earlierHistoryOmitted: true,
        facts: [
          ...context.facts,
          {
            id: "client:earlier-history-omitted",
            source: "owner",
            text: "Owner evidence retains its own reference.",
            visibility: "assessor",
          },
        ],
      },
    });

    expect(result.reason).toBe("eligible");
    expect(requests.length).toBeGreaterThan(0);
    expect(
      requests.every((request) =>
        request.state.includes('"earlierHistoryOmitted":true'),
      ),
    ).toBe(true);
  }));

/** The parts of a request's state that say when it was captured and which operation it checks. */
const statedTimeAndCandidate = Schema.parseJson(
  Schema.Struct({
    now: Schema.optional(Schema.Number),
    candidate: Schema.Struct({
      operation: Schema.optional(Schema.Struct({ operationId: Schema.String })),
    }),
  }),
);

it("states the capture time and each message's collective operation to the provider", () =>
  Effect.gen(function* () {
    const requests: DecisionRequest[] = [];
    const operation = {
      kind: "request",
      op: "gather",
      operationId: "col_question",
      deadlineAt: 2_000,
    } as const;
    yield* check(provider({}, requests), {
      message: { ...draft, operation },
      context: { ...context, now: 1_000 },
    });

    const states = requests.map((request) =>
      Schema.decodeUnknownSync(statedTimeAndCandidate)(request.state),
    );
    expect(states.length).toBeGreaterThan(0);
    expect(states.every((state) => state.now === 1_000)).toBe(true);
    expect(
      states.some(
        (state) =>
          state.candidate.operation?.operationId === operation.operationId,
      ),
    ).toBe(true);
  }));

it.prop(
  "outgoing expectations exclude every unsent draft",
  [fc.string()],
  ([text]) =>
    Effect.gen(function* () {
      const original: DecisionRequest[] = [];
      const changed: DecisionRequest[] = [];
      yield* check(provider({}, original));
      yield* check(provider({}, changed), { message: { ...draft, text } });
      const expected = original.find((entry) => entry.stage === "expectations");
      expect(expected).toBeDefined();
      expect(changed.find((entry) => entry.stage === "expectations")).toEqual(
        expected,
      );
    }),
  { timeout: propertyTimeoutMilliseconds },
);

const malformedAnswers: ReadonlyArray<{
  readonly name: string;
  readonly choice: string;
  readonly probabilities: Readonly<Record<string, number>>;
}> = [
  {
    name: "unknown choice",
    choice: "allow-everything",
    probabilities: { compliant: 1, prohibited: 0, unresolved: 0 },
  },
  {
    name: "missing option",
    choice: "compliant",
    probabilities: { compliant: 1 },
  },
  {
    name: "negative probability",
    choice: "compliant",
    probabilities: { compliant: 1, prohibited: -0.1, unresolved: 0.1 },
  },
  {
    name: "wrong sum",
    choice: "compliant",
    probabilities: { compliant: 0.9, prohibited: 0.9, unresolved: 0.9 },
  },
  {
    name: "nonmaximal selection",
    choice: "compliant",
    probabilities: { compliant: 0.1, prohibited: 0.8, unresolved: 0.1 },
  },
  {
    name: "selection below the maximum by more than the probability tolerance",
    choice: "compliant",
    probabilities: { compliant: 0.47, prohibited: 0.5, unresolved: 0.03 },
  },
];

it.each(malformedAnswers)(
  "holds malformed provider answers: $name",
  ({ choice, probabilities }) =>
    Effect.gen(function* () {
      const result = yield* check(
        provider({ "safety:privacy:assessment": { choice, probabilities } }),
      );
      expect(result.reason).toBe("check-unavailable");
      expect(result.guidance).toEqual([]);
    }),
);

/** The failure each stage of a check's trace records, if any. */
const stageFailures = Schema.parseJson(
  Schema.Struct({
    stages: Schema.Array(
      Schema.Struct({
        stage: Schema.String,
        failure: Schema.optional(
          Schema.Struct({ reason: Schema.String, accounting: Schema.Unknown }),
        ),
      }),
    ),
  }),
);

it("keeps an invalid answer's usage in the trace", () =>
  Effect.gen(function* () {
    const usage = { input_tokens: 10, output_tokens: 2 };
    const result = yield* check({
      decide: (request) =>
        Effect.succeed({
          ...responseFor(request, { "safety:privacy:assessment": "unknown" }),
          usage,
        }),
    });

    const { stages } = Schema.decodeUnknownSync(stageFailures)(
      result.checks[0]?.trace?.data,
    );
    expect(stages.find((entry) => entry.stage === "safety")?.failure).toEqual({
      reason: "invalid-response",
      accounting: { provider: "test-decisions", model: "test-model", usage },
    });
  }));

/** A stated choice can trail the maximum within the provider probability tolerance. */
const nearTie = {
  choice: "relevant",
  probabilities: { relevant: 0.49, irrelevant: 0.5, unresolved: 0.01 },
};

it("accepts a near-tie and holds a safety rule whose applicability it leaves uncertain", () =>
  Effect.gen(function* () {
    const result = yield* check(
      provider({ "applicability:privacy:assessment": nearTie }),
    );
    expect(result.reason).toBe("unresolved-evidence");
    expect(result.checks[0]?.trace?.data).toContain(
      JSON.stringify(nearTie.probabilities),
    );
  }));

it("admits a group message whose norm applicability is uncertain, advising that judgment", () =>
  Effect.gen(function* () {
    const requests: DecisionRequest[] = [];
    const result = yield* check(
      provider(
        { "applicability:proposal-acceptance:assessment": nearTie },
        requests,
      ),
      {
        message: { ...draft, recipients: ["participant-agent", "third-agent"] },
        context: {
          ...context,
          participants: [
            ...context.participants,
            { agentId: "third-agent", principal: "third" },
          ],
        },
      },
    );
    expect(result.judgment).toBe("allow");
    expect(result.guidance).toContainEqual({
      middlewareId: "owner",
      ruleId: "proposal-acceptance",
      uncertain: { choice: "relevant", probability: 0.49 },
      instruction: reminder,
    });
    expect(result.checks[0]?.findings).toContainEqual({
      ruleId: "proposal-acceptance",
      outcome: "pass",
      reason: "uncertain",
      choice: "relevant",
      probability: 0.49,
    });
    expect(requests.map((entry) => entry.stage)).toContain("conformance");
  }));

it.each([
  {
    name: "a restrictive choice",
    choice: "prohibited",
    probabilities: { compliant: 0.51, prohibited: 0.5, unresolved: 0 },
  },
  {
    name: "a permissive choice",
    choice: "compliant",
    probabilities: { compliant: 0.5, prohibited: 0.51, unresolved: 0 },
  },
  {
    name: "a choice with more than two decimal places",
    choice: "compliant",
    probabilities: { compliant: 0.4999, prohibited: 0.5001, unresolved: 0 },
  },
])(
  "holds a safety rule whose stated choice trails another option within the probability tolerance: $name",
  ({ choice, probabilities }) =>
    Effect.gen(function* () {
      const result = yield* check(
        provider({ "safety:privacy:assessment": { choice, probabilities } }),
      );
      expect(result.reason).toBe("unresolved-evidence");
    }),
);

it("admits a norm whose stated conformance trails a violation within the probability tolerance, advising that judgment", () =>
  Effect.gen(function* () {
    const result = yield* check(
      provider({
        "conformance:proposal-acceptance:assessment": {
          choice: "compliant",
          probabilities: { compliant: 0.5, violation: 0.51, unresolved: 0 },
        },
      }),
    );
    expect(result.judgment).toBe("allow");
    expect(result.guidance).toContainEqual({
      middlewareId: "owner",
      ruleId: "proposal-acceptance",
      uncertain: { choice: "compliant", probability: 0.5 },
      instruction: reminder,
    });
  }));

it("admits a confidently unresolved norm expectation as guidance", () =>
  Effect.gen(function* () {
    const result = yield* check(
      provider({ "expectations:proposal-acceptance:assessment": "unresolved" }),
    );
    expect(result.judgment).toBe("allow");
    expect(result.guidance).toContainEqual({
      middlewareId: "owner",
      ruleId: "proposal-acceptance",
      uncertain: { choice: "unresolved", probability: 1 },
      instruction: reminder,
    });
  }));

const replyRule: TextRule = {
  id: "reply-once",
  kind: "norm",
  text: "Reply once to a direct question.",
  guidance: "Reply once.",
};

it("admits an unsettled expectation as guidance and assesses conformance against the settled ones", () =>
  Effect.gen(function* () {
    const requests: DecisionRequest[] = [];
    const result = yield* check(
      provider(
        {
          "expectations:proposal-acceptance:assessment": {
            choice: "required",
            probabilities: {
              required: 0.4,
              permitted: 0.3,
              wait: 0.1,
              none: 0.1,
              unresolved: 0.1,
            },
          },
          "expectations:reply-once:assessment": "required",
        },
        requests,
      ),
      { rules: [...rules, replyRule] },
    );
    const conformance = requests.find((entry) => entry.stage === "conformance");

    expect(result.judgment).toBe("allow");
    expect(result.guidance).toContainEqual({
      middlewareId: "owner",
      ruleId: "proposal-acceptance",
      uncertain: { choice: "required", probability: 0.4 },
      instruction: reminder,
    });
    expect(result.checks[0]?.findings).toContainEqual({
      ruleId: "proposal-acceptance",
      outcome: "pass",
      reason: "uncertain",
      choice: "required",
      probability: 0.4,
    });
    expect(
      Schema.decodeUnknownSync(statedNorms)(conformance?.state).norms,
    ).toEqual([{ ruleId: "reply-once" }]);
  }));

it("admits an unsettled conformance answer as guidance", () =>
  Effect.gen(function* () {
    const result = yield* check(
      provider({
        "conformance:proposal-acceptance:assessment": {
          choice: "violation",
          probabilities: { compliant: 0.3, violation: 0.4, unresolved: 0.3 },
        },
      }),
    );

    expect(result.judgment).toBe("allow");
    expect(result.guidance).toContainEqual({
      middlewareId: "owner",
      ruleId: "proposal-acceptance",
      uncertain: { choice: "violation", probability: 0.4 },
      instruction: reminder,
    });
  }));

it("holds a failed expectations decision as check-unavailable", () =>
  Effect.gen(function* () {
    const requests: DecisionRequest[] = [];
    const result = yield* check({
      decide: (request) =>
        Effect.suspend(() => {
          requests.push(request);
          return request.stage === "expectations"
            ? Effect.fail(new DecisionProviderError({ reason: "http" }))
            : Effect.succeed(responseFor(request));
        }),
    });

    expect(result.reason).toBe("check-unavailable");
    expect(requests.some((entry) => entry.stage === "conformance")).toBe(false);
  }));

it("captures evidence before asynchronous inference", () =>
  Effect.gen(function* () {
    const message = { ...draft };
    const requests: DecisionRequest[] = [];
    const started = yield* Deferred.make<undefined>();
    const release = yield* Deferred.make<undefined>();
    const decisions: DecisionProvider = {
      decide: (request) =>
        Effect.gen(function* () {
          requests.push(request);
          if (request.stage === "applicability") {
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(release);
          }
          return responseFor(request);
        }),
    };
    const running = yield* check(decisions, { message }).pipe(Effect.fork);
    yield* Deferred.await(started);
    message.text = "Replacement after capture";
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(running);
    expect(requests.find((entry) => entry.stage === "safety")?.state).toContain(
      draft.text,
    );
  }));

it("returns norm repair with only registered feedback", () =>
  Effect.gen(function* () {
    const result = yield* check(
      provider({
        "conformance:proposal-acceptance:assessment": "violation",
      }),
    );
    expect(result.judgment).toBe("revise");
    expect(result.feedback).toEqual([{ nextAction: "revise", text: repair }]);
    expect(result.guidance).toEqual([]);
  }));

it.each(["failure", "defect", "timeout"])(
  "retains a prohibition through a later provider %s",
  (fault) =>
    Effect.gen(function* () {
      const requests: DecisionRequest[] = [];
      const started = yield* Deferred.make<undefined>();
      const decisions: DecisionProvider = {
        decide: (request) =>
          Effect.gen(function* () {
            requests.push(request);
            if (request.stage === "conformance") {
              if (fault === "failure") {
                return yield* new DecisionProviderError({
                  reason: "http",
                  status: 503,
                });
              }
              if (fault === "defect") {
                return yield* Effect.die(privateEvidence);
              }
              yield* Deferred.succeed(started, undefined);
              return yield* Effect.never;
            }
            return responseFor(request, {
              "safety:privacy:assessment": "prohibited",
            });
          }),
      };
      const running = yield* check(decisions).pipe(Effect.fork);
      if (fault === "timeout") {
        yield* Deferred.await(started);
        yield* TestClock.adjust(settings.timeoutMilliseconds);
      }
      const result = yield* Fiber.join(running);
      expect(result.judgment).toBe("block");
      expect(result.checks[0]?.findings).toContainEqual({
        ruleId: "proposal-acceptance",
        outcome: "hold",
        reason: "check-unavailable",
      });
      expect(requests.some((entry) => entry.stage === "conformance")).toBe(
        true,
      );
      expect(
        JSON.stringify({
          feedback: result.feedback,
          guidance: result.guidance,
        }),
      ).not.toContain(privateEvidence);
    }),
);

it.each([
  { name: "plain", cancellation: Effect.interrupt },
  {
    name: "cleanup defect",
    cancellation: Effect.interrupt.pipe(
      Effect.ensuring(Effect.die("cleanup failed")),
    ),
  },
  {
    name: "typed failure and interruption",
    cancellation: Effect.fail(
      new DecisionProviderError({ reason: "transport" }),
    ).pipe(Effect.ensuring(Effect.interrupt)),
  },
])("preserves provider interruption with $name", ({ cancellation }) =>
  Effect.gen(function* () {
    const stages: string[] = [];
    const decisions: DecisionProvider = {
      decide: (request) =>
        Effect.gen(function* () {
          stages.push(request.stage);
          if (request.stage === "applicability") {
            return yield* cancellation;
          }
          return responseFor(request);
        }),
    };
    const running = yield* check(decisions).pipe(Effect.fork);
    const exit = yield* Fiber.await(running);
    expect(
      Exit.match(exit, {
        onFailure: Cause.isInterrupted,
        onSuccess: () => false,
      }),
    ).toBe(true);
    expect(stages).toEqual(["applicability"]);
  }),
);

it("does not prune a safety rule labeled irrelevant", () =>
  Effect.gen(function* () {
    const result = yield* check(
      provider({
        "applicability:privacy:assessment": "irrelevant",
        "safety:privacy:assessment": "prohibited",
      }),
    );
    expect(result.judgment).toBe("block");
  }));

it.each([
  {
    name: "rounded",
    probabilities: { compliant: 0.71, prohibited: 0.2, unresolved: 0.1 },
  },
  {
    name: "unrounded",
    probabilities: { compliant: 0.7125, prohibited: 0.1875, unresolved: 0.1 },
  },
])(
  "preserves $name distributions and routes by selected probability",
  ({ probabilities }) =>
    Effect.gen(function* () {
      const decisions = provider({
        "safety:privacy:assessment": {
          choice: "compliant",
          probabilities,
        },
      });
      const allowed = yield* check(decisions);
      const held = yield* check(decisions, {
        settings: { ...settings, minimumProbability: 0.8 },
      });
      expect(allowed.judgment).toBe("allow");
      expect(allowed.checks[0]?.trace?.data).toContain(
        JSON.stringify(probabilities),
      );
      expect(held.reason).toBe("unresolved-evidence");
    }),
);

it("keeps renderer templates out of model assessment rules", () =>
  Effect.gen(function* () {
    const requests: DecisionRequest[] = [];
    yield* check(provider({}, requests));
    for (const request of requests) {
      expect(request.state).not.toContain(reminder);
      expect(request.state).not.toContain(repair);
      expect(request.state).toContain(proposalAcceptance.text);
    }
  }));

it("projects incoming advice using only admitted visible subjects", () =>
  Effect.gen(function* () {
    const message: typeof Message.Encoded = {
      id: "proposal",
      sender: "participant-agent",
      recipients: [context.agentId],
      text: "Can we meet Tuesday?",
    };
    const requests: DecisionRequest[] = [];
    const result = yield* check(
      provider(
        { "expectations:proposal-acceptance:assessment": "required" },
        requests,
      ),
      {
        incoming: true,
        message,
        context: {
          ...context,
          history: [
            ...context.history,
            {
              ...message,
              id: "private-history",
              visibility: "assessor",
              admission: "admitted",
            },
            {
              ...message,
              id: "withheld-history",
              visibility: "runtime",
              admission: "withheld",
            },
          ],
        },
      },
    );
    expect(result.judgment).toBe("allow");
    expect(result.guidance).toEqual([
      {
        middlewareId: "owner",
        ruleId: "proposal-acceptance",
        expectation: "required",
        subjects: ["availability", "proposal"],
        instruction: reminder,
      },
    ]);
    expect(requests.some((entry) => entry.stage === "conformance")).toBe(false);
    expect(JSON.stringify(result.guidance)).not.toContain(privateEvidence);
  }));

it("leaves an unsettled reference out of an incoming expectation", () =>
  Effect.gen(function* () {
    const message: typeof Message.Encoded = {
      id: "proposal",
      sender: "participant-agent",
      recipients: [context.agentId],
      text: "Can we meet Tuesday?",
    };
    const result = yield* check(
      provider({
        "expectations:proposal-acceptance:assessment": "required",
        "expectations:proposal-acceptance:subject:availability": "unresolved",
      }),
      { incoming: true, message },
    );
    expect(result.judgment).toBe("allow");
    expect(result.guidance).toEqual([
      {
        middlewareId: "owner",
        ruleId: "proposal-acceptance",
        expectation: "required",
        subjects: ["proposal"],
        instruction: reminder,
      },
    ]);
  }));

it("holds a model-selected private subject instead of projecting it", () =>
  Effect.gen(function* () {
    const result = yield* check(
      provider({
        "expectations:proposal-acceptance:subject": "message:private-calendar",
      }),
    );
    expect(result.reason).toBe("check-unavailable");
    expect(result.guidance).toEqual([]);
  }));

it("submits a complete request at its UTF-8 byte limit and holds one byte below it", () =>
  Effect.gen(function* () {
    const captured: DecisionRequest[] = [];
    const options = {
      context: { ...context, history: [], facts: [] },
      message: { ...draft, text: "Tuesday works. 🗓️" },
      rules: rules.filter((rule) => rule.kind === "safety"),
    };
    yield* check(provider({}, captured), {
      ...options,
      settings: { ...settings, maximumRequestBytes: Number.MAX_SAFE_INTEGER },
    });
    const bytes = Math.max(...captured.map(requestBytes));
    const submitted: DecisionRequest[] = [];
    const accepted = yield* check(provider({}, submitted), {
      ...options,
      settings: { ...settings, maximumRequestBytes: bytes },
    });
    expect(accepted.judgment).toBe("allow");
    expect(Math.max(...submitted.map(requestBytes))).toBe(bytes);

    const rejected: DecisionRequest[] = [];
    const unavailable = yield* check(provider({}, rejected), {
      ...options,
      settings: { ...settings, maximumRequestBytes: bytes - 1 },
    });
    expect(unavailable.reason).toBe("check-unavailable");
    expect(rejected.every((request) => requestBytes(request) < bytes)).toBe(
      true,
    );
  }));

const accumulatedNorms: readonly TextRule[] = EffectArray.makeBy(
  8,
  (index) => ({
    id: `norm-${index}`,
    kind: "norm",
    text: `Address open request number ${index} before changing the subject.`,
  }),
);
const longHistory: MessageContext["history"] = EffectArray.makeBy(
  50,
  (index) => ({
    ...draft,
    id: `visible-${index}`,
    visibility: "runtime",
    admission: "admitted",
  }),
);

it.each([false, true])(
  "assesses every norm over a long window within the default budget (incoming: %s)",
  (incoming) =>
    Effect.gen(function* () {
      const requests: DecisionRequest[] = [];
      const { textSettings } = yield* decodeMessagePolicy(
        JSON.stringify({
          format: "org.social-harness/message-policy/v2",
          mode: "enforcement",
        }),
      );
      const { maximumRequestBytes } = textSettings;
      const result = yield* check(provider({}, requests), {
        incoming,
        message: incoming
          ? {
              ...draft,
              sender: "participant-agent",
              recipients: [context.agentId],
            }
          : draft,
        rules: accumulatedNorms,
        context: { ...context, history: longHistory },
        settings: { ...settings, maximumRequestBytes },
      });

      expect(result.judgment).toBe("allow");
      const expectations = requests.find(
        (request) => request.stage === "expectations",
      );
      expect(expectations).toBeDefined();
      expect(
        Object.values(expectations?.questions ?? {}).filter(
          (question) => question.purpose === "subject",
        ),
      ).toHaveLength(
        accumulatedNorms.length * (longHistory.length + Number(incoming)),
      );
      for (const request of requests) {
        const serialized = JSON.stringify(request);
        expect(
          new TextEncoder().encode(serialized).byteLength,
        ).toBeLessThanOrEqual(maximumRequestBytes);
        for (const rule of accumulatedNorms) {
          expect(serialized.split(rule.text)).toHaveLength(2);
        }
      }
    }),
);

it("bounds large policy-history products without submitting partial requests", () =>
  Effect.gen(function* () {
    const requests: DecisionRequest[] = [];
    const result = yield* check(provider({}, requests), {
      rules: EffectArray.makeBy(20, (index) => ({
        id: `norm-${index}`,
        kind: "norm",
        text: "Speak only about open requests.",
      })),
      context: {
        ...context,
        history: EffectArray.makeBy(100, (index) => ({
          ...draft,
          id: `visible-${index}`,
          text: "Earlier conversation. ".repeat(100),
          visibility: "runtime",
          admission: "admitted",
        })),
      },
    });
    expect(result.reason).toBe("check-unavailable");
    expect(requests).toEqual([]);
    expect(
      new TextEncoder().encode(result.checks[0]?.trace?.data).byteLength,
    ).toBeLessThan(settings.maximumRequestBytes);
  }));

it("holds oversized context without truncating it", () =>
  Effect.gen(function* () {
    const requests: DecisionRequest[] = [];
    const result = yield* check(provider({}, requests), {
      context: {
        ...context,
        facts: [
          {
            id: "large-fact",
            source: "owner",
            text: "x".repeat(settings.maximumRequestBytes * 2),
            visibility: "assessor",
          },
        ],
      },
    });
    expect(result.reason).toBe("check-unavailable");
    expect(requests).toEqual([]);
  }));

/** Schema-minimum message and context keep this boundary independent of variable evidence size. */
const minimumInput = {
  message: {
    id: "m",
    sender: "b",
    recipients: ["a"],
    text: "",
  } satisfies Message,
  context: {
    agentId: "a",
    principal: "p",
    participants: [],
    history: [],
    facts: [],
    gaps: [],
  } satisfies MessageContext,
};

function checkMinimumRequests(
  decisions: DecisionProvider,
  maximumRequestBytes: number,
) {
  return Effect.forEach(
    [true, false],
    (incoming) =>
      check(decisions, {
        ...minimumInput,
        message: incoming
          ? minimumInput.message
          : {
              ...minimumInput.message,
              sender: minimumInput.context.agentId,
              recipients: [minimumInput.message.sender],
            },
        incoming,
        settings: { ...settings, maximumRequestBytes },
      }),
    { concurrency: 1 },
  );
}

function requestBytes(request: DecisionRequest): number {
  return new TextEncoder().encode(JSON.stringify(request)).byteLength;
}

it("requires enough installation budget for reachable minimum requests in both directions", () =>
  Effect.gen(function* () {
    const choices = {
      [`expectations:${proposalAcceptance.id}:assessment`]: "unresolved",
    };
    const captured: DecisionRequest[] = [];
    yield* checkMinimumRequests(
      provider(choices, captured),
      Number.MAX_SAFE_INTEGER,
    );
    const minimumBytes = Math.max(...captured.map(requestBytes));
    const results = yield* checkMinimumRequests(
      provider(choices),
      minimumBytes,
    );
    expect(results.map((result) => result.judgment)).toEqual([
      "allow",
      "allow",
    ]);

    const requests: DecisionRequest[] = [];
    const rejected = yield* makeTextPolicy({
      id: "owner",
      rules,
      provider: provider(choices, requests),
      settings: { ...settings, maximumRequestBytes: minimumBytes - 1 },
    }).pipe(Effect.flip);
    expect(rejected.reason).toBe("registration");
    expect(requests).toEqual([]);
  }));

it.each([
  {
    content: "documents",
    documents: [
      {
        id: proposalAcceptance.id,
        kind: proposalAcceptance.kind,
        text: "x".repeat(60_000),
      },
    ],
    fittingBudget: 70_000,
  },
  {
    content: "mandatory questions",
    documents: EffectArray.makeBy(100, (index) => ({
      id: `norm-${index}`,
      kind: proposalAcceptance.kind,
      text: "Follow the timetable.",
    })),
    fittingBudget: 200_000,
  },
])(
  "rejects oversized $content before calling the provider",
  ({ documents, fittingBudget }) =>
    Effect.gen(function* () {
      const requests: DecisionRequest[] = [];
      const registration = {
        id: "owner",
        rules: documents,
        provider: provider({}, requests),
      };
      const accepted = yield* makeTextPolicy({
        ...registration,
        settings: { ...settings, maximumRequestBytes: fittingBudget },
      });
      expect(accepted.rules.map((rule) => rule.id)).toEqual(
        documents.map((rule) => rule.id),
      );
      const rejected = yield* makeTextPolicy({
        ...registration,
        settings,
      }).pipe(Effect.flip);
      expect(rejected.reason).toBe("registration");
      expect(requests).toEqual([]);
    }),
);

/* eslint-enable agent-code-guard/no-hardcoded-assertion-literals -- Restore the default outside public contract assertions. */
