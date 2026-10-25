/**
 * @file Gather and all_gather run end to end through real daemons that
 * install firewalls, in guidance and enforcement modes side by side.
 *
 * Every daemon runs `firewall-daemon.ts`, whose policy withholds an incoming
 * text carrying `[in]`, refuses an outgoing text carrying `[out]`, asks for
 * a response to an incoming text carrying `[guide]`, and leaves its norm
 * judgment of a text carrying `[unsure]` unsettled. Each endpoint
 * checks with its own firewall: a requester checks the question it sends and
 * the answers it receives, a member checks the question it is asked.
 */

import { FirewallSendError } from "@moltzap/client";
import { Effect, Queue } from "effect";
import { expect, it } from "vitest";
import { processTrace } from "./daemon-process-harness.js";
import {
  acquireParticipants,
  groupAddress,
  groupRound,
  measuredDeadlineSeconds,
  nextItem,
  type Participant,
  send,
} from "./participants.js";

/**
 * Each test starts PGlite, the Registry, the Router and three or four
 * daemons under `tsx`, and one step of each waits out a deadline of several
 * measured post rounds. The limit is the only wall-clock bound these traces
 * set themselves apart from that measured deadline.
 */
const FIREWALL_TEST_TIMEOUT_MS = 300_000;
/** The deadline of an operation every asked member answers, so no deadline races the answers. */
const ANSWERED_DEADLINE_SECONDS = FIREWALL_TEST_TIMEOUT_MS / 1000;
const formSchema = {
  type: "object",
  properties: {
    slot: { type: "string", enum: ["mon", "tue"] },
    note: { type: "string" },
  },
  required: ["slot"],
} as const;

const collecting = (
  requester: Participant,
  op: "gather" | "all_gather",
  members: readonly Participant[],
  question: string,
  deadline: number,
) =>
  send(requester, {
    to: groupAddress([requester, ...members]),
    text: question,
    collective: { op, deadline, requestedSchema: formSchema },
  });

const accept = (member: Participant, to: string, content: object) =>
  send(member, {
    to,
    collectiveResponse: { action: "accept", content },
  });

const requireAll = <Count extends 3 | 4>(
  participants: readonly Participant[],
  count: Count,
) =>
  participants.length === count
    ? Effect.succeed(participants)
    : Effect.dieMessage(`expected ${count} participants`);

/**
 * A requester and a member in enforcement mode, and one member in guidance
 * mode. A refused question posts nothing; a question the strict member's
 * firewall withholds never reaches it, and the requester records it as
 * no-answer at the deadline; an answer the requester's firewall withholds is
 * marked withheld in its result; and a guidance-mode requester sees every
 * answer with the advice each check gave.
 */
const gatherBehavior = Effect.gen(function* () {
  const [requester, guided, strict] = yield* acquireParticipants(
    ["fw-gather-requester", "fw-gather-guided", "fw-gather-strict"],
    {
      "fw-gather-requester": "enforcement",
      "fw-gather-guided": "guidance",
      "fw-gather-strict": "enforcement",
    },
  ).pipe(Effect.flatMap((all) => requireAll(all, 3)));
  if (requester === undefined || guided === undefined || strict === undefined) {
    return yield* Effect.dieMessage("expected three participants");
  }
  const members = [guided, strict];

  const refused = yield* collecting(
    requester,
    "gather",
    members,
    "[out] Which day works?",
    60,
  ).pipe(Effect.flip);
  expect(refused).toBeInstanceOf(FirewallSendError);
  expect(refused).toMatchObject({ refusal: "prohibited" });

  const deadline = yield* measuredDeadlineSeconds(
    groupRound(requester, members),
  );
  const withheld = yield* collecting(
    requester,
    "gather",
    members,
    "[in] Which day works?",
    deadline,
  );
  /** The refused gather posted nothing, so this is the first request either member sees. */
  expect(yield* nextItem(guided)).toMatchObject({
    kind: "collectiveRequest",
    id: withheld.operationId,
  });
  yield* accept(guided, requester.address, { slot: "mon" });
  expect(
    yield* accept(strict, requester.address, { slot: "tue" }).pipe(Effect.flip),
  ).toMatchObject({ failure: { kind: "request-none" } });
  expect(yield* nextItem(requester)).toMatchObject({
    kind: "collectiveResult",
    id: withheld.operationId,
    outcomes: [
      { member: guided.address, outcome: { kind: "answered" } },
      { member: strict.address, outcome: { kind: "no-answer" } },
    ],
  });

  const answered = yield* collecting(
    requester,
    "gather",
    members,
    "Which day works for the review?",
    ANSWERED_DEADLINE_SECONDS,
  );
  /** The withheld request never reached the strict member, so this is its first. */
  expect(yield* nextItem(strict)).toMatchObject({
    kind: "collectiveRequest",
    id: answered.operationId,
  });
  expect(yield* nextItem(guided)).toMatchObject({ id: answered.operationId });
  yield* accept(guided, requester.address, {
    slot: "mon",
    note: "[in] my calendar is private",
  });
  yield* accept(strict, requester.address, { slot: "tue" });
  expect(yield* nextItem(requester)).toMatchObject({
    kind: "collectiveResult",
    id: answered.operationId,
    outcomes: [
      {
        member: guided.address,
        outcome: { kind: "withheld", reason: "prohibited" },
      },
      {
        member: strict.address,
        outcome: { kind: "answered", content: { slot: "tue" } },
      },
    ],
  });

  const advised = yield* collecting(
    guided,
    "gather",
    [requester, strict],
    "Which day works for the retro?",
    ANSWERED_DEADLINE_SECONDS,
  );
  expect(yield* nextItem(requester)).toMatchObject({ id: advised.operationId });
  expect(yield* nextItem(strict)).toMatchObject({ id: advised.operationId });
  yield* accept(requester, guided.address, {
    slot: "mon",
    note: "[guide] reply to me",
  });
  yield* accept(strict, guided.address, { slot: "tue" });
  const result = yield* Queue.take(guided.inbox);
  yield* result.acknowledge;
  expect(result.item).toMatchObject({
    kind: "collectiveResult",
    id: advised.operationId,
    outcomes: [
      {
        member: requester.address,
        outcome: {
          kind: "answered",
          content: { note: "[guide] reply to me" },
        },
      },
      { member: strict.address, outcome: { kind: "answered" } },
    ],
  });
  expect(result.guidance).toMatchObject({
    answers: [
      {
        member: requester.address,
        instructions: [{ instruction: "Respond to the marked message." }],
      },
    ],
  });

  const uncertainAdvice = {
    middlewareId: "integration-markers",
    ruleId: "marked",
    uncertain: { choice: "none", probability: 0.33 },
    instruction: "Respond to the marked message.",
  };
  /** An unsettled norm judgment admits under enforcement and returns only that advice, without the settled expectation. */
  const unsettled = yield* collecting(
    requester,
    "gather",
    members,
    "[unsure] Which day works for the demo?",
    ANSWERED_DEADLINE_SECONDS,
  );
  expect(unsettled.guidance?.instructions).toEqual([uncertainAdvice]);
  expect(yield* nextItem(guided)).toMatchObject({ id: unsettled.operationId });
  expect(yield* nextItem(strict)).toMatchObject({ id: unsettled.operationId });
  yield* accept(guided, requester.address, { slot: "mon" });
  const unsure = yield* accept(strict, requester.address, {
    slot: "tue",
    note: "[unsure] maybe",
  });
  expect(unsure.guidance?.instructions).toEqual([uncertainAdvice]);
  const unsureResult = yield* Queue.take(requester.inbox);
  yield* unsureResult.acknowledge;
  expect(unsureResult.item).toMatchObject({
    kind: "collectiveResult",
    id: unsettled.operationId,
    outcomes: [
      { member: guided.address, outcome: { kind: "answered" } },
      {
        member: strict.address,
        outcome: { kind: "answered", content: { note: "[unsure] maybe" } },
      },
    ],
  });
  expect(unsureResult.guidance).toMatchObject({
    answers: [{ member: strict.address, instructions: [uncertainAdvice] }],
  });
}).pipe(Effect.scoped);

/**
 * A requester and two members in enforcement mode, and one in guidance
 * mode. A question the strict members' firewalls withhold never reaches
 * them, yet each still applies the close and receives the result with the
 * question withheld. An answer the enforcing endpoints withhold is marked
 * withheld in their results and nowhere else. Every endpoint's result has
 * the same members and the same outcome for every answer it shows.
 */
const allGatherBehavior = Effect.gen(function* () {
  const all = yield* acquireParticipants(
    [
      "fw-all-gather-requester",
      "fw-all-gather-guided",
      "fw-all-gather-strict-a",
      "fw-all-gather-strict-b",
    ],
    {
      "fw-all-gather-requester": "enforcement",
      "fw-all-gather-guided": "guidance",
      "fw-all-gather-strict-a": "enforcement",
      "fw-all-gather-strict-b": "enforcement",
    },
  ).pipe(Effect.flatMap((participants) => requireAll(participants, 4)));
  const [requester, guided, strictA, strictB] = all;
  if (
    requester === undefined ||
    guided === undefined ||
    strictA === undefined ||
    strictB === undefined
  ) {
    return yield* Effect.dieMessage("expected four participants");
  }
  const members = [guided, strictA, strictB];
  /** The group's canonical spelling, its names in ASCII order, as results carry it. */
  const group = groupAddress([guided, requester, strictA, strictB]);

  const deadline = yield* measuredDeadlineSeconds(
    groupRound(requester, members),
  );
  const withheld = yield* collecting(
    requester,
    "all_gather",
    members,
    "[in] Which day works?",
    deadline,
  );
  expect(yield* nextItem(guided)).toMatchObject({
    kind: "collectiveRequest",
    id: withheld.operationId,
  });
  yield* accept(guided, group, { slot: "mon" });
  expect(
    yield* accept(strictA, group, { slot: "tue" }).pipe(Effect.flip),
  ).toMatchObject({ failure: { kind: "request-none" } });
  const outcomes = [
    {
      member: guided.address,
      outcome: { kind: "answered", content: { slot: "mon" } },
    },
    { member: strictA.address, outcome: { kind: "no-answer" } },
    { member: strictB.address, outcome: { kind: "no-answer" } },
  ];
  const shown = {
    kind: "collectiveResult",
    op: "all_gather",
    id: withheld.operationId,
    to: group,
    question: "[in] Which day works?",
    outcomes,
  };
  const hidden = {
    ...shown,
    question: { kind: "withheld", reason: "prohibited" },
  };
  expect(yield* nextItem(requester)).toEqual(shown);
  expect(yield* nextItem(guided)).toEqual(shown);
  expect(yield* nextItem(strictA)).toMatchObject(hidden);
  expect(yield* nextItem(strictB)).toMatchObject(hidden);

  const answered = yield* collecting(
    requester,
    "all_gather",
    members,
    "Which day works for the review?",
    ANSWERED_DEADLINE_SECONDS,
  );
  /** The withheld request never reached the strict members, so this is their first. */
  for (const member of members) {
    expect(yield* nextItem(member)).toMatchObject({
      kind: "collectiveRequest",
      id: answered.operationId,
    });
  }
  yield* accept(guided, group, { slot: "mon", note: "[in] private" });
  yield* accept(strictA, group, { slot: "tue" });
  yield* send(strictB, {
    to: group,
    collectiveResponse: { action: "decline" },
  });
  const guidedAnswer = {
    member: guided.address,
    outcome: {
      kind: "answered",
      content: { slot: "mon", note: "[in] private" },
    },
  };
  const withheldAnswer = {
    member: guided.address,
    outcome: { kind: "withheld", reason: "prohibited" },
  };
  const others = [
    {
      member: strictA.address,
      outcome: { kind: "answered", content: { slot: "tue" } },
    },
    { member: strictB.address, outcome: { kind: "declined" } },
  ];
  const result = {
    kind: "collectiveResult",
    op: "all_gather",
    id: answered.operationId,
    to: group,
    question: "Which day works for the review?",
  };
  expect(yield* nextItem(requester)).toMatchObject({
    ...result,
    outcomes: [withheldAnswer, ...others],
  });
  expect(yield* nextItem(guided)).toEqual({
    ...result,
    outcomes: [guidedAnswer, ...others],
  });
  expect(yield* nextItem(strictA)).toMatchObject({
    ...result,
    outcomes: [withheldAnswer, ...others],
  });
  expect(yield* nextItem(strictB)).toMatchObject({
    ...result,
    outcomes: [withheldAnswer, ...others],
  });
}).pipe(Effect.scoped);

it(
  "checks a gather's question at each endpoint and its answers at the requester",
  processTrace(gatherBehavior),
  FIREWALL_TEST_TIMEOUT_MS,
);

it(
  "gives every all_gather member the result while each firewall withholds what it holds",
  processTrace(allGatherBehavior),
  FIREWALL_TEST_TIMEOUT_MS,
);
