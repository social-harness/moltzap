/** @file A requester and three members run all_gather operations through four real daemons. */

import { CollectiveError } from "@moltzap/client";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { processTrace } from "./daemon-process-harness.js";
import {
  acquireParticipants,
  groupRound,
  measuredDeadlineSeconds,
  nextItem,
  type Participant,
  send,
} from "./participants.js";

/**
 * Each test starts PGlite, the Registry, the Router and four daemons, and the
 * silent member's test waits out a deadline of several measured post rounds.
 * Beside a second full Client suite (load average 30 to 42 on 8 cores) that
 * test has taken 113 to 127 seconds, most of it process startup. Apart from
 * that measured deadline, the limit is the only wall-clock bound these traces
 * set themselves.
 */
const ALL_GATHER_TEST_TIMEOUT_MS = 300_000;
/**
 * The deadline of an all_gather every member answers: the test's own limit,
 * so only the answers close it and no deadline races them.
 */
const ANSWERED_DEADLINE_SECONDS = ALL_GATHER_TEST_TIMEOUT_MS / 1000;
const question = "Which day works for the review?";
const group =
  "group:all-gather-member-a,all-gather-member-b,all-gather-member-c,all-gather-requester";
const slotSchema = {
  type: "object",
  properties: { slot: { type: "string", enum: ["mon", "tue"] } },
  required: ["slot"],
} as const;

const allGather = (requester: Participant, to: string, deadline: number) =>
  send(requester, {
    to,
    text: question,
    collective: { op: "all_gather", deadline, requestedSchema: slotSchema },
  });

const answer = (member: Participant, slot: string) =>
  send(member, {
    to: group,
    collectiveResponse: { action: "accept", content: { slot } },
  });

/** The requester and the three members every all_gather trace starts. */
const acquireFour = Effect.gen(function* () {
  const [requester, first, second, third] = yield* acquireParticipants([
    "all-gather-requester",
    "all-gather-member-a",
    "all-gather-member-b",
    "all-gather-member-c",
  ]);
  return requester === undefined ||
    first === undefined ||
    second === undefined ||
    third === undefined
    ? yield* Effect.dieMessage("expected four participants")
    : { requester, first, second, third };
});

const allAnsweredBehavior = Effect.gen(function* () {
  const { requester, first, second, third } = yield* acquireFour;

  const unreachable = yield* allGather(
    requester,
    "group:all-gather-member-a,all-gather-nobody,all-gather-requester",
    60,
  ).pipe(Effect.flip);
  expect(unreachable).toBeInstanceOf(CollectiveError);
  expect(unreachable).toMatchObject({
    failure: {
      kind: "members-unreachable",
      members: [{ member: "agent:all-gather-nobody", reason: "unknown-agent" }],
    },
  });

  const started = yield* allGather(requester, group, ANSWERED_DEADLINE_SECONDS);
  const request = {
    kind: "collectiveRequest",
    op: "all_gather",
    id: started.operationId,
    postId: expect.any(String),
    from: requester.address,
    to: group,
    question,
    requestedSchema: slotSchema,
    deadlineAt: expect.any(Number),
  };
  expect(yield* nextItem(first)).toEqual(request);
  expect(yield* nextItem(second)).toEqual(request);
  expect(yield* nextItem(third)).toEqual(request);

  yield* answer(first, "tue");
  yield* answer(second, "mon");
  yield* send(third, {
    to: group,
    collectiveResponse: { action: "decline" },
  });

  const requesterResult = yield* nextItem(requester);
  expect(requesterResult).toEqual({
    kind: "collectiveResult",
    op: "all_gather",
    id: started.operationId,
    to: group,
    question,
    outcomes: [
      {
        member: first.address,
        outcome: { kind: "answered", content: { slot: "tue" } },
      },
      {
        member: second.address,
        outcome: { kind: "answered", content: { slot: "mon" } },
      },
      { member: third.address, outcome: { kind: "declined" } },
    ],
  });
  expect(yield* nextItem(first)).toEqual(requesterResult);
  expect(yield* nextItem(second)).toEqual(requesterResult);
  expect(yield* nextItem(third)).toEqual(requesterResult);
}).pipe(Effect.scoped);

/**
 * Two members answer and the third stays silent, so the all_gather closes at
 * its measured deadline. The members take the request together and the two
 * answer together; both answers extend the one group head, so they certify
 * one after the other within the deadline's rounds.
 */
const silentMemberBehavior = Effect.gen(function* () {
  const { requester, first, second, third } = yield* acquireFour;
  const deadline = yield* measuredDeadlineSeconds(
    groupRound(requester, [first, second, third]),
  );

  const started = yield* allGather(requester, group, deadline);
  yield* Effect.all([nextItem(first), nextItem(second), nextItem(third)], {
    concurrency: 3,
  });
  yield* Effect.all([answer(first, "mon"), answer(second, "mon")], {
    concurrency: 2,
  });

  const requesterResult = yield* nextItem(requester);
  expect(requesterResult).toMatchObject({
    kind: "collectiveResult",
    op: "all_gather",
    id: started.operationId,
    outcomes: [
      { member: first.address, outcome: { kind: "answered" } },
      { member: second.address, outcome: { kind: "answered" } },
      { member: third.address, outcome: { kind: "no-answer" } },
    ],
  });
  expect(yield* nextItem(first)).toEqual(requesterResult);
  expect(yield* nextItem(second)).toEqual(requesterResult);
  expect(yield* nextItem(third)).toEqual(requesterResult);
}).pipe(Effect.scoped);

it(
  "gives the requester and every member the same all_gather result",
  processTrace(allAnsweredBehavior),
  ALL_GATHER_TEST_TIMEOUT_MS,
);

it(
  "closes an all_gather at the deadline without the silent member",
  processTrace(silentMemberBehavior),
  ALL_GATHER_TEST_TIMEOUT_MS,
);
