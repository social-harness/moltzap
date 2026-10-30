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
import { testAgentView } from "../../__tests__/agent-card-fixtures.js";
import { collectiveOperationId } from "../../__tests__/collective-id-fixtures.js";
import {
  alice,
  certifyNext,
  collectiveFailureOf,
  collectiveKey,
  gatherInput,
  makeLayer,
  msgId,
  newObserved,
  type Observed,
  operationIdOf,
  questionText,
  recordHashOf,
  requestId,
  requestMessage,
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

// @agent-code-guard/regression-only: Each case drives one ordering of check, claim, close and deadline that the admission ports allow.

const group = "group:alice,bob,carol";
const groupMembers = ["agent:alice", "agent:bob", "agent:carol"];
const allGatherId = collectiveOperationId(testAgentView(alice).agentId);
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
 * How a firewall double decides: which messages it refuses, whether it refuses
 * gathers, a gate on its message checks and one on its gather checks, whether
 * a gather's request messages never certify, the advice an admitting check
 * gives, and whether an admitted message fails before it binds (`bindFails`)
 * or after (`messageFails`).
 */
interface DoubleOptions {
  readonly refuseMessage?: (input: EngineSendInput) => boolean;
  readonly refuseGather?: boolean;
  readonly gate?: CheckGate;
  readonly gatherGate?: CheckGate;
  readonly requestsHang?: boolean;
  readonly guidance?: CheckedGuidance;
  readonly messageFails?: SendError;
  readonly bindFails?: SendError;
}

/** What a firewall double saw. */
interface FirewallDouble {
  readonly admission: CollectiveAdmission;
  readonly checked: EngineSendInput[];
  readonly gathers: GatherCandidate[];
  readonly admittedMessages: EngineSendInput[];
}

/**
 * A firewall double with the real admission's order: each message is checked
 * first; an admitted message then takes the layer's hold and binds, and a
 * refused one takes no hold. A gather is admitted unless `refuseGather`, and
 * its messages go through the sender the admission returns.
 */
function firewallDouble(
  observed: Observed,
  options: DoubleOptions = {},
): FirewallDouble {
  const checked: EngineSendInput[] = [];
  const gathers: GatherCandidate[] = [];
  const admittedMessages: EngineSendInput[] = [];
  const double = { checked, gathers, admittedMessages };
  return {
    ...double,
    admission: {
      bindMessage: (input, hold) =>
        checkMessage(observed, double.checked, options, { input, hold }),
      admitGather: (candidate) =>
        admitGather(observed, double, options, candidate),
    },
  };
}

function checkMessage<E>(
  observed: Observed,
  checked: EngineSendInput[],
  options: DoubleOptions,
  message: { readonly input: EngineSendInput; readonly hold: BindHold<E> },
) {
  return Effect.gen(function* () {
    checked.push(message.input);
    if (options.gate !== undefined) {
      yield* Deferred.succeed(options.gate.entered, undefined);
      yield* Deferred.await(options.gate.open);
    }
    if (options.refuseMessage?.(message.input) === true) {
      return yield* refusal;
    }
    if (options.bindFails !== undefined) {
      return yield* options.bindFails;
    }
    yield* message.hold;
    return {
      certified:
        options.messageFails === undefined
          ? certifyNext(observed, message.input)
          : Effect.fail(options.messageFails),
      guidance: options.guidance,
    };
  });
}

function admitGather(
  observed: Observed,
  double: Pick<FirewallDouble, "gathers" | "admittedMessages">,
  options: DoubleOptions,
  candidate: GatherCandidate,
) {
  double.gathers.push(candidate);
  const sender = (input: EngineSendInput) => {
    double.admittedMessages.push({ to: input.to, content: input.content });
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
  operationId: allGatherId,
  deadlineAt: 60_000,
  requestedSchema: slotSchema,
};

/** Classify Bob's gather request to alice and settle its admission. */
function receiveGatherRequest(layer: CollectiveOperations, presented: boolean) {
  return layer
    .classify({
      message: requestMessage("agent:bob", 60_000),
      recordHash: recordHashOf(1),
    })
    .pipe(Effect.tap(() => layer.settleRequest(requestId, presented)));
}

/** Classify a second gather request from Bob to alice, open for a minute, and show it. */
function receiveSecondGatherRequest(layer: CollectiveOperations) {
  const operationId = collectiveOperationId(
    testAgentView("agent:bob").agentId,
    1,
  );
  return layer
    .classify({
      message: Schema.decodeUnknownSync(InboundMessage)({
        kind: "direct",
        msgId: msgId(2),
        address: "agent:bob",
        sender: testAgentView("agent:bob"),
        content: [
          { type: "text", text: questionText },
          {
            type: "data",
            value: {
              [collectiveKey]: {
                ...allGatherRequest,
                op: "gather",
                operationId,
              },
            },
          },
        ],
      }),
      recordHash: recordHashOf(2),
    })
    .pipe(Effect.tap(() => layer.settleRequest(operationId, true)));
}

/** Classify alice's all_gather request at Bob and settle its admission. */
function receiveAllGatherRequest(
  layer: CollectiveOperations,
  presented: boolean,
) {
  return classifyGroupMessage(layer, "agent:alice", 10, allGatherRequest).pipe(
    Effect.tap(() => layer.settleRequest(allGatherId, presented)),
  );
}

/** Classify one group message from `sender` under the record hash of `byte`. */
function classifyGroupMessage(
  layer: CollectiveOperations,
  sender: string,
  byte: number,
  value: object,
) {
  return layer.classify({
    message: Schema.decodeUnknownSync(InboundMessage)({
      kind: "group",
      msgId: msgId(byte),
      address: group,
      sender: testAgentView(sender),
      members: groupMembers.map(testAgentView),
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

    const failure = yield* collectiveFailureOf(send(layer, gatherInput()));
    yield* TestClock.adjust(Duration.minutes(2));

    expect(failure).toEqual(refusal);
    expect(firewall.gathers).toHaveLength(1);
    expect(observed.sent).toEqual([]);
    expect(observed.emitted).toEqual([]);
  });
}

function sendsGatherMessagesThroughTheAdmittedSender() {
  return Effect.gen(function* () {
    const observed = newObserved();
    const firewall = firewallDouble(observed);
    const layer = yield* makeLayer(observed, {
      admission: firewall.admission,
    });

    yield* send(layer, gatherInput()).pipe(Effect.flatMap(operationIdOf));

    const [admitted] = firewall.gathers;
    expect(admitted?.to).toBe(group);
    expect(firewall.admittedMessages).toEqual([
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
    const sent = yield* send(layer, { to: "agent:bob", text: "Tuesday." });
    const allGathered = yield* send(layer, allGatherInput);

    expect(answered).toMatchObject({ guidance: advice });
    expect(gathered).toMatchObject({ guidance: advice });
    expect(sent).toMatchObject({ guidance: advice });
    expect(allGathered).toMatchObject({ guidance: advice });
  });
}

function returnsAnAdmittedAnswersFailure() {
  return Effect.gen(function* () {
    const advice = localGuidance(6);
    const observed = newObserved();
    const firewall = firewallDouble(observed, {
      guidance: advice,
      messageFails: new SendError({ reason: "network-unavailable" }),
    });
    const layer = yield* makeLayer(observed, {
      admission: firewall.admission,
    });
    yield* receiveGatherRequest(layer, true);

    const failure = yield* Effect.flip(
      send(layer, { to: "agent:bob", collectiveResponse: answer }),
    );

    expect(failure).toEqual(new SendError({ reason: "network-unavailable" }));
    expect(observed.emitted).toEqual([]);
  });
}

function returnsAnAdmittedAllGathersFailure() {
  return Effect.gen(function* () {
    const advice = localGuidance(7);
    const observed = newObserved();
    const layer = yield* makeLayer(observed, {
      admission: firewallDouble(observed, {
        guidance: advice,
        messageFails: new SendError({ reason: "network-unavailable" }),
      }).admission,
    });

    const failure = yield* collectiveFailureOf(send(layer, allGatherInput));
    yield* TestClock.adjust(Duration.minutes(2));

    expect(failure).toMatchObject({ kind: "members-unreachable" });
    expect(observed.emitted).toEqual([]);
  });
}

function refusesAGatherWhoseDeadlinePassesDuringTheCheck() {
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

    const sending = yield* send(layer, gatherInput()).pipe(Effect.fork);
    yield* Deferred.await(gatherGate.entered);
    yield* TestClock.adjust(Duration.seconds(61));
    yield* Deferred.succeed(gatherGate.open, undefined);

    expect(yield* collectiveFailureOf(Fiber.join(sending))).toEqual({
      kind: "deadline-passed",
    });
    expect(observed.sent).toEqual([]);
    expect(observed.emitted).toEqual([]);
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
    const firewall = firewallDouble(observed, { refuseMessage: () => true });
    const layer = yield* makeLayer(observed, {
      admission: firewall.admission,
    });

    const failure = yield* collectiveFailureOf(send(layer, allGatherInput));
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
      refuseMessage: () => {
        refusals.remaining -= 1;
        return refusals.remaining >= 0;
      },
    });
    const layer = yield* makeLayer(observed, {
      admission: firewall.admission,
    });
    yield* receiveGatherRequest(layer, true);
    const response = { to: "agent:bob", collectiveResponse: answer };

    const refused = yield* collectiveFailureOf(send(layer, response));
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
      message: requestMessage("agent:bob", 60_000),
      recordHash: recordHashOf(1),
    });
    const beforeAdmission = yield* collectiveFailureOf(send(layer, response));
    yield* layer.settleRequest(requestId, false);
    const afterWithholding = yield* collectiveFailureOf(send(layer, response));
    yield* layer.settleRequest(requestId, true);
    const afterLateSettle = yield* collectiveFailureOf(send(layer, response));

    expect(Option.getOrNull(item)).toMatchObject({
      kind: "collectiveRequest",
      operationId: requestId,
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

    yield* classifyGroupMessage(layer, "agent:carol", 13, {
      kind: "response",
      operationId: allGatherId,
      ...answer,
    });
    yield* classifyGroupMessage(layer, "agent:alice", 14, {
      kind: "close",
      closedAt: 60_000,
      closedBy: "deadline",
      operationId: allGatherId,
      included: [recordHashOf(13)],
    });

    expect(observed.emitted).toMatchObject([
      {
        kind: "collectiveResult",
        operationId: allGatherId,
        question: questionText,
        outcomes: [
          {
            member: testAgentView("agent:bob"),
            outcome: { kind: "no-answer" },
          },
          {
            member: testAgentView("agent:carol"),
            outcome: { kind: "answered" },
          },
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

function sendsNothingWhenTheAllGatherClosesDuringTheCheck() {
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
    yield* classifyGroupMessage(layer, "agent:alice", 14, {
      kind: "close",
      closedAt: 60_000,
      closedBy: "deadline",
      operationId: allGatherId,
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
          {
            member: testAgentView("agent:bob"),
            outcome: { kind: "no-answer" },
          },
          {
            member: testAgentView("agent:carol"),
            outcome: { kind: "no-answer" },
          },
        ],
      },
    ]);
  });
}

function sendsNothingWhenTheDeadlinePassesDuringTheCheck() {
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
          {
            value: {
              [collectiveKey]: { kind: "response", operationId: requestId },
            },
          },
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
    const operationId = yield* send(layer, gatherInput()).pipe(
      Effect.flatMap(operationIdOf),
    );

    yield* layer.classify({
      message: Schema.decodeUnknownSync(InboundMessage)({
        kind: "direct",
        msgId: msgId(21),
        address: "agent:carol",
        sender: testAgentView("agent:carol"),
        content: [
          {
            type: "data",
            value: {
              [collectiveKey]: { kind: "response", operationId, ...answer },
            },
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
          {
            member: testAgentView("agent:bob"),
            outcome: { kind: "no-answer" },
          },
          {
            member: testAgentView("agent:carol"),
            outcome: { kind: "answered" },
          },
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

    yield* classifyGroupMessage(layer, "agent:alice", 14, {
      kind: "close",
      closedAt: 60_000,
      closedBy: "deadline",
      operationId: allGatherId,
      included: [ownRecord],
    });

    expect(observed.emitted).toMatchObject([
      {
        outcomes: [
          { member: testAgentView("agent:bob"), outcome: { kind: "answered" } },
          {
            member: testAgentView("agent:carol"),
            outcome: { kind: "no-answer" },
          },
        ],
      },
    ]);
    expect(provenance).toEqual([{ answers: [], request: recordHashOf(10) }]);
  });
}

describe("collective sends under a firewall", () => {
  it(
    "returns a refused gather on the tool call, sending nothing and leaving no deadline",
    refusesAGatherOnTheToolCall,
  );
  it(
    "sends a gather's request messages only through the sender its admission returned",
    sendsGatherMessagesThroughTheAdmittedSender,
  );
  it(
    "returns once the send's wait has passed, counting the gather's check against it",
    countsTheCheckAgainstTheSendWait,
  );
  it(
    "returns a refused all_gather on the tool call, sending nothing and closing nothing at its deadline",
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
    "returns an admitted answer failure to its caller",
    returnsAnAdmittedAnswersFailure,
  );
  it(
    "returns an admitted all_gather failure to its caller",
    returnsAnAdmittedAllGathersFailure,
  );
  it(
    "refuses a gather whose deadline passes during the check",
    refusesAGatherWhoseDeadlinePassesDuringTheCheck,
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
    "sends nothing when the all_gather closes during the answer's check",
    sendsNothingWhenTheAllGatherClosesDuringTheCheck,
  );
  it(
    "sends nothing when the deadline passes during the answer's check",
    sendsNothingWhenTheDeadlinePassesDuringTheCheck,
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
