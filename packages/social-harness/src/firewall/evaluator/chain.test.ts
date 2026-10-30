/** @file Shared middleware semantics independent of a text decision provider. */

import { effect as it } from "@effect/vitest";
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  FastCheck as fc,
  Fiber,
  TestClock,
} from "effect";
import { expect } from "vitest";
import {
  type FirewallSettings,
  makeFirewall,
  type Message,
  type MessageContext,
  type MessageMiddleware,
  MiddlewareError,
  type MiddlewareResult,
  type RuleDescription,
} from "../../daemon/index.js";

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
  timeoutMilliseconds: 1_000,
  middlewareTimeoutMilliseconds: 100,
  maximumInputBytes: 100_000,
  maximumResultBytes: 100_000,
};
/** Generated cases check whole chains alongside the package suite's CI workers. */
const propertyTimeoutMilliseconds = 15_000;
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

const firewallFor = (
  middleware: readonly MessageMiddleware[],
  overrides: Partial<FirewallSettings> = {},
) =>
  makeFirewall({
    incoming: middleware,
    outgoing: middleware,
    settings: { ...settings, ...overrides },
  });

it.prop(
  "a pass never overrides any registered prohibition",
  [fc.array(fc.boolean(), { minLength: 1, maxLength: 8 })],
  ([prohibitions]) =>
    Effect.gen(function* () {
      const firewall = yield* firewallFor(
        prohibitions.map((prohibited, index) =>
          policy(`policy-${index}`, [prohibited ? block : pass]),
        ),
      );
      const result = yield* firewall.checkOutgoing(draft, context);
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
    const firewall = yield* firewallFor([tampering, policy("later", [block])]);
    const result = yield* firewall.checkIncoming(incoming, context);
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
    const firewall = yield* firewallFor([first, second]);
    const running = yield* firewall
      .checkOutgoing(draft, context)
      .pipe(Effect.fork);
    yield* Deferred.await(started);
    result.findings.splice(0, 1, pass);
    yield* Deferred.succeed(release, undefined);
    const checked = yield* Fiber.join(running);
    expect(checked.judgment).toBe("reject");
    expect(checked.checks[0]?.findings).toEqual([block, pass]);
  }));

it("runs distinct incoming and outgoing code chains without a provider", () =>
  Effect.gen(function* () {
    const firewall = yield* makeFirewall({
      incoming: [policy("receive")],
      outgoing: [policy("send", [block])],
      settings,
    });
    const received = yield* firewall.checkIncoming(incoming, context);
    const sent = yield* firewall.checkOutgoing(draft, context);
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
            return Effect.fail(new MiddlewareError({ reason: "unavailable" }));
          }
          if (fault === "defect") {
            return Effect.die("private exception");
          }
          return Deferred.succeed(started, undefined).pipe(
            Effect.zipRight(Effect.never),
          );
        },
      };
      const firewall = yield* firewallFor([
        policy("earlier", [block]),
        failing,
        policy("later", [pass]),
      ]);
      const running = yield* firewall
        .checkOutgoing(draft, context)
        .pipe(Effect.fork);
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
    const firewall = yield* firewallFor([waiting, later], {
      timeoutMilliseconds: 50,
    });
    const running = yield* firewall
      .checkOutgoing(draft, context)
      .pipe(Effect.fork);
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
    const firewall = yield* firewallFor([first, later]);
    const running = yield* firewall
      .checkOutgoing(draft, context)
      .pipe(Effect.fork);
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
      const firewall = yield* firewallFor([
        policy(
          "code",
          [pass],
          [{ ruleId: rule.id, expectation: "required", subjects: [subject] }],
        ),
      ]);
      const result = yield* firewall.checkOutgoing(draft, {
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
      const firewall = yield* firewallFor([middleware]);
      const result = yield* firewall.checkOutgoing(draft, context);
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
    const firewall = yield* firewallFor([policy("advice", [unsettled])]);
    const result = yield* firewall.checkOutgoing(draft, context);
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
    const firewall = yield* firewallFor([policy("rule", [block])]);
    const result = yield* firewall.checkIncoming(incoming, context);
    expect(result.reason).toBe("rule-violation");
    expect(result.guidance).toContainEqual({
      middlewareId: "rule",
      ruleId: rule.id,
      instruction: rule.guidance,
    });
  }));

it("holds opposing expectations about the same subject", () =>
  Effect.gen(function* () {
    const firewall = yield* firewallFor([
      policy(
        "respond",
        [pass],
        [{ ruleId: rule.id, expectation: "required", subjects: [incoming.id] }],
      ),
      policy(
        "wait",
        [pass],
        [{ ruleId: rule.id, expectation: "wait", subjects: [incoming.id] }],
      ),
    ]);
    const result = yield* firewall.checkIncoming(incoming, context);
    expect(result.reason).toBe("unresolved-evidence");
    expect(result.guidance).toEqual([]);
  }));

it("holds missing context and publishes no incoming advice", () =>
  Effect.gen(function* () {
    const firewall = yield* firewallFor([
      policy(
        "respond",
        [pass],
        [{ ruleId: rule.id, expectation: "required", subjects: [incoming.id] }],
      ),
    ]);
    const result = yield* firewall.checkIncoming(incoming, {
      ...context,
      gaps: ["Unknown sender relationship"],
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
    const firewall = yield* firewallFor([
      {
        ...policy("owner-consent", [{ ruleId: rule.id, outcome: "violation" }]),
        rules: [{ ...rule, feedback }],
      },
    ]);
    const result = yield* firewall.checkOutgoing(draft, context);
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
    const smallInput = yield* firewallFor([code], { maximumInputBytes: 1 });
    expect((yield* smallInput.checkOutgoing(draft, context)).reason).toBe(
      "check-unavailable",
    );
    expect(ran).toBe(false);
    const smallResult = yield* firewallFor([code], { maximumResultBytes: 1 });
    expect((yield* smallResult.checkOutgoing(draft, context)).reason).toBe(
      "check-unavailable",
    );
  }));

it("allows an empty chain while retaining input and evidence validation", () =>
  Effect.gen(function* () {
    const firewall = yield* firewallFor([]);
    expect((yield* firewall.checkOutgoing(draft, context)).judgment).toBe(
      "allow",
    );
    expect((yield* firewall.checkIncoming(incoming, context)).judgment).toBe(
      "allow",
    );
    expect(
      (yield* firewall
        .checkOutgoing({ ...draft, sender: "other" }, context)
        .pipe(Effect.flip)).reason,
    ).toBe("message");
  }));

it("rejects ambiguous registrations", () =>
  Effect.gen(function* () {
    for (const chain of [
      [policy("same"), policy("same")],
      [{ ...policy("rules"), rules: [rule, rule] }],
    ]) {
      expect((yield* firewallFor(chain).pipe(Effect.flip)).reason).toBe(
        "registration",
      );
    }
  }));

it("rejects ambiguous references, wrong attribution and duplicate recipients", () =>
  Effect.gen(function* () {
    const firewall = yield* firewallFor([policy("code")]);
    const duplicate = yield* firewall
      .checkOutgoing(draft, {
        ...context,
        history: [...context.history, ...context.history],
      })
      .pipe(Effect.flip);
    const forged = yield* firewall
      .checkOutgoing({ ...draft, sender: "owner" }, context)
      .pipe(Effect.flip);
    const otherEndpoint = yield* firewall
      .checkIncoming({ ...incoming, recipients: ["elsewhere"] }, context)
      .pipe(Effect.flip);
    const recipients = yield* firewall
      .checkOutgoing({ ...draft, recipients: ["peer", "peer"] }, context)
      .pipe(Effect.flip);
    expect(duplicate.reason).toBe("context");
    expect(forged.reason).toBe("message");
    expect(otherEndpoint.reason).toBe("message");
    expect(recipients.reason).toBe("message");
  }));

/* eslint-enable agent-code-guard/no-hardcoded-assertion-literals -- Restore default assertion rules outside the public contract tests. */
