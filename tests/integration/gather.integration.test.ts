/** @file Three real daemons run gather operations end to end. */

import { CollectiveError } from "@moltzap/client";
import { Effect } from "effect";
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
import { anyNumber, anyString } from "./test-matchers.js";

const requireThree = (participants: readonly Participant[]) => {
  const [requester, first, second] = participants;
  return requester === undefined || first === undefined || second === undefined
    ? Effect.dieMessage("expected three participants")
    : Effect.succeed({ requester, first, second });
};

/** The requester and the two members every gather trace starts. */
const acquireThree = acquireParticipants([
  "gather-requester",
  "gather-member-a",
  "gather-member-b",
]).pipe(Effect.flatMap(requireThree));

const question = "Which day works for the review?";

const slotSchema = {
  type: "object",
  properties: { slot: { type: "string", enum: ["mon", "tue"] } },
  required: ["slot"],
} as const;

const gather = (
  requester: Participant,
  members: readonly Participant[],
  deadline: number,
) =>
  send(requester, {
    to: groupAddress([requester, ...members]),
    text: question,
    collective: { op: "gather", deadline, requestedSchema: slotSchema },
  });

/**
 * Each test starts PGlite, the Registry, the Router and three daemons, and the
 * silent member's test waits out a deadline of several measured post rounds.
 * Beside a second full Client suite (load average 31 to 49 on 8 cores) that
 * test has taken 176 to 188 seconds, most of it process startup. Apart from
 * that measured deadline, the limit is the only wall-clock bound these traces
 * set themselves.
 */
const GATHER_TEST_TIMEOUT_MS = 240_000;

/**
 * The deadline of a gather every member answers: the test's own limit, so
 * only the answers close it and no deadline races them.
 */
const ANSWERED_DEADLINE_SECONDS = GATHER_TEST_TIMEOUT_MS / 1000;

interface GatherParticipants {
  readonly requester: Participant;
  readonly first: Participant;
  readonly second: Participant;
}

/** A refused gather posts nothing, so the following request is each member's first item. */
function expectUnreachableGatherRefused({ requester }: GatherParticipants) {
  return Effect.gen(function* () {
    const unreachable = yield* send(requester, {
      to: `group:gather-member-a,gather-nobody,gather-requester`,
      text: question,
      collective: { op: "gather", deadline: 60, requestedSchema: slotSchema },
    }).pipe(Effect.flip);
    expect(unreachable).toBeInstanceOf(CollectiveError);
    expect(unreachable).toMatchObject({
      failure: {
        kind: "members-unreachable",
        members: [{ member: "agent:gather-nobody", reason: "unknown-agent" }],
      },
    });
  });
}

function startGatherAndExpectRequests({
  requester,
  first,
  second,
}: GatherParticipants) {
  return Effect.gen(function* () {
    const started = yield* gather(
      requester,
      [first, second],
      ANSWERED_DEADLINE_SECONDS,
    );
    const firstRequest = yield* nextItem(first);
    const secondRequest = yield* nextItem(second);
    expect(firstRequest).toEqual({
      kind: "collectiveRequest",
      op: "gather",
      id: started.operationId,
      postId: anyString,
      from: requester.address,
      to: requester.address,
      question,
      requestedSchema: slotSchema,
      deadlineAt: anyNumber,
    });
    expect(secondRequest).toMatchObject({ id: started.operationId });
    return started;
  });
}

const allAnsweredBehavior = Effect.gen(function* () {
  const participants = yield* acquireThree;
  yield* expectUnreachableGatherRefused(participants);
  const started = yield* startGatherAndExpectRequests(participants);
  yield* expectInvalidAnswerRefused(participants.first, participants.requester);
  yield* answerGatherAndExpectResult(participants, started.operationId);
}).pipe(Effect.scoped);

/**
 * The deadline is measured on a post to the group of every participant. The
 * gather's requests go to direct conversations, which that post leaves
 * untouched.
 */
const silentMemberBehavior = Effect.gen(function* () {
  const { requester, first, second } = yield* acquireThree;
  const deadline = yield* measuredDeadlineSeconds(
    groupRound(requester, [first, second]),
  );

  const started = yield* gather(requester, [first, second], deadline);
  yield* Effect.all([nextItem(first), nextItem(second)], { concurrency: 2 });
  yield* send(first, {
    to: requester.address,
    collectiveResponse: { action: "accept", content: { slot: "mon" } },
  });

  expect(yield* nextItem(requester)).toMatchObject({
    kind: "collectiveResult",
    op: "gather",
    id: started.operationId,
    outcomes: [
      {
        member: first.address,
        outcome: { kind: "answered", content: { slot: "mon" } },
      },
      { member: second.address, outcome: { kind: "no-answer" } },
    ],
  });
  const late = yield* send(second, {
    to: requester.address,
    collectiveResponse: { action: "decline" },
  }).pipe(Effect.flip);
  expect(late).toMatchObject({ failure: { kind: "request-expired" } });
}).pipe(Effect.scoped);

it(
  "gathers every member's answer through three real daemons",
  processTrace(allAnsweredBehavior),
  GATHER_TEST_TIMEOUT_MS,
);

it(
  "reports a silent member as no-answer at the deadline",
  processTrace(silentMemberBehavior),
  GATHER_TEST_TIMEOUT_MS,
);

function expectInvalidAnswerRefused(
  first: Participant,
  requester: Participant,
) {
  return Effect.gen(function* () {
    const invalid = yield* send(first, {
      to: requester.address,
      collectiveResponse: { action: "accept", content: { slot: "sun" } },
    }).pipe(Effect.flip);
    expect(invalid).toMatchObject({
      failure: { kind: "answer-invalid", fields: [{ field: "slot" }] },
    });
  });
}

function answerGatherAndExpectResult(
  { requester, first, second }: GatherParticipants,
  operationId?: string,
) {
  return Effect.gen(function* () {
    yield* send(first, {
      to: requester.address,
      collectiveResponse: { action: "accept", content: { slot: "tue" } },
    });
    yield* send(second, {
      to: requester.address,
      collectiveResponse: { action: "decline" },
    });
    expect(yield* nextItem(requester)).toEqual({
      kind: "collectiveResult",
      op: "gather",
      id: operationId,
      to: "group:gather-member-a,gather-member-b,gather-requester",
      question,
      outcomes: [
        {
          member: first.address,
          outcome: { kind: "answered", content: { slot: "tue" } },
        },
        { member: second.address, outcome: { kind: "declined" } },
      ],
    });
  });
}
