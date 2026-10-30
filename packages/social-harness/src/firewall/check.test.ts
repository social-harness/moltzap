/** @file Captured code and text checks preserve judgments, evidence boundaries and registered advice. */
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
import { describe, expect } from "vitest";
import {
  decodeMessagePolicy,
  type FirewallSettings,
  type RuleDescription,
  type TextPolicySettings,
  type TextRule,
} from "./config.js";
import {
  checkMessage,
  validateChecks,
  type DecisionProvider,
  DecisionProviderError,
  type DecisionRequest,
  type DecisionResponse,
  type Message,
  type MessageContext,
  type MessageMiddleware,
  MiddlewareError,
  type MiddlewareResult,
} from "./check.js";

describe("code checks", () => {
  /* eslint-disable agent-code-guard/no-hardcoded-assertion-literals -- Public judgments, findings and feedback are the behavior under test. */
  type PolicyFinding = MiddlewareResult["findings"][number];
  type ResponseExpectation = MiddlewareResult["expectations"][number];
  const draft: typeof Message.Encoded = {
    id: "draft",
    sender: "local-agent",
    recipients: ["peer-agent"],
    text: "Tuesday works.",
  };
  const incoming: typeof Message.Encoded = {
    id: "request",
    sender: "peer-agent",
    recipients: ["local-agent"],
    text: "Does Tuesday work?",
  };
  const context: typeof MessageContext.Encoded = {
    agentId: "local-agent",
    principal: "owner",
    participants: [{ agentId: "peer-agent", principal: "peer-owner" }],
    history: [
      {
        ...incoming,
        id: "earlier",
        visibility: "runtime",
        admission: "admitted",
      },
    ],
    facts: [
      {
        id: "private-fact",
        text: "Owner's private schedule",
        source: "owner",
        visibility: "assessor",
      },
    ],
    gaps: [],
  };
  const settings: typeof FirewallSettings.Encoded = {
    timeoutMilliseconds: 1000,
    middlewareTimeoutMilliseconds: 100,
    maximumInputBytes: 100000,
    maximumResultBytes: 100000,
  };
  /** Generated cases check whole chains alongside the package suite's CI workers. */
  const propertyTimeoutMilliseconds = 15000;
  const rule: typeof RuleDescription.Encoded = {
    id: "rule",
    guidance: "Respond only to the open request.",
  };
  const pass: PolicyFinding = { ruleId: rule.id, outcome: "pass" };
  const block: PolicyFinding = { ruleId: rule.id, outcome: "violation" };
  function policy(
    id: string,
    findings: readonly PolicyFinding[] = [pass],
    expectations: readonly ResponseExpectation[] = [],
  ): MessageMiddleware {
    return {
      id,
      revision: "v1",
      rules: [rule],
      check: () => Effect.succeed({ findings, expectations }),
    };
  }
  function codeConfiguration(
    code: readonly MessageMiddleware[],
    overrides: Partial<FirewallSettings> = {},
  ) {
    return {
      code,
      rules: [],
      revision: "fixture",
      settings: { ...settings, ...overrides },
    };
  }
  it.prop(
    "a pass never overrides any registered prohibition",
    [fc.array(fc.boolean(), { minLength: 1, maxLength: 8 })],
    ([prohibitions]) =>
      Effect.gen(function* () {
        const firewall = codeConfiguration(
          prohibitions.map((prohibited, index) =>
            policy(`policy-${index}`, [prohibited ? block : pass]),
          ),
        );
        const result = yield* checkMessage({
          ...firewall,
          event: { direction: "outgoing", message: draft },
          context: context,
        });
        expect(result.judgment).toBe(
          prohibitions.some(Boolean) ? "reject" : "allow",
        );
      }),
    { timeout: propertyTimeoutMilliseconds },
  );
  it("keeps captured evidence immutable between middleware", () =>
    Effect.gen(function* () {
      const tampering: MessageMiddleware = {
        ...policy("tampering"),
        check: (input) =>
          Effect.sync(() => ({
            findings: [
              Reflect.set(input, "event", {
                direction: "outgoing",
                message: draft,
              }) ||
              Reflect.set(input, "context", { ...context, principal: "forged" })
                ? block
                : pass,
            ],
            expectations: [],
          })),
      };
      const firewall = codeConfiguration([tampering, policy("later", [block])]);
      const result = yield* checkMessage({
        ...firewall,
        event: { direction: "incoming", message: incoming },
        context: context,
      });
      expect(result.checks[0]?.findings).toEqual([pass]);
      expect(result.judgment).toBe("reject");
    }));
  it("isolates returned findings from mutation while later middleware waits", () =>
    Effect.gen(function* () {
      const result = { findings: [block, pass], expectations: [] };
      const started = yield* Deferred.make<undefined>();
      const release = yield* Deferred.make<undefined>();
      const first: MessageMiddleware = {
        ...policy("first"),
        check: () => Effect.succeed(result),
      };
      const second: MessageMiddleware = {
        ...policy("second"),
        check: () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.zipRight(Deferred.await(release)),
            Effect.as({ findings: [pass], expectations: [] }),
          ),
      };
      const firewall = codeConfiguration([first, second]);
      const running = yield* checkMessage({
        ...firewall,
        event: { direction: "outgoing", message: draft },
        context: context,
      }).pipe(Effect.fork);
      yield* Deferred.await(started);
      result.findings.splice(0, 1, pass);
      yield* Deferred.succeed(release, undefined);
      const checked = yield* Fiber.join(running);
      expect(checked.judgment).toBe("reject");
      expect(checked.checks[0]?.findings).toEqual([block, pass]);
    }));
  it("checks incoming and outgoing candidates with their supplied code checks", () =>
    Effect.gen(function* () {
      const receive = codeConfiguration([policy("receive")]);
      const send = codeConfiguration([policy("send", [block])]);
      const received = yield* checkMessage({
        ...receive,
        event: { direction: "incoming", message: incoming },
        context,
      });
      const sent = yield* checkMessage({
        ...send,
        event: { direction: "outgoing", message: draft },
        context,
      });
      expect(received.judgment).toBe("allow");
      expect(sent.judgment).toBe("reject");
      expect(received.checks.map((entry) => entry.middlewareId)).toEqual([
        "receive",
      ]);
      expect(sent.checks.map((entry) => entry.middlewareId)).toEqual(["send"]);
    }));
  it.each(["failure", "defect", "timeout"])(
    "retains completed findings through a later middleware %s",
    (fault) =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<undefined>();
        const failing: MessageMiddleware = {
          ...policy("failing"),
          check: () => {
            if (fault === "failure") {
              return Effect.fail(
                new MiddlewareError({ reason: "unavailable" }),
              );
            }
            if (fault === "defect") {
              return Effect.die("private exception");
            }
            return Deferred.succeed(started, undefined).pipe(
              Effect.zipRight(Effect.never),
            );
          },
        };
        const firewall = codeConfiguration([
          policy("earlier", [block]),
          failing,
          policy("later", [pass]),
        ]);
        const running = yield* checkMessage({
          ...firewall,
          event: { direction: "outgoing", message: draft },
          context: context,
        }).pipe(Effect.fork);
        if (fault === "timeout") {
          yield* Deferred.await(started);
          yield* TestClock.adjust(settings.middlewareTimeoutMilliseconds);
        }
        const result = yield* Fiber.join(running);
        expect(result.judgment).toBe("reject");
        expect(result.checks.map((entry) => entry.status)).toEqual([
          "completed",
          "unavailable",
          "completed",
        ]);
        expect(JSON.stringify(result)).not.toContain("private exception");
      }),
  );
  it("marks unrun entries unavailable after the total deadline", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<undefined>();
      let laterRan = false;
      const waiting: MessageMiddleware = {
        ...policy("waiting"),
        check: () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.zipRight(Effect.never),
          ),
      };
      const later: MessageMiddleware = {
        ...policy("later"),
        check: () =>
          Effect.sync(() => {
            laterRan = true;
            return { findings: [pass], expectations: [] };
          }),
      };
      const firewall = codeConfiguration([waiting, later], {
        timeoutMilliseconds: 50,
      });
      const running = yield* checkMessage({
        ...firewall,
        event: { direction: "outgoing", message: draft },
        context: context,
      }).pipe(Effect.fork);
      yield* Deferred.await(started);
      yield* TestClock.adjust(50);
      const result = yield* Fiber.join(running);
      expect(result.reason).toBe("check-unavailable");
      expect(result.checks.map((entry) => entry.failure?.reason)).toEqual([
        "timeout",
        "timeout",
      ]);
      expect(laterRan).toBe(false);
    }));
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
        new MiddlewareError({ reason: "unavailable" }),
      ).pipe(Effect.ensuring(Effect.interrupt)),
    },
  ])("preserves self-interruption with $name", ({ cancellation }) =>
    Effect.gen(function* () {
      let laterRan = false;
      const first: MessageMiddleware = {
        ...policy("cancel"),
        check: () => cancellation,
      };
      const later: MessageMiddleware = {
        ...policy("later"),
        check: () =>
          Effect.sync(() => {
            laterRan = true;
            return { findings: [pass], expectations: [] };
          }),
      };
      const firewall = codeConfiguration([first, later]);
      const running = yield* checkMessage({
        ...firewall,
        event: { direction: "outgoing", message: draft },
        context: context,
      }).pipe(Effect.fork);
      const exit = yield* Fiber.await(running);
      expect(
        Exit.match(exit, {
          onFailure: Cause.isInterrupted,
          onSuccess: () => false,
        }),
      ).toBe(true);
      expect(laterRan).toBe(false);
    }),
  );
  it.each(["private-history", "withheld-history", "private-fact", "draft"])(
    "rejects an unsafe code-policy subject: %s",
    (subject) =>
      Effect.gen(function* () {
        const firewall = codeConfiguration([
          policy(
            "code",
            [pass],
            [{ ruleId: rule.id, expectation: "required", subjects: [subject] }],
          ),
        ]);
        const result = yield* checkMessage({
          ...firewall,
          event: { direction: "outgoing", message: draft },
          context: {
            ...context,
            history: [
              ...context.history,
              {
                ...incoming,
                id: "private-history",
                visibility: "assessor",
                admission: "admitted",
              },
              {
                ...incoming,
                id: "withheld-history",
                visibility: "runtime",
                admission: "withheld",
              },
            ],
          },
        });
        expect(result.reason).toBe("check-unavailable");
        expect(result.checks[0]?.failure?.reason).toBe("invalid-result");
        expect(result.guidance).toEqual([]);
      }),
  );
  it("rejects missing or unknown rule findings and unregistered advice", () =>
    Effect.gen(function* () {
      const extra = {
        findings: [pass],
        expectations: [],
        guidance: "Unregistered text",
      };
      const variants: MessageMiddleware[] = [
        policy("missing", []),
        policy("unknown", [{ ruleId: "unknown", outcome: "pass" }]),
        { ...policy("advice"), check: () => Effect.succeed(extra) },
      ];
      for (const middleware of variants) {
        const firewall = codeConfiguration([middleware]);
        const result = yield* checkMessage({
          ...firewall,
          event: { direction: "outgoing", message: draft },
          context: context,
        });
        expect(result.reason).toBe("check-unavailable");
        expect(result.checks[0]?.failure?.reason).toBe("invalid-result");
      }
    }));
  it("admits an unsettled registered judgment with its advice", () =>
    Effect.gen(function* () {
      const unsettled: PolicyFinding = {
        ruleId: rule.id,
        outcome: "pass",
        reason: "uncertain",
        choice: "none",
        probability: 0.3,
      };
      const firewall = codeConfiguration([policy("advice", [unsettled])]);
      const result = yield* checkMessage({
        ...firewall,
        event: { direction: "outgoing", message: draft },
        context: context,
      });
      expect(result.judgment).toBe("allow");
      expect(result.guidance).toContainEqual({
        middlewareId: "advice",
        ruleId: rule.id,
        instruction: rule.guidance,
        uncertain: { choice: "none", probability: 0.3 },
      });
    }));
  it("rejects incoming violations with registered local advice", () =>
    Effect.gen(function* () {
      const firewall = codeConfiguration([policy("rule", [block])]);
      const result = yield* checkMessage({
        ...firewall,
        event: { direction: "incoming", message: incoming },
        context: context,
      });
      expect(result.reason).toBe("rule-violation");
      expect(result.guidance).toContainEqual({
        middlewareId: "rule",
        ruleId: rule.id,
        instruction: rule.guidance,
      });
    }));
  it("holds opposing expectations about the same subject", () =>
    Effect.gen(function* () {
      const firewall = codeConfiguration([
        policy(
          "respond",
          [pass],
          [
            {
              ruleId: rule.id,
              expectation: "required",
              subjects: [incoming.id],
            },
          ],
        ),
        policy(
          "wait",
          [pass],
          [{ ruleId: rule.id, expectation: "wait", subjects: [incoming.id] }],
        ),
      ]);
      const result = yield* checkMessage({
        ...firewall,
        event: { direction: "incoming", message: incoming },
        context: context,
      });
      expect(result.reason).toBe("unresolved-evidence");
      expect(result.guidance).toEqual([]);
    }));
  it("holds missing context and publishes no incoming advice", () =>
    Effect.gen(function* () {
      const firewall = codeConfiguration([
        policy(
          "respond",
          [pass],
          [
            {
              ruleId: rule.id,
              expectation: "required",
              subjects: [incoming.id],
            },
          ],
        ),
      ]);
      const result = yield* checkMessage({
        ...firewall,
        event: { direction: "incoming", message: incoming },
        context: {
          ...context,
          gaps: ["Unknown sender relationship"],
        },
      });
      expect(result.reason).toBe("unresolved-evidence");
      expect(result.guidance).toEqual([]);
    }));
  it("projects registered seek-approval feedback", () =>
    Effect.gen(function* () {
      const feedback = {
        text: "Ask your owner with ask_user before committing.",
        nextAction: "seek-approval" as const,
      };
      const firewall = codeConfiguration([
        {
          ...policy("owner-consent", [
            { ruleId: rule.id, outcome: "violation" },
          ]),
          rules: [{ ...rule, feedback }],
        },
      ]);
      const result = yield* checkMessage({
        ...firewall,
        event: { direction: "outgoing", message: draft },
        context: context,
      });
      expect(result.judgment).toBe("reject");
      expect(result.feedback).toEqual([feedback]);
    }));
  it("bounds input and results without converting skipped checks into passes", () =>
    Effect.gen(function* () {
      let ran = false;
      const code: MessageMiddleware = {
        ...policy("code"),
        check: () =>
          Effect.sync(() => {
            ran = true;
            return { findings: [pass], expectations: [] };
          }),
      };
      const smallInput = codeConfiguration([code], { maximumInputBytes: 1 });
      expect(
        (yield* checkMessage({
          ...smallInput,
          event: { direction: "outgoing", message: draft },
          context: context,
        })).reason,
      ).toBe("check-unavailable");
      expect(ran).toBe(false);
      const smallResult = codeConfiguration([code], { maximumResultBytes: 1 });
      expect(
        (yield* checkMessage({
          ...smallResult,
          event: { direction: "outgoing", message: draft },
          context: context,
        })).reason,
      ).toBe("check-unavailable");
    }));
  it("allows an empty chain while retaining input and evidence validation", () =>
    Effect.gen(function* () {
      const firewall = codeConfiguration([]);
      expect(
        (yield* checkMessage({
          ...firewall,
          event: { direction: "outgoing", message: draft },
          context: context,
        })).judgment,
      ).toBe("allow");
      expect(
        (yield* checkMessage({
          ...firewall,
          event: { direction: "incoming", message: incoming },
          context: context,
        })).judgment,
      ).toBe("allow");
      expect(
        (yield* checkMessage({
          ...firewall,
          event: {
            direction: "outgoing",
            message: { ...draft, sender: "other" },
          },
          context: context,
        }).pipe(Effect.flip)).reason,
      ).toBe("message");
    }));
  it("rejects ambiguous registrations", () =>
    Effect.gen(function* () {
      for (const chain of [
        [policy("same"), policy("same")],
        [{ ...policy("rules"), rules: [rule, rule] }],
      ]) {
        expect(
          (yield* validateChecks({
            ...codeConfiguration(chain),
            incoming: chain,
            outgoing: chain,
          }).pipe(Effect.flip)).reason,
        ).toBe("registration");
      }
      const duplicate = policy("org.social-harness/text");
      expect(
        (yield* validateChecks({
          ...codeConfiguration([duplicate]),
          incoming: [duplicate],
          outgoing: [],
          rules: [{ id: "text-rule", text: "Speak plainly.", applies: "both" }],
          textSettings: {
            minimumProbability: 0.5,
            maximumRequestBytes: 60000,
            timeoutMilliseconds: 100,
          },
        }).pipe(Effect.flip)).reason,
      ).toBe("registration");
    }));
  it("rejects ambiguous references, wrong attribution and duplicate recipients", () =>
    Effect.gen(function* () {
      const firewall = codeConfiguration([policy("code")]);
      const duplicate = yield* checkMessage({
        ...firewall,
        event: { direction: "outgoing", message: draft },
        context: {
          ...context,
          history: [...context.history, ...context.history],
        },
      }).pipe(Effect.flip);
      const forged = yield* checkMessage({
        ...firewall,
        event: {
          direction: "outgoing",
          message: { ...draft, sender: "owner" },
        },
        context: context,
      }).pipe(Effect.flip);
      const otherEndpoint = yield* checkMessage({
        ...firewall,
        event: {
          direction: "incoming",
          message: { ...incoming, recipients: ["elsewhere"] },
        },
        context: context,
      }).pipe(Effect.flip);
      const recipients = yield* checkMessage({
        ...firewall,
        event: {
          direction: "outgoing",
          message: { ...draft, recipients: ["peer", "peer"] },
        },
        context: context,
      }).pipe(Effect.flip);
      expect(duplicate.reason).toBe("context");
      expect(forged.reason).toBe("message");
      expect(otherEndpoint.reason).toBe("message");
      expect(recipients.reason).toBe("message");
    }));
});

describe("text checks", () => {
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
    applies: "both",
    text: "Availability is not acceptance. Everyone must accept the same concrete proposal before it is finalized.",
    guidance: reminder,
    feedback: { text: repair, nextAction: "revise" },
  };
  const rules: readonly TextRule[] = [
    {
      id: "privacy",
      applies: "both",
      text: "Do not disclose unrelated private appointments.",
    },
    proposalAcceptance,
  ];
  /** One answer exactly as a provider reports it. */
  type Answer = DecisionResponse["answers"][string];
  const settings: typeof TextPolicySettings.Encoded = {
    minimumProbability: 0.5,
    maximumRequestBytes: 60000,
    timeoutMilliseconds: 100,
  };
  const firewallSettings = {
    timeoutMilliseconds: 2000,
    middlewareTimeoutMilliseconds: 1000,
    maximumInputBytes: 300000,
    maximumResultBytes: 1000000,
  };
  /** Each generated example runs two full chains alongside other CI workers. */
  const propertyTimeoutMilliseconds = 15000;
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
            choices[
              `${request.stage}:${question.ruleId}:${question.purpose}`
            ] ??
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
  /** Local response expectations supplied to candidate compliance. */
  const statedResponseExpectations = Schema.parseJson(
    Schema.Struct({
      responseExpectations: Schema.Array(
        Schema.Struct({ ruleId: Schema.String }),
      ),
    }),
  );
  function check(
    decisions: DecisionProvider = defaultProvider,
    options: {
      readonly message?: Message;
      readonly context?: MessageContext;
      readonly rules?: readonly TextRule[];
      readonly settings?: TextPolicySettings;
      readonly incoming?: boolean;
    } = {},
  ) {
    return Effect.gen(function* () {
      const configuration = {
        rules: options.rules ?? rules,
        settings: firewallSettings,
        textSettings: options.settings ?? settings,
        revision: "a".repeat(64),
      };
      yield* validateChecks({ ...configuration, incoming: [], outgoing: [] });
      return yield* checkMessage({
        ...configuration,
        provider: decisions,
        code: [],
        event: {
          direction: options.incoming ? "incoming" : "outgoing",
          message: options.message ?? draft,
        },
        context: options.context ?? context,
      });
    });
  }
  it.each([false, true])(
    "continues configured text assessment after code rejection with provider unavailable=%s",
    (unavailable) =>
      Effect.gen(function* () {
        const requests: DecisionRequest[] = [];
        const decisions: DecisionProvider = {
          decide: (request) =>
            Effect.suspend(() => {
              requests.push(request);
              return unavailable
                ? Effect.fail(
                    new DecisionProviderError({ reason: "transport" }),
                  )
                : Effect.succeed(responseFor(request));
            }),
        };
        const result = yield* checkMessage({
          event: { direction: "outgoing", message: draft },
          context,
          code: [
            {
              id: "code",
              revision: "fixture",
              rules: [{ id: "code-rule" }],
              check: () =>
                Effect.succeed({
                  findings: [{ ruleId: "code-rule", outcome: "violation" }],
                  expectations: [],
                }),
            },
          ],
          rules: [proposalAcceptance],
          revision: "a".repeat(64),
          settings: firewallSettings,
          textSettings: settings,
          provider: decisions,
        });
        expect(result.reason).toBe("rule-violation");
        expect(requests.length).toBeGreaterThan(0);
        expect(result.checks.flatMap((check) => check.findings)).toContainEqual(
          unavailable
            ? {
                ruleId: proposalAcceptance.id,
                outcome: "hold",
                reason: "check-unavailable",
              }
            : { ruleId: proposalAcceptance.id, outcome: "pass" },
        );
      }),
  );
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
        operation: Schema.optional(
          Schema.Struct({ operationId: Schema.String }),
        ),
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
        deadlineAt: 2000,
      } as const;
      yield* check(provider({}, requests), {
        message: { ...draft, operation },
        context: { ...context, now: 1000 },
      });
      const states = requests.map((request) =>
        Schema.decodeUnknownSync(statedTimeAndCandidate)(request.state),
      );
      expect(states.length).toBeGreaterThan(0);
      expect(states.every((state) => state.now === 1000)).toBe(true);
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
        const expected = original.find(
          (entry) => entry.stage === "expectations",
        );
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
      probabilities: { compliant: 1, violation: 0, unresolved: 0 },
    },
    {
      name: "missing option",
      choice: "compliant",
      probabilities: { compliant: 1 },
    },
    {
      name: "negative probability",
      choice: "compliant",
      probabilities: { compliant: 1, violation: -0.1, unresolved: 0.1 },
    },
    {
      name: "wrong sum",
      choice: "compliant",
      probabilities: { compliant: 0.9, violation: 0.9, unresolved: 0.9 },
    },
    {
      name: "nonmaximal selection",
      choice: "compliant",
      probabilities: { compliant: 0.1, violation: 0.8, unresolved: 0.1 },
    },
    {
      name: "selection below the maximum by more than the probability tolerance",
      choice: "compliant",
      probabilities: { compliant: 0.47, violation: 0.5, unresolved: 0.03 },
    },
  ];
  it.each(malformedAnswers)(
    "holds malformed provider answers: $name",
    ({ choice, probabilities }) =>
      Effect.gen(function* () {
        const result = yield* check(
          provider({
            "compliance:privacy:assessment": { choice, probabilities },
          }),
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
            Schema.Struct({
              reason: Schema.String,
              accounting: Schema.Unknown,
            }),
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
            ...responseFor(request, {
              "compliance:privacy:assessment": "unknown",
            }),
            usage,
          }),
      });
      const { stages } = Schema.decodeUnknownSync(stageFailures)(
        result.checks[0]?.trace?.data,
      );
      expect(
        stages.find((entry) => entry.stage === "compliance")?.failure,
      ).toEqual({
        reason: "invalid-response",
        accounting: { provider: "test-decisions", model: "test-model", usage },
      });
    }));
  /** A stated choice can trail the maximum within the provider probability tolerance. */
  const nearTie = {
    choice: "relevant",
    probabilities: { relevant: 0.49, irrelevant: 0.5, unresolved: 0.01 },
  };
  it("accepts a near-tie and admits an unsettled applicability judgment", () =>
    Effect.gen(function* () {
      const result = yield* check(
        provider({ "applicability:privacy:assessment": nearTie }),
      );
      expect(result.reason).toBe("eligible");
      expect(result.checks[0]?.trace?.data).toContain(
        JSON.stringify(nearTie.probabilities),
      );
    }));
  it("admits a group message whose rule applicability is uncertain, advising that judgment", () =>
    Effect.gen(function* () {
      const requests: DecisionRequest[] = [];
      const result = yield* check(
        provider(
          { "applicability:proposal-acceptance:assessment": nearTie },
          requests,
        ),
        {
          message: {
            ...draft,
            recipients: ["participant-agent", "third-agent"],
          },
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
        middlewareId: "org.social-harness/text",
        ruleId: "proposal-acceptance",
        uncertain: { choice: "relevant", probability: 0.49 },
        instruction: reminder,
      });
      expect(requests.map((entry) => entry.stage)).toContain("compliance");
    }));
  it.each([
    {
      name: "a restrictive choice",
      choice: "violation",
      probabilities: { compliant: 0.51, violation: 0.5, unresolved: 0 },
    },
    {
      name: "a permissive choice",
      choice: "compliant",
      probabilities: { compliant: 0.5, violation: 0.51, unresolved: 0 },
    },
  ])(
    "admits a rule whose stated choice trails another option within the probability tolerance: $name",
    ({ choice, probabilities }) =>
      Effect.gen(function* () {
        const result = yield* check(
          provider({
            "compliance:privacy:assessment": { choice, probabilities },
          }),
        );
        expect(result.reason).toBe("eligible");
      }),
  );
  it("admits a confidently unresolved response expectation as guidance", () =>
    Effect.gen(function* () {
      const result = yield* check(
        provider({
          "expectations:proposal-acceptance:assessment": "unresolved",
        }),
      );
      expect(result.judgment).toBe("allow");
      expect(result.guidance).toContainEqual({
        middlewareId: "org.social-harness/text",
        ruleId: "proposal-acceptance",
        uncertain: { choice: "unresolved", probability: 1 },
        instruction: reminder,
      });
    }));
  const replyRule: TextRule = {
    id: "reply-once",
    applies: "both",
    text: "Reply once to a direct question.",
    guidance: "Reply once.",
  };
  it("admits an unsettled expectation as guidance and assesses compliance against the settled ones", () =>
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
      const compliance = requests.find((entry) => entry.stage === "compliance");
      expect(result.judgment).toBe("allow");
      expect(result.guidance).toContainEqual({
        middlewareId: "org.social-harness/text",
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
        Schema.decodeUnknownSync(statedResponseExpectations)(compliance?.state)
          .responseExpectations,
      ).toEqual([{ ruleId: "privacy" }, { ruleId: "reply-once" }]);
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
      expect(requests.some((entry) => entry.stage === "compliance")).toBe(
        false,
      );
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
      expect(
        requests.find((entry) => entry.stage === "compliance")?.state,
      ).toContain(draft.text);
    }));
  it("returns rule repair with only registered feedback", () =>
    Effect.gen(function* () {
      const result = yield* check(
        provider({
          "compliance:proposal-acceptance:assessment": "violation",
        }),
      );
      expect(result.judgment).toBe("reject");
      expect(result.feedback).toEqual([{ nextAction: "revise", text: repair }]);
      expect(result.guidance).toContainEqual({
        middlewareId: "org.social-harness/text",
        ruleId: proposalAcceptance.id,
        instruction: reminder,
      });
    }));
  it("retains a settled violation beside another rule's valid uncertainty", () =>
    Effect.gen(function* () {
      const result = yield* check(
        provider({
          "compliance:privacy:assessment": "violation",
          "compliance:proposal-acceptance:assessment": "unresolved",
        }),
      );
      expect(result.reason).toBe("rule-violation");
      expect(result.checks[0]?.findings).toContainEqual({
        ruleId: "privacy",
        outcome: "violation",
      });
      expect(
        JSON.stringify({
          feedback: result.feedback,
          guidance: result.guidance,
        }),
      ).not.toContain(privateEvidence);
    }));
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
  it("does not prune a rule labeled irrelevant", () =>
    Effect.gen(function* () {
      const result = yield* check(
        provider({
          "applicability:privacy:assessment": "irrelevant",
          "compliance:privacy:assessment": "violation",
        }),
      );
      expect(result.judgment).toBe("reject");
    }));
  it.each([
    {
      name: "rounded",
      probabilities: { compliant: 0.71, violation: 0.2, unresolved: 0.1 },
    },
    {
      name: "unrounded",
      probabilities: { compliant: 0.7125, violation: 0.1875, unresolved: 0.1 },
    },
  ])(
    "preserves $name distributions and routes by selected probability",
    ({ probabilities }) =>
      Effect.gen(function* () {
        const decisions = provider({
          "compliance:privacy:assessment": {
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
        expect(held.reason).toBe("eligible");
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
          middlewareId: "org.social-harness/text",
          ruleId: "proposal-acceptance",
          expectation: "required",
          subjects: ["availability", "proposal"],
          instruction: reminder,
        },
      ]);
      expect(requests.some((entry) => entry.stage === "compliance")).toBe(true);
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
          middlewareId: "org.social-harness/text",
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
          "expectations:proposal-acceptance:subject":
            "message:private-calendar",
        }),
      );
      expect(result.reason).toBe("check-unavailable");
      expect(result.guidance).toEqual([]);
    }));
  it("routes each text rule without consulting the provider for the opposite direction", () =>
    Effect.gen(function* () {
      const requests: DecisionRequest[] = [];
      const incomingOnly: TextRule = {
        id: proposalAcceptance.id,
        text: proposalAcceptance.text,
        guidance: reminder,
        applies: "incoming",
      };
      const result = yield* check(provider({}, requests), {
        rules: [incomingOnly],
      });
      expect(result.judgment).toBe("allow");
      expect(requests).toEqual([]);
      expect(result.checks[0]?.findings).toEqual([
        { ruleId: incomingOnly.id, outcome: "not-applicable" },
      ]);
    }));
  it("checks incoming peer content without imposing local response expectations", () =>
    Effect.gen(function* () {
      const requests: DecisionRequest[] = [];
      const message: typeof Message.Encoded = {
        ...draft,
        sender: "participant-agent",
        recipients: [context.agentId],
      };
      const result = yield* check(
        provider(
          { "expectations:proposal-acceptance:assessment": "required" },
          requests,
        ),
        { incoming: true, message },
      );
      const compliance = requests.find(
        (request) => request.stage === "compliance",
      );
      expect(
        Schema.decodeUnknownSync(statedResponseExpectations)(compliance?.state)
          .responseExpectations,
      ).toEqual([]);
      expect(result.judgment).toBe("allow");
      expect(result.guidance).toContainEqual({
        middlewareId: "org.social-harness/text",
        ruleId: proposalAcceptance.id,
        expectation: "required",
        subjects: ["availability", draft.id],
        instruction: reminder,
      });
    }));
  it("submits a complete request at its UTF-8 byte limit and holds one byte below it", () =>
    Effect.gen(function* () {
      const captured: DecisionRequest[] = [];
      const options = {
        context: { ...context, history: [], facts: [] },
        message: { ...draft, text: "Tuesday works. 🗓️" },
        rules: rules
          .filter((rule) => rule.id === "privacy")
          .map(
            (rule): TextRule => ({
              id: rule.id,
              text: rule.text,
              applies: "outgoing",
            }),
          ),
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
  const accumulatedRules: readonly TextRule[] = EffectArray.makeBy(
    8,
    (index) => ({
      id: `rule-${index}`,
      applies: "both",
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
    "assesses every rule over a long window within the default budget (incoming: %s)",
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
          rules: accumulatedRules,
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
          accumulatedRules.length * (longHistory.length + Number(incoming)),
        );
        for (const request of requests) {
          const serialized = JSON.stringify(request);
          expect(
            new TextEncoder().encode(serialized).byteLength,
          ).toBeLessThanOrEqual(maximumRequestBytes);
          for (const rule of accumulatedRules) {
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
          id: `rule-${index}`,
          applies: "both",
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
    documents: readonly TextRule[] = rules,
  ) {
    return Effect.forEach(
      [true, false],
      (incoming) =>
        check(decisions, {
          rules: documents,
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
  it.each([
    rules,
    rules.map(
      (rule): TextRule => ({
        id: rule.id,
        text: rule.text,
        applies: rule.id === "privacy" ? "incoming" : "outgoing",
      }),
    ),
  ])(
    "requires enough installation budget for reachable minimum requests in each direction",
    (documents) =>
      Effect.gen(function* () {
        const choices = {
          [`expectations:${proposalAcceptance.id}:assessment`]: "unresolved",
        };
        const captured: DecisionRequest[] = [];
        yield* checkMinimumRequests(
          provider(choices, captured),
          Number.MAX_SAFE_INTEGER,
          documents,
        );
        const minimumBytes = Math.max(...captured.map(requestBytes));
        const results = yield* checkMinimumRequests(
          provider(choices),
          minimumBytes,
          documents,
        );
        expect(results.map((result) => result.judgment)).toEqual([
          "allow",
          "allow",
        ]);
        const requests: DecisionRequest[] = [];
        const rejected = yield* validateChecks({
          rules: documents,
          textSettings: { ...settings, maximumRequestBytes: minimumBytes - 1 },
          settings: firewallSettings,
          revision: "a".repeat(64),
          incoming: [],
          outgoing: [],
        }).pipe(Effect.flip);
        expect(rejected.reason).toBe("registration");
        expect(requests).toEqual([]);
      }),
  );
  it.each([
    {
      content: "documents",
      documents: [
        {
          id: proposalAcceptance.id,
          applies: proposalAcceptance.applies,
          text: "x".repeat(60000),
        },
      ],
      fittingBudget: 70000,
    },
    {
      content: "mandatory questions",
      documents: EffectArray.makeBy(100, (index) => ({
        id: `rule-${index}`,
        applies: proposalAcceptance.applies,
        text: "Follow the timetable.",
      })),
      fittingBudget: 200000,
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
        yield* validateChecks({
          ...registration,
          textSettings: { ...settings, maximumRequestBytes: fittingBudget },
          settings: firewallSettings,
          revision: "a".repeat(64),
          incoming: [],
          outgoing: [],
        });
        const rejected = yield* validateChecks({
          ...registration,
          textSettings: settings,
          settings: firewallSettings,
          revision: "a".repeat(64),
          incoming: [],
          outgoing: [],
        }).pipe(Effect.flip);
        expect(rejected.reason).toBe("registration");
        expect(requests).toEqual([]);
      }),
  );
});
