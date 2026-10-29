/**
 * @file Pins all_gather agreement: under every schedule the harness draws,
 * the requester and each honest member publish one result, the same one, and
 * it holds exactly the answers the requester's first close lists.
 *
 * One group conversation is modelled as a single certified chain that every
 * endpoint reads in order, skipping its own records, as the store delivers
 * them. A schedule interleaves at random: each endpoint's deliveries, a
 * member's answer being started, certified into the chain and returned to the
 * member as three separate steps, the deadline, a redelivery of the record
 * an endpoint last classified (a failed acknowledgment), and the posts of a
 * dishonest member `dave` (two answers and a close of his own) and of a
 * dishonest requester (a second close). The coverage counters make the
 * test fail when the draw stops reaching the interleavings it exists for.
 */

import { live as it } from "@effect/vitest";
import {
  Deferred,
  Duration,
  Effect,
  Array as EffectArray,
  Fiber,
  Option,
  Schema,
  type Scope,
  Supervisor,
  TestClock,
  TestContext,
} from "effect";
import { describe, expect } from "vitest";
import type { EngineSentPost } from "../conversations/index.js";
import type { CollectiveMemberOutcome, InboundItem } from "./inbound.js";
import type { CollectiveOperations } from "./ports.js";
import {
  alice,
  collectiveKey,
  operationIdOf,
  postId,
  questionText,
  recordHashOf,
  slotSchema,
} from "../../__tests__/collective-operation-fixtures.js";
import { collectivePersistencePorts } from "../../__tests__/collective-storage-stub.js";
import { InboundMessage } from "../conversations/message.js";
import { Content, type RecordHash } from "../records/index.js";
import { AgentAddress } from "../records/values.js";
import { SendInput } from "./contracts.js";
import { makeCollectiveOperations } from "./index.js";
import { type CollectiveValue, readCollectiveValue } from "./wire/index.js";

const group = "group:alice,bob,carol,dave";
const groupMembers = ["agent:alice", "agent:bob", "agent:carol", "agent:dave"];
const address = Schema.decodeUnknownSync(AgentAddress);
const bob = address("agent:bob");
const carol = address("agent:carol");
const dave = address("agent:dave");

/** How many schedules one run draws; each seed is one reproducible schedule. */
const SCHEDULES = 120;

/** A seeded mulberry32 generator, so a failing seed replays its schedule. */
function seededRandom(seed: number): () => number {
  const state = { value: seed >>> 0 };
  return () => {
    state.value = (state.value + 0x6d2b79f5) >>> 0;
    const mixed = Math.imul(
      state.value ^ (state.value >>> 15),
      state.value | 1,
    );
    const spread =
      mixed ^ (mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61));
    return ((spread ^ (spread >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** One certified record of the group conversation. */
interface ChainRecord {
  readonly sender: AgentAddress;
  readonly byte: number;
  readonly content: Content;
  readonly value: Option.Option<CollectiveValue>;
}

/** A member's answer send, certified and returned by separate schedule steps. */
interface PendingAnswer {
  readonly member: AgentAddress;
  readonly content: Content;
  readonly returned: Deferred.Deferred<EngineSentPost>;
  certifiedAt?: number;
}

/** One honest endpoint: its layer, what it published, and how far it has read. */
interface Endpoint {
  readonly self: AgentAddress;
  readonly layer: CollectiveOperations;
  readonly emitted: InboundItem[];
  /** Resolved when the endpoint first emits an item. */
  readonly published: Deferred.Deferred<undefined>;
  /** Resolved when the endpoint's own answer reaches its send port. */
  readonly answerQueued: Deferred.Deferred<undefined>;
  next: number;
  lastClassified?: ChainRecord;
  /** The endpoint's own answer send, once its host has answered. */
  answering?: Fiber.Fiber<unknown>;
}

/** Interleavings a schedule reached; the run fails if one never occurs. */
interface Coverage {
  heldClose: number;
  ownAnswerAfterClose: number;
  requestAfterDeadline: number;
  secondClose: number;
  forgedClose: number;
  duplicateAnswer: number;
  redeliveredClose: number;
}

/** The dishonest posts a schedule has made so far. */
interface DishonestPosts {
  daveAnswers: number;
  daveClosed: boolean;
  aliceClosedTwice: boolean;
}

interface Harness {
  readonly chain: ChainRecord[];
  readonly pending: PendingAnswer[];
  readonly endpoints: Endpoint[];
  readonly coverage: Coverage;
  readonly posts: DishonestPosts;
  readonly redeliveries: { left: number };
  deadlinePassed: boolean;
}

const collectivePart = (value: object): Content =>
  Schema.decodeUnknownSync(Content)([
    { type: "data", value: { [collectiveKey]: value } },
  ]);

const append = (harness: Harness, sender: AgentAddress, content: Content) =>
  readCollectiveValue(content).pipe(
    Effect.orDie,
    Effect.map((value) => {
      const record = { sender, byte: harness.chain.length + 1, content, value };
      harness.chain.push(record);
      return record;
    }),
  );

const certified = (record: ChainRecord): EngineSentPost => ({
  postId: postId(record.byte),
  recordHash: recordHashOf(record.byte),
});

/**
 * A member's send: queued, with `queued` resolved, then held until the
 * schedule certifies it and returns it.
 */
const queueAnswer = (
  harness: Harness,
  member: AgentAddress,
  content: Content,
  queued: Deferred.Deferred<undefined>,
) =>
  Effect.gen(function* () {
    const returned = yield* Deferred.make<EngineSentPost>();
    harness.pending.push({ member, content, returned });
    yield* Deferred.succeed(queued, undefined);
    return yield* Deferred.await(returned);
  });

const makeEndpoint = (harness: Harness, self: AgentAddress) =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const emitted: InboundItem[] = [];
    const published = yield* Deferred.make<undefined>();
    const answerQueued = yield* Deferred.make<undefined>();
    const layer = yield* makeCollectiveOperations({
      self,
      lookupMember: () => Effect.void,
      ...collectivePersistencePorts((input) =>
        self === alice
          ? append(harness, self, input.content).pipe(Effect.map(certified))
          : queueAnswer(harness, self, input.content, answerQueued),
      ),
      emit: (item) =>
        Effect.sync(() => {
          emitted.push(item);
        }).pipe(
          Effect.zipRight(Deferred.succeed(published, undefined)),
          Effect.asVoid,
        ),
      scope,
    });
    return { self, layer, emitted, published, answerQueued, next: 0 };
  });

/**
 * Run `step` and wait for every fiber it forks, such as the requester's
 * close, so the next draw sees the posts they make.
 */
const withForkedWork = <A, E>(step: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const supervisor = yield* Supervisor.track;
    const value = yield* Effect.supervised(step, supervisor);
    yield* Fiber.awaitAll(yield* supervisor.value);
    return value;
  });

/** Alice's endpoint, the requester's. */
const requesterOf = (endpoints: readonly Endpoint[]) =>
  Effect.fromNullable(
    endpoints.find((endpoint) => endpoint.self === alice),
  ).pipe(Effect.orDie);

/** The next record `endpoint` would classify: the first unread one it did not author. */
const nextRecord = (harness: Harness, endpoint: Endpoint) =>
  harness.chain
    .map((record, index) => ({ index, record }))
    .find(
      ({ index, record }) =>
        index >= endpoint.next && record.sender !== endpoint.self,
    );

const classifyRecord = (endpoint: Endpoint, record: ChainRecord) =>
  withForkedWork(
    endpoint.layer.classify({
      message: Schema.decodeUnknownSync(InboundMessage)({
        kind: "group",
        postId: postId(record.byte),
        address: group,
        sender: record.sender,
        members: groupMembers,
        content: record.content,
      }),
      recordHash: recordHashOf(record.byte),
    }),
  ).pipe(Effect.asVoid);

const isClose = (record: ChainRecord) =>
  Option.exists(record.value, (value) => value.kind === "close");

const isRequesterClose = (record: ChainRecord) =>
  record.sender === alice && isClose(record);

/** Where the requester's first close sits in the chain, or -1 before it closes. */
const firstCloseIndex = (harness: Harness) =>
  harness.chain.findIndex(isRequesterClose);

/** One schedule step: its name and the effect that performs it. */
type Step = readonly [string, Effect.Effect<void>];

function deliverySteps(harness: Harness): Step[] {
  return harness.endpoints.flatMap((endpoint): Step[] => {
    const next = nextRecord(harness, endpoint);
    if (next === undefined) {
      return [];
    }
    return [
      [
        `deliver ${next.record.byte} to ${endpoint.self}`,
        Effect.suspend(() => {
          if (next.index === 0 && harness.deadlinePassed) {
            harness.coverage.requestAfterDeadline += 1;
          }
          endpoint.next = next.index + 1;
          endpoint.lastClassified = next.record;
          return Effect.orDie(classifyRecord(endpoint, next.record));
        }),
      ],
    ];
  });
}

function redeliverySteps(harness: Harness): Step[] {
  if (harness.redeliveries.left === 0) {
    return [];
  }
  return harness.endpoints.flatMap((endpoint): Step[] => {
    const record = endpoint.lastClassified;
    if (record === undefined) {
      return [];
    }
    return [
      [
        `redeliver ${record.byte} to ${endpoint.self}`,
        Effect.suspend(() => {
          harness.redeliveries.left -= 1;
          if (isClose(record)) {
            harness.coverage.redeliveredClose += 1;
          }
          return Effect.orDie(classifyRecord(endpoint, record));
        }),
      ],
    ];
  });
}

/**
 * The answer a member's host gives, naming no request: carol sometimes
 * declines.
 */
const drawResponse = (member: AgentAddress, random: () => number) =>
  member === carol && random() < 0.3
    ? { action: "decline" }
    : { action: "accept", content: { slot: random() < 0.5 ? "mon" : "tue" } };

/**
 * Each member that has seen the request and not answered answers in the
 * group's conversation, where its endpoint finds the one open request. The
 * step ends once the answer is queued at the send port or the send has
 * already been refused.
 */
function answerSteps(
  harness: Harness,
  random: () => number,
  scope: Scope.Scope,
): Step[] {
  return harness.endpoints
    .filter(
      (endpoint) =>
        endpoint.self !== alice &&
        endpoint.answering === undefined &&
        endpoint.next > 0,
    )
    .map((endpoint): Step => {
      const response = drawResponse(endpoint.self, random);
      return [
        `${endpoint.self} answers`,
        Effect.gen(function* () {
          const answering = yield* endpoint.layer
            .send(
              Schema.decodeUnknownSync(SendInput)({
                to: group,
                collectiveResponse: response,
              }),
            )
            .pipe(Effect.either, Effect.forkIn(scope));
          yield* Effect.sync(() => {
            endpoint.answering = answering;
          });
          yield* Effect.raceFirst(
            Deferred.await(endpoint.answerQueued),
            Effect.asVoid(Fiber.await(answering)),
          );
        }),
      ];
    });
}

/** Count a return that follows the member's delivery of the first close. */
function recordReturnCoverage(
  harness: Harness,
  answer: PendingAnswer,
  certifiedAt: number,
): void {
  const firstClose = firstCloseIndex(harness);
  const member = harness.endpoints.find(
    (endpoint) => endpoint.self === answer.member,
  );
  if (firstClose === -1 || member === undefined || member.next <= firstClose) {
    return;
  }
  if (certifiedAt - 1 < firstClose) {
    harness.coverage.heldClose += 1;
  } else {
    harness.coverage.ownAnswerAfterClose += 1;
  }
}

const certifyAnswer = (harness: Harness, answer: PendingAnswer) =>
  append(harness, answer.member, answer.content).pipe(
    Effect.flatMap((record) =>
      Effect.sync(() => {
        answer.certifiedAt = record.byte;
      }),
    ),
  );

/** Return a certified answer to its member and wait for the member's send to finish. */
const returnAnswer = (
  harness: Harness,
  answer: PendingAnswer,
  certifiedAt: number,
) =>
  Effect.gen(function* () {
    harness.pending.splice(harness.pending.indexOf(answer), 1);
    recordReturnCoverage(harness, answer, certifiedAt);
    yield* Deferred.succeed(answer.returned, {
      postId: postId(certifiedAt),
      recordHash: recordHashOf(certifiedAt),
    });
    const answering = yield* Effect.fromNullable(
      harness.endpoints.find((endpoint) => endpoint.self === answer.member)
        ?.answering,
    ).pipe(Effect.orDie);
    yield* Fiber.await(answering);
  });

function pendingSteps(harness: Harness): Step[] {
  return harness.pending.map(
    (answer): Step =>
      answer.certifiedAt === undefined
        ? [`certify ${answer.member}'s answer`, certifyAnswer(harness, answer)]
        : [
            `return ${answer.member}'s answer`,
            returnAnswer(harness, answer, answer.certifiedAt),
          ],
  );
}

/** Posts by dave, who bypasses an endpoint: two answers and a close of his own. */
function daveSteps(harness: Harness, id: string): Step[] {
  const { posts } = harness;
  const answering: Step[] =
    posts.daveAnswers < 2
      ? [
          [
            "dave answers",
            Effect.suspend(() => {
              posts.daveAnswers += 1;
              harness.coverage.duplicateAnswer += posts.daveAnswers - 1;
              return append(
                harness,
                dave,
                collectivePart({
                  kind: "response",
                  id,
                  action: "accept",
                  content: { slot: posts.daveAnswers === 1 ? "mon" : "tue" },
                }),
              );
            }),
          ],
        ]
      : [];
  const closing: Step[] = posts.daveClosed
    ? []
    : [
        [
          "dave closes",
          Effect.suspend(() => {
            posts.daveClosed = true;
            harness.coverage.forgedClose += 1;
            return append(
              harness,
              dave,
              collectivePart({ kind: "close", id, included: [] }),
            );
          }),
        ],
      ];
  return [...answering, ...closing];
}

/** A second close from the requester, listing nothing, once it has closed. */
function secondCloseSteps(harness: Harness, id: string): Step[] {
  const { posts } = harness;
  if (posts.aliceClosedTwice || firstCloseIndex(harness) === -1) {
    return [];
  }
  return [
    [
      "alice closes again",
      Effect.suspend(() => {
        posts.aliceClosedTwice = true;
        harness.coverage.secondClose += 1;
        return append(
          harness,
          alice,
          collectivePart({ kind: "close", id, included: [] }),
        );
      }),
    ],
  ];
}

function deadlineSteps(harness: Harness): Step[] {
  if (harness.deadlinePassed) {
    return [];
  }
  return [
    [
      "deadline",
      Effect.gen(function* () {
        harness.deadlinePassed = true;
        yield* TestClock.adjust(Duration.seconds(60));
        const requester = yield* requesterOf(harness.endpoints);
        yield* Deferred.await(requester.published);
      }),
    ],
  ];
}

/** The outcome a listed record carries, by the answer's action. */
const outcomeOf = (
  listed: Option.Option<CollectiveValue>,
): CollectiveMemberOutcome => {
  const value = Option.getOrUndefined(listed);
  if (value?.kind !== "response") {
    return { kind: "no-answer" };
  }
  return value.action === "accept"
    ? { kind: "answered", content: value.content }
    : { kind: "declined" };
};

/** The result the first close describes: each member's listed answer, in member order. */
const resultOfFirstClose = (harness: Harness, id: string) => {
  const close = harness.chain.find(isRequesterClose);
  const included = Option.fromNullable(close).pipe(
    Option.flatMap((record) => record.value),
    Option.flatMap((value) =>
      value.kind === "close" ? Option.some(value.included) : Option.none(),
    ),
    Option.getOrElse((): readonly RecordHash[] => []),
  );
  const listed = harness.chain.filter((record) =>
    included.includes(recordHashOf(record.byte)),
  );
  return {
    kind: "collectiveResult",
    op: "all_gather",
    id,
    to: group,
    question: questionText,
    outcomes: [bob, carol, dave].map((member) => ({
      member,
      outcome: outcomeOf(
        Option.fromNullable(
          listed.find((record) => record.sender === member),
        ).pipe(Option.flatMap((record) => record.value)),
      ),
    })),
  };
};

/**
 * How likely a step is to be drawn against an ordinary one. The deadline and
 * a member's send returning are drawn rarely, so that most schedules deliver
 * the close to a member before its own send returns, and many close before
 * the deadline.
 */
const stepWeight = (name: string) => {
  if (name === "deadline") {
    return 0.03;
  }
  return name.startsWith("return") ? 0.2 : 1;
};

/** The step a uniform draw in [0, 1) lands on, by step weight. */
const pickStep = (steps: readonly Step[], draw: number) => {
  const total = steps.reduce((sum, [name]) => sum + stepWeight(name), 0);
  const target = { left: draw * total };
  return steps.find(([name]) => {
    target.left -= stepWeight(name);
    return target.left < 0;
  });
};

/** Send through alice's endpoint, the requester's. */
const send = (endpoints: readonly Endpoint[], input: unknown) =>
  requesterOf(endpoints).pipe(
    Effect.flatMap((requester) =>
      requester.layer.send(Schema.decodeUnknownSync(SendInput)(input)),
    ),
  );

/** Build the three honest endpoints and start alice's all_gather. */
const startSchedule = (coverage: Coverage) =>
  Effect.gen(function* () {
    const harness: Harness = {
      chain: [],
      pending: [],
      endpoints: [],
      coverage,
      posts: { daveAnswers: 0, daveClosed: false, aliceClosedTwice: false },
      redeliveries: { left: 3 },
      deadlinePassed: false,
    };
    const endpoints = yield* Effect.forEach(
      [alice, bob, carol],
      (self) => makeEndpoint(harness, self),
      { concurrency: 1 },
    );
    harness.endpoints.push(...endpoints);
    const outcome = yield* send(harness.endpoints, {
      to: group,
      text: questionText,
      collective: {
        op: "all_gather",
        deadline: 60,
        requestedSchema: slotSchema,
      },
    });
    const id = yield* operationIdOf(outcome);
    return { harness, id };
  });

/** Run one seeded schedule until no step is left, and return the harness. */
const runSchedule = (seed: number, coverage: Coverage) =>
  Effect.gen(function* () {
    const random = seededRandom(seed);
    const scope = yield* Effect.scope;
    const { harness, id } = yield* startSchedule(coverage);
    for (;;) {
      const step = pickStep(
        [
          ...deliverySteps(harness),
          ...answerSteps(harness, random, scope),
          ...pendingSteps(harness),
          ...daveSteps(harness, id),
          ...secondCloseSteps(harness, id),
          ...redeliverySteps(harness),
          ...deadlineSteps(harness),
        ],
        random(),
      );
      if (step === undefined) {
        return { harness, id };
      }
      yield* step[1];
    }
  }).pipe(Effect.scoped, Effect.provide(TestContext.TestContext));

/** Every honest endpoint published exactly the result the first close lists. */
function expectAgreement(seed: number, harness: Harness, id: string): void {
  const expected = resultOfFirstClose(harness, id);
  for (const endpoint of harness.endpoints) {
    expect(endpoint.emitted, `seed ${seed}, ${endpoint.self}`).toEqual([
      expected,
    ]);
  }
}

function expectEveryInterleavingReached(coverage: Coverage): void {
  for (const [interleaving, count] of Object.entries(coverage)) {
    expect(count, interleaving).toBeGreaterThan(0);
  }
}

function everyEndpointPublishesTheFirstCloseResult() {
  const coverage: Coverage = {
    heldClose: 0,
    ownAnswerAfterClose: 0,
    requestAfterDeadline: 0,
    secondClose: 0,
    forgedClose: 0,
    duplicateAnswer: 0,
    redeliveredClose: 0,
  };
  return Effect.forEach(
    EffectArray.range(1, SCHEDULES),
    (seed) =>
      runSchedule(seed, coverage).pipe(
        Effect.andThen(({ harness, id }) => {
          expectAgreement(seed, harness, id);
        }),
      ),
    { concurrency: 1, discard: true },
  ).pipe(
    Effect.andThen(() => {
      expectEveryInterleavingReached(coverage);
    }),
  );
}

describe("all_gather agreement", () => {
  it(
    "publishes the first close's result at the requester and every honest member",
    everyEndpointPublishesTheFirstCloseResult,
    60_000,
  );
});
