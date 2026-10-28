/** @file Pins how the collective layer runs under an installed firewall's admission. */

import { scoped as it } from "@effect/vitest";
import {
  Deferred,
  Duration,
  Effect,
  Either,
  Encoding,
  Fiber,
  Option,
  Schema,
  TestClock,
} from "effect";
import { describe, expect } from "vitest";
import type { BindHold, EngineSendInput } from "../conversations/index.js";
import type { InboundItem } from "./inbound.js";
import type {
  CollectiveAdmission,
  CollectiveOperations,
  GatherCandidate,
  ResultProvenance,
} from "./ports.js";
import {
  alice,
  certifyNext,
  collectiveFailureOf,
  collectiveKey,
  gatherInput,
  makeLayer,
  newObserved,
  type Observed,
  operationIdOf,
  postId,
  questionText,
  recordHashOf,
  requestId,
  requestNonce,
  requestPost,
  requestSendWait,
  send,
  slotSchema,
} from "../../__tests__/collective-operation-fixtures.js";
import { localGuidance } from "../../__tests__/message-policy-fixtures.js";
import {
  type CheckedGuidance,
  FirewallSendError,
} from "../../firewall/outcome/index.js";
import { SendError } from "../conversations/errors.js";
import { InboundMessage } from "../conversations/message.js";
import { AgentAddress } from "../records/values.js";
import { collectiveIdOf } from "./part/index.js";

// @agent-code-guard/regression-only: Each case drives one ordering of check, claim, close and deadline that the admission ports allow.

const group = "group:alice,bob,carol";
const groupMembers = ["agent:alice", "agent:bob", "agent:carol"];
const allGatherId = collectiveIdOf(alice, requestNonce);
const answer = { action: "accept", content: { slot: "mon" } } as const;

/** The refusal every refusing check in these tests returns. */
const refusal = new FirewallSendError({
  checkId: `chk_${Encoding.encodeHex(new Uint8Array(32).fill(7))}`,
  refusal: "norm-violation",
  feedback: [{ nextAction: "revise", text: "Ask the facilitator first." }],
});

/** A check suspended until a test opens it, after signalling that it started. */
interface CheckGate {
  readonly entered: Deferred.Deferred<undefined>;
  readonly open: Deferred.Deferred<undefined>;
}

/**
 * How a firewall double decides: which posts it refuses, whether it refuses
 * gathers, a gate on its post checks and one on its gather checks, whether
 * a gather's request posts never certify, the advice an admitting check
 * gives, and whether an admitted post fails before it binds (`bindFails`)
 * or after (`postFails`).
 */
interface DoubleOptions {
  readonly refusePost?: (input: EngineSendInput) => boolean;
  readonly refuseGather?: boolean;
  readonly gate?: CheckGate;
  readonly gatherGate?: CheckGate;
  readonly requestsHang?: boolean;
  readonly guidance?: CheckedGuidance;
  readonly postFails?: SendError;
  readonly bindFails?: SendError;
}

/** What a firewall double saw. */
interface FirewallDouble {
  readonly admission: CollectiveAdmission;
  readonly checked: EngineSendInput[];
  readonly gathers: GatherCandidate[];
  readonly admittedPosts: EngineSendInput[];
}

/**
 * A firewall double with the real admission's order: each post is checked
 * first; an admitted post then takes the layer's hold and binds, and a
 * refused one takes no hold. A gather is admitted unless `refuseGather`, and
 * its posts go through the sender the admission returns.
 */
function firewallDouble(
  observed: Observed,
  options: DoubleOptions = {},
): FirewallDouble {
  const checked: EngineSendInput[] = [];
  const gathers: GatherCandidate[] = [];
  const admittedPosts: EngineSendInput[] = [];
  const double = { checked, gathers, admittedPosts };
  return {
    ...double,
    admission: {
      bindPost: (input, hold) =>
        checkPost(observed, double.checked, options, { input, hold }),
      admitGather: (candidate) =>
        admitGather(observed, double, options, candidate),
    },
  };
}

function checkPost<E>(
  observed: Observed,
  checked: EngineSendInput[],
  options: DoubleOptions,
  post: { readonly input: EngineSendInput; readonly hold: BindHold<E> },
) {
  return Effect.gen(function* () {
    checked.push(post.input);
    if (options.gate !== undefined) {
      yield* Deferred.succeed(options.gate.entered, undefined);
      yield* Deferred.await(options.gate.open);
    }
    if (options.refusePost?.(post.input) === true) {
      return yield* refusal;
    }
    if (options.bindFails !== undefined) {
      return yield* options.bindFails;
    }
    yield* post.hold;
    return {
      certified:
        options.postFails === undefined
          ? certifyNext(observed, post.input)
          : Effect.fail(options.postFails),
      guidance: options.guidance,
    };
  });
}

function admitGather(
  observed: Observed,
  double: Pick<FirewallDouble, "gathers" | "admittedPosts">,
  options: DoubleOptions,
  candidate: GatherCandidate,
) {
  double.gathers.push(candidate);
  const sender = (input: EngineSendInput) => {
    double.admittedPosts.push(input);
    return options.requestsHang === true
      ? Effect.never
      : certifyNext(observed, input);
  };
  const gated =
    options.gatherGate === undefined
      ? Effect.void
      : Deferred.succeed(options.gatherGate.entered, undefined).pipe(
          Effect.zipRight(Deferred.await(options.gatherGate.open)),
        );
  return gated.pipe(
    Effect.zipRight(
      options.refuseGather === true
        ? Effect.fail(refusal)
        : Effect.succeed({
            sendRequest: sender,
            ...(options.guidance === undefined
              ? {}
              : { guidance: options.guidance }),
          }),
    ),
  );
}

const allGatherRequest = {
  kind: "operation",
  op: "all_gather",
  id: allGatherId,
  nonce: requestNonce,
  deadlineAt: 60_000,
  requestedSchema: slotSchema,
};

/** Classify Bob's gather request to alice and settle its admission. */
function receiveGatherRequest(layer: CollectiveOperations, presented: boolean) {
  return layer
    .classify({
      message: requestPost("agent:bob", 60_000),
      recordHash: recordHashOf(1),
    })
    .pipe(Effect.tap(() => layer.settleRequest(requestId, presented)));
}

/** Classify a second gather request from Bob to alice, open for a minute, and show it. */
function receiveSecondGatherRequest(layer: CollectiveOperations) {
  const nonce = "S".repeat(43);
  const id = collectiveIdOf(
    Schema.decodeUnknownSync(AgentAddress)("agent:bob"),
    nonce,
  );
  return layer
    .classify({
      message: Schema.decodeUnknownSync(InboundMessage)({
        kind: "direct",
        postId: postId(2),
        address: "agent:bob",
        sender: "agent:bob",
        content: [
          { type: "text", text: questionText },
          {
            type: "data",
            value: {
              [collectiveKey]: {
                ...allGatherRequest,
                op: "gather",
                id,
                nonce,
              },
            },
          },
        ],
      }),
      recordHash: recordHashOf(2),
    })
    .pipe(Effect.tap(() => layer.settleRequest(id, true)));
}

/** Classify alice's all_gather request at Bob and settle its admission. */
function receiveAllGatherRequest(
  layer: CollectiveOperations,
  presented: boolean,
) {
  return classifyGroupPost(layer, "agent:alice", 10, allGatherRequest).pipe(
    Effect.tap(() => layer.settleRequest(allGatherId, presented)),
  );
}

/** Classify one group post from `sender` under the record hash of `byte`. */
function classifyGroupPost(
  layer: CollectiveOperations,
  sender: string,
  byte: number,
  value: object,
) {
  return layer.classify({
    message: Schema.decodeUnknownSync(InboundMessage)({
      kind: "group",
      postId: postId(byte),
      address: group,
      sender,
      members: groupMembers,
      content: [
        ...(value === allGatherRequest
          ? [{ type: "text", text: questionText }]
          : []),
        { type: "data", value: { [collectiveKey]: value } },
      ],
    }),
    recordHash: recordHashOf(byte),
  });
}

const allGatherInput = {
  to: group,
  text: questionText,
  collective: { op: "all_gather", deadline: 60, requestedSchema: slotSchema },
};

/** Records each emitted item with the provenance it carries. */
function recordProvenance(observed: Observed, provenance: ResultProvenance[]) {
  return {
    emit: (item: InboundItem, carried?: ResultProvenance) =>
      Effect.sync(() => {
        observed.emitted.push(item);
        if (carried !== undefined) {
          provenance.push(carried);
        }
      }),
  };
}

function refusesAGatherOnTheToolCall() {
  return Effect.gen(function* () {
    const observed = newObserved();
    const firewall = firewallDouble(observed, { refuseGather: true });
    const layer = yield* makeLayer(observed, {
      admission: firewall.admission,
    });

    const failure = yield* collectiveFailureOf(
      send(layer, gatherInput(), "inbound"),
    );
    yield* TestClock.adjust(Duration.minutes(2));

    expect(failure).toEqual(refusal);
    expect(firewall.gathers).toHaveLength(1);
    expect(observed.sent).toEqual([]);
    expect(observed.emitted).toEqual([]);
  });
}

function sendsGatherPostsThroughTheAdmittedSender() {
  return Effect.gen(function* () {
    const observed = newObserved();
    const firewall = firewallDouble(observed);
    const layer = yield* makeLayer(observed, {
      admission: firewall.admission,
    });

    yield* send(layer, gatherInput()).pipe(Effect.flatMap(operationIdOf));

    const [admitted] = firewall.gathers;
    expect(admitted?.to).toBe(group);
    expect(firewall.admittedPosts).toEqual([
      { to: "agent:bob", content: admitted?.content },
      { to: "agent:carol", content: admitted?.content },
    ]);
    expect(firewall.checked).toEqual([]);
  });
}

function returnsTheAdmittingChecksAdvice() {
  return Effect.gen(function* () {
    const advice = localGuidance(5);
    const observed = newObserved();
    const firewall = firewallDouble(observed, { guidance: advice });
    const layer = yield* makeLayer(observed, {
      admission: firewall.admission,
    });
    yield* receiveGatherRequest(layer, true);

    const answered = yield* send(layer, {
      to: "agent:bob",
      collectiveResponse: answer,
    });
    const gathered = yield* send(layer, gatherInput());
    const posted = yield* send(layer, { to: "agent:bob", text: "Tuesday." });
    const allGathered = yield* send(layer, allGatherInput);

    expect(answered).toMatchObject({ guidance: advice });
    expect(gathered).toMatchObject({ guidance: advice });
    expect(posted).toMatchObject({ guidance: advice });
    expect(allGathered).toMatchObject({ guidance: advice });
  });
}

function keepsAnAdmittedAnswersAdviceWhenItsFailureArrivesInbound() {
  return Effect.gen(function* () {
    const advice = localGuidance(6);
    const observed = newObserved();
    const firewall = firewallDouble(observed, {
      guidance: advice,
      postFails: new SendError({ reason: "network-unavailable" }),
    });
    const layer = yield* makeLayer(observed, {
      admission: firewall.admission,
    });
    yield* receiveGatherRequest(layer, true);

    const completed = yield* send(
      layer,
      { to: "agent:bob", collectiveResponse: answer },
      "inbound",
    );

    expect(completed).toEqual({
      operationId: requestId,
      postIds: [],
      guidance: advice,
    });
    expect(observed.emitted).toMatchObject([
      { kind: "operationFailed", id: requestId },
    ]);
  });
}

function keepsAnAdmittedAllGathersAdviceWhenItsAbandonArrivesInbound() {
  return Effect.gen(function* () {
    const advice = localGuidance(7);
    const observed = newObserved();
    const layer = yield* makeLayer(observed, {
      admission: firewallDouble(observed, {
        guidance: advice,
        postFails: new SendError({ reason: "network-unavailable" }),
      }).admission,
    });

    const completed = yield* send(layer, allGatherInput, "inbound");
    yield* TestClock.adjust(Duration.minutes(2));

    expect(completed).toMatchObject({ postIds: [], guidance: advice });
    expect(observed.emitted).toMatchObject([{ kind: "operationFailed" }]);
    expect(observed.emitted).toHaveLength(1);
  });
}

function keepsAnAdmittedGathersAdviceWhenItsDeadlinePassesDuringTheCheck() {
  return Effect.gen(function* () {
    const advice = localGuidance(8);
    const observed = newObserved();
    const gatherGate = {
      entered: yield* Deferred.make<undefined>(),
      open: yield* Deferred.make<undefined>(),
    };
    const layer = yield* makeLayer(observed, {
      admission: firewallDouble(observed, { gatherGate, guidance: advice })
        .admission,
    });

    const sending = yield* send(layer, gatherInput(), "inbound").pipe(
      Effect.fork,
    );
    yield* Deferred.await(gatherGate.entered);
    yield* TestClock.adjust(Duration.seconds(61));
    yield* Deferred.succeed(gatherGate.open, undefined);

    expect(yield* Fiber.join(sending)).toMatchObject({
      postIds: [],
      guidance: advice,
    });
    expect(observed.sent).toEqual([]);
    expect(observed.emitted).toMatchObject([{ kind: "operationFailed" }]);
  });
}

function refusesAnAllGatherWhoseBindFailsNamingEveryMember() {
  return Effect.gen(function* () {
    const observed = newObserved();
    const layer = yield* makeLayer(observed, {
      admission: firewallDouble(observed, {
        bindFails: new SendError({ reason: "network-unavailable" }),
      }).admission,
    });

    const failure = yield* collectiveFailureOf(send(layer, allGatherInput));
    yield* TestClock.adjust(Duration.minutes(2));

    expect(failure).toEqual({
      kind: "members-unreachable",
      members: [
        { member: "agent:bob", reason: "network-unavailable" },
        { member: "agent:carol", reason: "network-unavailable" },
      ],
    });
    expect(observed.emitted).toEqual([]);
  });
}

function refusesAnAllGatherOnTheToolCall() {
  return Effect.gen(function* () {
    const observed = newObserved();
    const firewall = firewallDouble(observed, { refusePost: () => true });
    const layer = yield* makeLayer(observed, {
      admission: firewall.admission,
    });

    const failure = yield* collectiveFailureOf(
      send(layer, allGatherInput, "inbound"),
    );
    yield* TestClock.adjust(Duration.minutes(2));

    expect(failure).toEqual(refusal);
    expect(firewall.checked.map(({ to }) => to)).toEqual([group]);
    expect(observed.sent).toEqual([]);
    expect(observed.emitted).toEqual([]);
  });
}

function keepsARequestOpenAfterARefusedAnswer() {
  return Effect.gen(function* () {
    const observed = newObserved();
    const refusals = { remaining: 1 };
    const firewall = firewallDouble(observed, {
      refusePost: () => {
        refusals.remaining -= 1;
        return refusals.remaining >= 0;
      },
    });
    const layer = yield* makeLayer(observed, {
      admission: firewall.admission,
    });
    yield* receiveGatherRequest(layer, true);
    const response = { to: "agent:bob", collectiveResponse: answer };

    const refused = yield* collectiveFailureOf(
      send(layer, response, "inbound"),
    );
    const answered = yield* send(layer, response);

    expect(refused).toEqual(refusal);
    expect(answered).toMatchObject({ operationId: requestId });
    expect(observed.sent).toHaveLength(1);
    expect(observed.emitted).toEqual([]);
  });
}

function takesNoAnswerUntilShown() {
  return Effect.gen(function* () {
    const observed = newObserved();
    const layer = yield* makeLayer(observed, {
      admission: firewallDouble(observed).admission,
    });
    const response = { to: "agent:bob", collectiveResponse: answer };

    const item = yield* layer.classify({
      message: requestPost("agent:bob", 60_000),
      recordHash: recordHashOf(1),
    });
    const beforeAdmission = yield* collectiveFailureOf(send(layer, response));
    yield* layer.settleRequest(requestId, false);
    const afterWithholding = yield* collectiveFailureOf(send(layer, response));
    yield* layer.settleRequest(requestId, true);
    const afterLateSettle = yield* collectiveFailureOf(send(layer, response));

    expect(Option.getOrNull(item)).toMatchObject({
      kind: "collectiveRequest",
      id: requestId,
    });
    expect(beforeAdmission).toEqual({ kind: "request-none" });
    expect(afterWithholding).toEqual({ kind: "request-none" });
    expect(afterLateSettle).toEqual({ kind: "request-none" });
    expect(observed.sent).toEqual([]);
  });
}

function answersAShownRequest() {
  return Effect.gen(function* () {
    const observed = newObserved();
    const layer = yield* makeLayer(observed, {
      admission: firewallDouble(observed).admission,
    });
    yield* receiveGatherRequest(layer, true);

    const answered = yield* send(layer, {
      to: "agent:bob",
      collectiveResponse: answer,
    });

    expect(answered).toMatchObject({ operationId: requestId });
    expect(observed.sent.map(({ to }) => to)).toEqual(["agent:bob"]);
  });
}

function closesAWithheldAllGatherAtAMember() {
  return Effect.gen(function* () {
    const observed = newObserved();
    const provenance: ResultProvenance[] = [];
    const layer = yield* makeLayer(observed, {
      self: "agent:bob",
      admission: firewallDouble(observed).admission,
      ...recordProvenance(observed, provenance),
    });
    yield* receiveAllGatherRequest(layer, false);

    yield* classifyGroupPost(layer, "agent:carol", 13, {
      kind: "response",
      id: allGatherId,
      ...answer,
    });
    yield* classifyGroupPost(layer, "agent:alice", 14, {
      kind: "close",
      id: allGatherId,
      included: [recordHashOf(13)],
    });

    expect(observed.emitted).toMatchObject([
      {
        kind: "collectiveResult",
        id: allGatherId,
        question: questionText,
        outcomes: [
          { member: "agent:bob", outcome: { kind: "no-answer" } },
          { member: "agent:carol", outcome: { kind: "answered" } },
        ],
      },
    ]);
    expect(provenance).toEqual([
      {
        answers: [{ member: "agent:carol", recordHash: recordHashOf(13) }],
        request: recordHashOf(10),
      },
    ]);
  });
}

function postsNothingWhenTheAllGatherClosesDuringTheCheck() {
  return Effect.gen(function* () {
    const observed = newObserved();
    const gate = {
      entered: yield* Deferred.make<undefined>(),
      open: yield* Deferred.make<undefined>(),
    };
    const layer = yield* makeLayer(observed, {
      self: "agent:bob",
      admission: firewallDouble(observed, { gate }).admission,
    });
    yield* receiveAllGatherRequest(layer, true);

    const answering = yield* send(layer, {
      to: group,
      collectiveResponse: answer,
    }).pipe(Effect.either, Effect.fork);
    yield* Deferred.await(gate.entered);
    yield* classifyGroupPost(layer, "agent:alice", 14, {
      kind: "close",
      id: allGatherId,
      included: [],
    });
    yield* Deferred.succeed(gate.open, undefined);

    expect(yield* Fiber.join(answering)).toMatchObject({
      _tag: "Left",
      left: { failure: { kind: "request-expired" } },
    });
    expect(observed.sent).toEqual([]);
    expect(observed.emitted).toMatchObject([
      {
        kind: "collectiveResult",
        outcomes: [
          { member: "agent:bob", outcome: { kind: "no-answer" } },
          { member: "agent:carol", outcome: { kind: "no-answer" } },
        ],
      },
    ]);
  });
}

function postsNothingWhenTheDeadlinePassesDuringTheCheck() {
  return Effect.gen(function* () {
    const observed = newObserved();
    const gate = {
      entered: yield* Deferred.make<undefined>(),
      open: yield* Deferred.make<undefined>(),
    };
    const layer = yield* makeLayer(observed, {
      admission: firewallDouble(observed, { gate }).admission,
    });
    yield* receiveGatherRequest(layer, true);

    const answering = yield* send(layer, {
      to: "agent:bob",
      collectiveResponse: answer,
    }).pipe(Effect.either, Effect.fork);
    yield* Deferred.await(gate.entered);
    yield* TestClock.adjust(Duration.seconds(61));
    yield* Deferred.succeed(gate.open, undefined);

    expect(yield* Fiber.join(answering)).toMatchObject({
      _tag: "Left",
      left: { failure: { kind: "request-expired" } },
    });
    expect(observed.sent).toEqual([]);
  });
}

function answersTheMatchedRequestWhenAnotherOpensDuringTheCheck() {
  return Effect.gen(function* () {
    const observed = newObserved();
    const gate = {
      entered: yield* Deferred.make<undefined>(),
      open: yield* Deferred.make<undefined>(),
    };
    const layer = yield* makeLayer(observed, {
      admission: firewallDouble(observed, { gate }).admission,
    });
    yield* receiveGatherRequest(layer, true);

    const answering = yield* send(layer, {
      to: "agent:bob",
      collectiveResponse: answer,
    }).pipe(Effect.fork);
    yield* Deferred.await(gate.entered);
    yield* receiveSecondGatherRequest(layer);
    yield* Deferred.succeed(gate.open, undefined);
    yield* Fiber.join(answering);

    expect(observed.sent).toMatchObject([
      {
        to: "agent:bob",
        content: [
          { value: { [collectiveKey]: { kind: "response", id: requestId } } },
        ],
      },
    ]);
  });
}

function sendsOneOfTwoConcurrentAnswers() {
  return Effect.gen(function* () {
    const observed = newObserved();
    const gate = {
      entered: yield* Deferred.make<undefined>(),
      open: yield* Deferred.make<undefined>(),
    };
    const firewall = firewallDouble(observed, { gate });
    const layer = yield* makeLayer(observed, {
      admission: firewall.admission,
    });
    yield* receiveGatherRequest(layer, true);
    const response = { to: "agent:bob", collectiveResponse: answer };

    const first = yield* send(layer, response).pipe(Effect.either, Effect.fork);
    const second = yield* send(layer, response).pipe(
      Effect.either,
      Effect.fork,
    );
    yield* Effect.yieldNow().pipe(
      Effect.repeat({ until: () => firewall.checked.length === 2 }),
    );
    yield* Deferred.succeed(gate.open, undefined);
    const refusals = [yield* Fiber.join(first), yield* Fiber.join(second)]
      .map(Either.getLeft)
      .flatMap(Option.toArray);

    expect(observed.sent).toHaveLength(1);
    expect(refusals).toMatchObject([{ failure: { kind: "request-answered" } }]);
  });
}

function countsTheCheckAgainstTheSendWait() {
  return Effect.gen(function* () {
    const observed = newObserved();
    const gatherGate = {
      entered: yield* Deferred.make<undefined>(),
      open: yield* Deferred.make<undefined>(),
    };
    const layer = yield* makeLayer(observed, {
      admission: firewallDouble(observed, { gatherGate, requestsHang: true })
        .admission,
    });

    const sending = yield* send(layer, gatherInput()).pipe(Effect.fork);
    yield* Deferred.await(gatherGate.entered);
    yield* TestClock.adjust(requestSendWait);
    yield* Deferred.succeed(gatherGate.open, undefined);
    yield* Effect.yieldNow().pipe(Effect.repeatN(20));

    expect(Option.isSome(yield* Fiber.poll(sending))).toBe(true);
  });
}

function carriesCountedAnswersWithAGatherResult() {
  return Effect.gen(function* () {
    const observed = newObserved();
    const provenance: ResultProvenance[] = [];
    const layer = yield* makeLayer(observed, {
      admission: firewallDouble(observed).admission,
      ...recordProvenance(observed, provenance),
    });
    const id = yield* send(layer, gatherInput()).pipe(
      Effect.flatMap(operationIdOf),
    );

    yield* layer.classify({
      message: Schema.decodeUnknownSync(InboundMessage)({
        kind: "direct",
        postId: postId(21),
        address: "agent:carol",
        sender: "agent:carol",
        content: [
          {
            type: "data",
            value: { [collectiveKey]: { kind: "response", id, ...answer } },
          },
        ],
      }),
      recordHash: recordHashOf(21),
    });
    yield* TestClock.adjust(Duration.seconds(60));

    expect(observed.emitted).toMatchObject([
      {
        kind: "collectiveResult",
        outcomes: [
          { member: "agent:bob", outcome: { kind: "no-answer" } },
          { member: "agent:carol", outcome: { kind: "answered" } },
        ],
      },
    ]);
    expect(provenance).toEqual([
      { answers: [{ member: "agent:carol", recordHash: recordHashOf(21) }] },
    ]);
  });
}

function leavesAMemberOwnAnswerOutOfItsProvenance() {
  return Effect.gen(function* () {
    const observed = newObserved();
    const provenance: ResultProvenance[] = [];
    const layer = yield* makeLayer(observed, {
      self: "agent:bob",
      admission: firewallDouble(observed).admission,
      ...recordProvenance(observed, provenance),
    });
    yield* receiveAllGatherRequest(layer, true);
    yield* send(layer, { to: group, collectiveResponse: answer });
    const ownRecord = recordHashOf(100 + observed.sent.length);

    yield* classifyGroupPost(layer, "agent:alice", 14, {
      kind: "close",
      id: allGatherId,
      included: [ownRecord],
    });

    expect(observed.emitted).toMatchObject([
      {
        outcomes: [
          { member: "agent:bob", outcome: { kind: "answered" } },
          { member: "agent:carol", outcome: { kind: "no-answer" } },
        ],
      },
    ]);
    expect(provenance).toEqual([{ answers: [], request: recordHashOf(10) }]);
  });
}

describe("collective sends under a firewall", () => {
  it(
    "returns a refused gather on the tool call, posting nothing and leaving no deadline",
    refusesAGatherOnTheToolCall,
  );
  it(
    "sends a gather's request posts only through the sender its admission returned",
    sendsGatherPostsThroughTheAdmittedSender,
  );
  it(
    "returns once the send's wait has passed, counting the gather's check against it",
    countsTheCheckAgainstTheSendWait,
  );
  it(
    "returns a refused all_gather on the tool call, posting nothing and closing nothing at its deadline",
    refusesAnAllGatherOnTheToolCall,
  );
  it(
    "returns a refused answer on the tool call and leaves its request open",
    keepsARequestOpenAfterARefusedAnswer,
  );
  it(
    "returns each admitted send's advice with it: an answer, a gather, a multicast and an all_gather",
    returnsTheAdmittingChecksAdvice,
  );
  it(
    "keeps an admitted answer's advice when its failure is delivered inbound",
    keepsAnAdmittedAnswersAdviceWhenItsFailureArrivesInbound,
  );
  it(
    "keeps an admitted all_gather's advice when its abandon is delivered inbound",
    keepsAnAdmittedAllGathersAdviceWhenItsAbandonArrivesInbound,
  );
  it(
    "keeps an admitted gather's advice when its deadline passes during the check",
    keepsAnAdmittedGathersAdviceWhenItsDeadlinePassesDuringTheCheck,
  );
  it(
    "refuses an all_gather whose bind fails, naming every member",
    refusesAnAllGatherWhoseBindFailsNamingEveryMember,
  );
});

describe("received requests under a firewall", () => {
  it(
    "takes no answer until its admission settles, nor after it was withheld",
    takesNoAnswerUntilShown,
  );
  it("answers a request once its admission shows it", answersAShownRequest);
  it(
    "still applies an all_gather's close at a member whose request was withheld",
    closesAWithheldAllGatherAtAMember,
  );
});

describe("answers checked before their request is claimed", () => {
  it(
    "posts nothing when the all_gather closes during the answer's check",
    postsNothingWhenTheAllGatherClosesDuringTheCheck,
  );
  it(
    "posts nothing when the deadline passes during the answer's check",
    postsNothingWhenTheDeadlinePassesDuringTheCheck,
  );
  it(
    "sends one of two answers checked at once and refuses the other as answered",
    sendsOneOfTwoConcurrentAnswers,
  );
  it(
    "answers the request it matched when another opens during the answer's check",
    answersTheMatchedRequestWhenAnotherOpensDuringTheCheck,
  );
});

describe("results under a firewall", () => {
  it(
    "carries the record of each counted answer with a gather's result",
    carriesCountedAnswersWithAGatherResult,
  );
  it(
    "leaves a member's own answer out of the records its result carries",
    leavesAMemberOwnAnswerOutOfItsProvenance,
  );
});
