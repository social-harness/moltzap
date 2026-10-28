/**
 * @file The collective norm bundle installed from a message-policy document:
 * the code rules refuse a non-facilitator's group collective, a second open
 * request in one conversation and acknowledgement-only group posts; the
 * English rules guide received items; and every member registers the same
 * id and revision.
 */

import { effect as it } from "@effect/vitest";
import { Effect, Schema } from "effect";
// eslint-disable-next-line agent-code-guard/prefer-effect-platform -- The test reads the shipped behavior files the bundle must assess.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import {
  type DecisionProvider,
  DecisionProviderError,
  type DecisionRequest,
  type DecisionResponse,
  decodeMessagePolicy,
  makeFirewall,
  type Message,
  type MessageContext,
  messagePolicyFirewall,
} from "../../daemon/index.js";
import { packageVersion } from "../../release/index.js";

const FORMAT = "org.social-harness/message-policy/v1";

/* eslint-disable agent-code-guard/no-hardcoded-assertion-literals -- Closed judgments, next actions, rule ids and the bundle id are the public contract under test. */

const ALICE = "agent-alice";
const BOB = "agent-bob";
const CAROL = "agent-carol";
const NOW = 1_792_000_000_000;
const LATER = NOW + 60_000;
const BUNDLE = "org.social-harness/collective-norms";
const FORM = '{"type":"object","properties":{"day":{"type":"string"}}}';
/** The shipped collective norms the incoming registration assesses, in order. */
const SHIPPED_NORMS = [
  "empty-acknowledgement",
  "one-gather",
  "announce-once",
  "result-settles",
];
const SHIPPED = fileURLToPath(
  new URL("../../../behaviors/collectives/", import.meta.url),
);
/** The rules a decision request's state lists for its policy. */
const statedRules = Schema.parseJson(
  Schema.Struct({
    policy: Schema.Struct({
      rules: Schema.Array(
        Schema.Struct({
          id: Schema.String,
          kind: Schema.String,
          text: Schema.String,
        }),
      ),
    }),
  }),
);
/** One message of a check's window. */
type HistoryEntry = MessageContext["history"][number];

it("refuses a gather asking several members unless this agent is the facilitator", () =>
  Effect.gen(function* () {
    const gather = draft(
      [BOB, CAROL],
      `gather from agent:alice\nForm: ${FORM}`,
      {
        kind: "request",
        op: "gather",
        id: "col_new",
        deadlineAt: LATER,
      },
    );
    const member = yield* checkOutgoing({ facilitator: false }, gather);
    const facilitator = yield* checkOutgoing({ facilitator: true }, gather);
    expect(member.judgment).toBe("revise");
    expect(member.feedback.map((item) => item.text).join(" ")).toMatch(
      /Only the run's facilitator starts a gather or all_gather/u,
    );
    expect(facilitator.judgment).toBe("allow");
  }));

it("lets any agent gather from one member", () =>
  Effect.gen(function* () {
    const result = yield* checkOutgoing({ facilitator: false }, newRequest());
    expect(result.judgment).toBe("allow");
  }));

it("refuses a request while this agent's earlier request in the conversation is open", () =>
  Effect.gen(function* () {
    const result = yield* checkOutgoing(
      { facilitator: true, history: [ownRequest("col_open", LATER, "gather")] },
      newRequest(),
    );
    expect(result.judgment).toBe("revise");
    expect(result.feedback.map((item) => item.nextAction)).toContain("wait");
  }));

it("refuses an acknowledgement-only post to several members", () =>
  Effect.gen(function* () {
    const group = yield* checkOutgoing(
      { facilitator: false },
      draft([BOB, CAROL], "Thanks, everyone!"),
    );
    expect(group.judgment).toBe("revise");
    expect(group.feedback.map((item) => item.nextAction)).toContain("stop");
  }));

it("guides a received request with the bundle's English norms", () =>
  Effect.gen(function* () {
    const firewall = yield* collectiveFirewall(false, firstChoiceProvider());
    const received = yield* firewall.checkIncoming(
      {
        id: "post-request",
        sender: BOB,
        recipients: [ALICE, CAROL],
        text: `all_gather from agent:bob to group:alice,bob,carol\nForm: ${FORM}`,
        operation: {
          kind: "request",
          op: "all_gather",
          id: "col_bob",
          deadlineAt: LATER,
        },
      },
      context([]),
    );
    expect(received.judgment).toBe("allow");
    expect(received.guidance).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ middlewareId: BUNDLE, ruleId: "one-gather" }),
      ]),
    );
  }));

it("assesses a received message against exactly the shipped collective norms' text", () =>
  Effect.gen(function* () {
    const requests: DecisionRequest[] = [];
    const recording: DecisionProvider = {
      decide: (request) => {
        requests.push(request);
        return firstChoiceProvider().decide(request);
      },
    };
    const firewall = yield* collectiveFirewall(false, recording);
    yield* firewall.checkIncoming(
      {
        id: "post-thanks",
        sender: BOB,
        recipients: [ALICE, CAROL],
        text: "Thanks, everyone.",
      },
      context([]),
    );
    const state = Schema.decodeUnknownSync(statedRules)(requests[0]?.state);
    expect(state.policy.rules).toEqual(
      SHIPPED_NORMS.map((id) => ({
        id,
        kind: "norm",
        text: readFileSync(`${SHIPPED}${id}/BEHAVIOR.md`, "utf8")
          .split(/^---\s*$/mu)
          .at(-1)
          ?.trim(),
      })),
    );
  }));

it("registers one id and revision in both directions whatever the role", () =>
  Effect.gen(function* () {
    const facilitator = yield* chains(true, firstChoiceProvider());
    const member = yield* chains(false, firstChoiceProvider());
    const registrations = [
      ...facilitator.incoming,
      ...facilitator.outgoing,
      ...member.incoming,
      ...member.outgoing,
    ];
    expect(new Set(registrations.map(({ id }) => id))).toEqual(
      new Set([BUNDLE]),
    );
    expect(new Set(registrations.map(({ revision }) => revision)).size).toBe(1);
    expect(registrations[0]?.revision).toMatch(/^[a-f0-9]{64}$/u);
  }));

it("records the same code digest for both facilitator roles", () =>
  Effect.gen(function* () {
    const facilitator = yield* chains(true, firstChoiceProvider());
    const member = yield* chains(false, firstChoiceProvider());
    expect(facilitator.codeDigest).toBe(member.codeDigest);
  }));

it.each([
  [
    "the English settings",
    {
      englishSettings: {
        minimumProbability: 0.6,
        maximumRequestBytes: 384_000,
        timeoutMilliseconds: 15_000,
      },
    },
    firstChoiceProvider(),
  ],
  ["the history window", { maximumHistoryRecords: 32 }, firstChoiceProvider()],
  [
    "the decision provider's model",
    {},
    {
      ...firstChoiceProvider(),
      provenance: { format: "fixture", data: "model-2" },
    },
  ],
] as const)(
  "moves the bundle revision and code digest with %s",
  ([, fields, provider]) =>
    Effect.gen(function* () {
      const before = yield* chains(true, firstChoiceProvider());
      const after = yield* chains(true, provider, fields);
      expect(after.incoming[0]?.revision).not.toBe(
        before.incoming[0]?.revision,
      );
      expect(after.codeDigest).not.toBe(before.codeDigest);
    }),
);

it("moves the code digest with a fixed rule's text", () =>
  Effect.gen(function* () {
    const rule = { id: "fixed", kind: "norm", guidance: "Be brief." } as const;
    const first = yield* chains(true, firstChoiceProvider(), {
      english: { fixedRules: [{ ...rule, text: "Keep it short." }] },
    });
    const second = yield* chains(true, firstChoiceProvider(), {
      english: { fixedRules: [{ ...rule, text: "Keep it shorter." }] },
    });
    expect(second.codeDigest).not.toBe(first.codeDigest);
  }));

it.each([true, false])(
  "records the role in the outgoing provenance (facilitator: %s)",
  (facilitator) =>
    Effect.gen(function* () {
      const { outgoing } = yield* chains(facilitator, firstChoiceProvider());
      const data: unknown = JSON.parse(outgoing[0]?.provenance?.data ?? "null");
      expect(data).toEqual(expect.objectContaining({ facilitator }));
      expect(data).toMatchObject({ edition: { client: packageVersion } });
    }),
);

it("admits a send whose conformance the decision provider leaves unresolved, with that uncertainty as advice", () =>
  Effect.gen(function* () {
    const result = yield* checkOutgoing(
      { facilitator: true, provider: unsettledProvider("conformance") },
      draft([BOB], "Does Tuesday at 10 work for you?"),
    );
    expect(result.judgment).toBe("allow");
    const uncertain = result.guidance.flatMap((item) =>
      "uncertain" in item ? [[item.ruleId, item.uncertain.choice]] : [],
    );
    expect(uncertain).toContainEqual(["one-gather", "unresolved"]);
  }));

it("holds a send the code rules permit when no assessor answers", () =>
  Effect.gen(function* () {
    const result = yield* checkOutgoing(
      { facilitator: true, provider: failingProvider() },
      draft([BOB], "Does Tuesday at 10 work for you?"),
    );
    expect(result.judgment).toBe("hold");
    expect(result.reason).toBe("check-unavailable");
  }));

it("refuses a document that installs the bundle with no decision provider", () =>
  Effect.gen(function* () {
    const decoded = yield* decodeMessagePolicy(
      JSON.stringify({
        format: FORMAT,
        mode: "enforcement",
        incoming: [{ use: "collective-norms" }],
      }),
    ).pipe(Effect.either);
    expect(decoded._tag).toBe("Left");
  }));

/** What one outgoing check runs with: this agent's role, the window, and its assessor. */
interface OutgoingCheck {
  readonly facilitator: boolean;
  readonly history?: readonly HistoryEntry[];
  readonly provider?: DecisionProvider;
}

function checkOutgoing(options: OutgoingCheck, candidate: Message) {
  return collectiveFirewall(
    options.facilitator,
    options.provider ?? firstChoiceProvider(),
  ).pipe(
    Effect.flatMap((firewall) =>
      firewall.checkOutgoing(candidate, context(options.history ?? [])),
    ),
  );
}

function collectiveFirewall(facilitator: boolean, provider: DecisionProvider) {
  return chains(facilitator, provider).pipe(
    Effect.flatMap((options) =>
      makeFirewall({
        incoming: options.incoming,
        outgoing: options.outgoing,
        settings: options.settings,
      }),
    ),
    Effect.orDie,
  );
}

/** The firewall options of an enforcement document installing the bundle. */
function chains(
  facilitator: boolean,
  provider: DecisionProvider,
  fields: object = {},
) {
  return decodeMessagePolicy(
    JSON.stringify({
      format: FORMAT,
      mode: "enforcement",
      incoming: [{ use: "collective-norms" }],
      outgoing: [{ use: "collective-norms", facilitator }],
      decisionProvider: { kind: "jev", model: "jev-1.13.0" },
      maximumHistoryRecords: 48,
      ...fields,
    }),
  ).pipe(
    Effect.flatMap((policy) => messagePolicyFirewall(policy, provider)),
    Effect.orDie,
  );
}

function context(history: readonly HistoryEntry[]): MessageContext {
  return {
    agentId: ALICE,
    principal: "principal-alice",
    participants: [],
    history,
    now: NOW,
    facts: [],
    gaps: [],
  };
}

function newRequest(): Message {
  return draft([BOB], `gather from agent:alice\nForm: ${FORM}`, {
    kind: "request",
    op: "gather",
    id: "col_new",
    deadlineAt: LATER,
  });
}

function draft(
  recipients: Message["recipients"],
  text: string,
  operation?: Message["operation"],
): Message {
  return {
    id: "draft",
    sender: ALICE,
    recipients,
    text,
    ...(operation === undefined ? {} : { operation }),
  };
}

function ownRequest(
  id: string,
  deadlineAt: number,
  op: "gather" | "all_gather",
): HistoryEntry {
  return entry(
    ALICE,
    op === "gather" ? [BOB] : [BOB, CAROL],
    `${op} from agent:alice`,
    { kind: "request", op, id, deadlineAt },
  );
}

function entry(
  sender: string,
  recipients: Message["recipients"],
  text: string,
  operation: NonNullable<Message["operation"]>,
): HistoryEntry {
  return {
    id: `post-${sender}-${operation.kind}-${operation.id}`,
    sender,
    recipients,
    text,
    operation,
    visibility: "runtime",
    admission: "admitted",
  };
}

/** Answers `stage` with an explicit `unresolved`, and every other stage as {@link firstChoiceProvider} does. */
function unsettledProvider(stage: DecisionRequest["stage"]): DecisionProvider {
  const settled = firstChoiceProvider();
  return {
    decide: (request) =>
      request.stage === stage
        ? Effect.succeed(answers(request, () => "unresolved"))
        : settled.decide(request),
  };
}

/**
 * Answers each question with the first of these choices it offers:
 * relevant, compliant, a permitted response. It exercises
 * composition, not English judgment.
 */
function firstChoiceProvider(): DecisionProvider {
  return {
    decide: (request) =>
      Effect.succeed(
        answers(
          request,
          (criteria) =>
            ["relevant", "compliant", "permitted"].find((name) =>
              Object.hasOwn(criteria, name),
            ) ?? "unresolved",
        ),
      ),
  };
}

function answers(
  request: DecisionRequest,
  choose: (criteria: Readonly<Record<string, string>>) => string,
): DecisionResponse {
  return {
    provider: "fixture",
    model: "fixture",
    usage: {},
    raw: "",
    answers: Object.fromEntries(
      Object.entries(request.questions).map(([id, question]) => [
        id,
        distribution(Object.keys(question.criteria), choose(question.criteria)),
      ]),
    ),
  };
}

function distribution(names: readonly string[], choice: string) {
  return {
    choice,
    probabilities: Object.fromEntries(
      names.map((name) => [name, name === choice ? 1 : 0]),
    ),
  };
}

/** An unreachable assessor leaves permitted code checks on hold. */
function failingProvider(): DecisionProvider {
  return {
    decide: () =>
      Effect.fail(new DecisionProviderError({ reason: "transport" })),
  };
}

/* eslint-enable agent-code-guard/no-hardcoded-assertion-literals -- Restore default assertion rules outside the public contract tests. */
