/** @file Collective sends retain exact policy decisions before ordinary protocol binding. */

import { scopedLive as it } from "@effect/vitest";
import { Deferred, Duration, Effect, Fiber, Queue } from "effect";
import { describe, expect } from "vitest";
import type { MiddlewareInput } from "../../firewall/check.js";
import {
  admitPending,
  answerBob,
  bob,
  collectiveContent,
  formSchema,
  gatherSend,
  group,
  holdMarked,
  marker,
  question,
  seedRequest,
  sendInput,
  unfinishedIntents,
} from "../../__tests__/firewall-collective-fixtures.js";
import {
  auditChecks,
  block,
  engineFixture,
  fixture,
  type Fixture,
  incomingFixture,
  outgoingFixture,
  pass,
  policy,
  rule,
} from "../../__tests__/firewall-runtime-fixtures.js";
import { MessageIntent } from "../../communication/records/index.js";
import { decodeRuntimeValue } from "../../communication/store/index.js";
import { decodeFirewallAuditEntry } from "../../firewall/store/index.js";
import { FirewallSendError } from "../../host-protocol/advice.js";
import { renderOutcome } from "../../host-protocol/render.js";

// @agent-code-guard/regression-only: Exercises collective refusal and binding through SQLite and the protocol engine.

function refusesAHeldGatherOnTheToolCall() {
  return Effect.gen(function* () {
    const subject = yield* fixture;
    const delivery = yield* outgoingFixture(subject, holdMarked());

    const refusal = yield* Effect.flip(
      delivery.operations.send({
        input: gatherSend(`${marker} ${question}`),
      }),
    );

    expect(refusal).toBeInstanceOf(FirewallSendError);
    expect(refusal).toMatchObject({ refusal: "rule-violation" });
    expect(yield* unfinishedIntents(subject)).toEqual([]);
    expect((yield* delivery.operations.readInbox({})).items).toEqual([]);
    expect(yield* auditChecks(subject)).toMatchObject([
      {
        direction: "outgoing",
        disposition: "withheld",
        input: { message: { operation: { kind: "request", op: "gather" } } },
      },
    ]);
  });
}

function bindsAShadowGatherInGuidanceMode() {
  return Effect.gen(function* () {
    const subject = yield* fixture;
    const delivery = yield* outgoingFixture(subject, holdMarked(), {
      mode: "guidance",
    });

    const sending = yield* delivery.operations
      .send({ input: gatherSend(`${marker} ${question}`) })
      .pipe(Effect.forkScoped);
    yield* Deferred.await(subject.outbound);

    expect(yield* awaitBoundIntents(subject, 2)).toHaveLength(2);
    yield* Fiber.interrupt(sending);
  });
}

/** The attributes of every finished span named `name`, in finishing order. */

function checksAnAllGatherAsItsQuestion() {
  return Effect.gen(function* () {
    const subject = yield* fixture;
    const seen: MiddlewareInput[] = [];
    const delivery = yield* outgoingFixture(subject, holdMarked(seen));

    const refusal = yield* Effect.flip(
      delivery.operations.send({
        input: gatherSend(`${marker} ${question}`, "all_gather"),
      }),
    );

    expect(refusal).toMatchObject({ refusal: "rule-violation" });
    expect(seen[0]?.event.message).toMatchObject({
      sender: subject.local.card.agentId,
      operation: { kind: "request", op: "all_gather" },
    });
    expect(seen[0]?.event.message.recipients).toEqual(
      expect.arrayContaining([
        subject.remote.card.agentId,
        subject.third.card.agentId,
      ]),
    );
    expect(seen[0]?.event.message.text).toContain(
      `all_gather from agent:alice to ${group}`,
    );
    expect(yield* unfinishedIntents(subject)).toEqual([]);
  });
}

function keepsARequestOpenAfterARefusedAnswer() {
  return Effect.gen(function* () {
    const subject = yield* fixture;
    yield* seedRequest(subject, Date.now() + 60_000, question);
    const seen: MiddlewareInput[] = [];
    const runtime = yield* incomingFixture(
      subject,
      holdMarked(seen),
      {},
      false,
    );
    yield* admitPending(runtime);
    const refused = { input: answerBob({ slot: "mon", note: marker }) };
    const allowed = { kind: "answered", content: { slot: "tue" } } as const;

    const first = yield* Effect.flip(runtime.delivery.operations.send(refused));
    const answering = yield* runtime.delivery.operations
      .send({ input: answerBob(allowed.content) })
      .pipe(Effect.forkScoped);
    yield* Deferred.await(subject.outbound);

    expect(first).toBeInstanceOf(FirewallSendError);
    expect(
      seen
        .filter((input) => input.event.direction === "outgoing")
        .map((input) => input.event.message),
    ).toMatchObject([
      { operation: { kind: "answer", op: "gather" } },
      { text: renderOutcome(allowed) },
    ]);
    expect(yield* unfinishedIntents(subject)).toHaveLength(1);
    yield* Fiber.interrupt(answering);
  });
}

/** Both drafts reach assessment before either can claim the request's one answer. */
function sendsOneOfTwoConcurrentAnswers() {
  return Effect.gen(function* () {
    const subject = yield* engineFixture(() => true);
    yield* seedRequest(subject, Date.now() + 60_000, question);
    const assessed = yield* Queue.unbounded<MiddlewareInput>();
    const release = yield* Deferred.make<undefined>();
    const runtime = yield* incomingFixture(
      subject,
      policy((input) =>
        input.event.direction === "outgoing"
          ? Queue.offer(assessed, input).pipe(
              Effect.zipRight(Deferred.await(release)),
              Effect.as(pass),
            )
          : Effect.succeed(pass),
      ),
      {},
      false,
    );
    yield* admitPending(runtime);
    const firstAnswer = { slot: "mon" };
    const secondAnswer = { slot: "tue" };
    const first = yield* runtime.delivery.operations
      .send({ input: answerBob(firstAnswer) })
      .pipe(Effect.flip, Effect.forkScoped);
    const second = yield* runtime.delivery.operations
      .send({ input: answerBob(secondAnswer) })
      .pipe(Effect.flip, Effect.forkScoped);
    const firstChecked = yield* Queue.take(assessed);
    const secondChecked = yield* Queue.take(assessed);
    const operationId = yield* Effect.fromNullable(
      firstChecked.event.message.operation?.operationId,
    );
    expect(secondChecked.event.message.operation?.operationId).toBe(
      operationId,
    );
    expect([
      firstChecked.event.message.text,
      secondChecked.event.message.text,
    ]).toEqual(
      expect.arrayContaining([
        renderOutcome({ kind: "answered", content: firstAnswer }),
        renderOutcome({ kind: "answered", content: secondAnswer }),
      ]),
    );
    yield* Deferred.succeed(release, undefined);
    const firstFailure = yield* Fiber.join(first);
    const secondFailure = yield* Fiber.join(second);
    expect([firstFailure, secondFailure]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: "delivery-pending" }),
        expect.objectContaining({ failure: { kind: "request-answered" } }),
      ]),
    );
    const winner =
      firstFailure._tag === "SendError" &&
      firstFailure.reason === "delivery-pending"
        ? firstAnswer
        : secondAnswer;
    const responses = yield* subject.store.readCollectiveMessages({
      operationId,
      role: "response",
    });
    expect(responses).toHaveLength(1);
    const retained = yield* Effect.fromNullable(responses[0]);
    const original = yield* decodeRuntimeValue(
      MessageIntent,
      retained.intent.canonicalIntent,
    );
    expect(original.content).toEqual(
      yield* collectiveContent({
        kind: "response",
        operationId: retained.operationId,
        action: "accept",
        content: winner,
      }),
    );
    expect(yield* unfinishedIntents(subject)).toMatchObject([
      {
        msgId: original.msgId,
        canonicalIntent: retained.intent.canonicalIntent,
      },
    ]);
  });
}

function refusesAnAnswerWhoseRequestExpiresDuringItsCheck() {
  return Effect.gen(function* () {
    const subject = yield* fixture;
    const deadlineAt = Date.now() + 3_000;
    yield* seedRequest(subject, deadlineAt, question);
    const runtime = yield* incomingFixture(
      subject,
      policy((input) =>
        input.event.direction === "outgoing"
          ? Effect.sleep(untilPast(deadlineAt)).pipe(Effect.as(pass))
          : Effect.succeed(pass),
      ),
      {},
      false,
    );
    yield* admitPending(runtime);

    const refusal = yield* Effect.flip(
      runtime.delivery.operations.send({ input: answerBob({ slot: "mon" }) }),
    );

    expect(refusal).toMatchObject({ failure: { kind: "request-expired" } });
    expect(yield* unfinishedIntents(subject)).toEqual([]);
    expect((yield* auditChecks(subject)).at(-1)).toMatchObject({
      direction: "outgoing",
      disposition: "admitted",
      result: { judgment: "allow" },
    });
  });
}

/** Send a collecting operation that closes one second after it is sent. */
function sendClosingInASecond(
  delivery: Effect.Effect.Success<ReturnType<typeof outgoingFixture>>,
  op: "gather" | "all_gather",
) {
  return delivery.operations.send({
    input: sendInput({
      to: group,
      text: question,
      collective: { op, deadline: 1, requestedSchema: formSchema },
    }),
  });
}

function failsWhenTheDeadlinePassesDuringTheCheck(op: "gather" | "all_gather") {
  return Effect.gen(function* () {
    const subject = yield* fixture;
    const delivery = yield* outgoingFixture(
      subject,
      policy(() => Effect.sleep(Duration.millis(1_100)).pipe(Effect.as(pass))),
    );

    const failure = yield* Effect.flip(sendClosingInASecond(delivery, op));

    expect(failure).toMatchObject({ failure: { kind: "deadline-passed" } });
    expect(yield* unfinishedIntents(subject)).toEqual([]);
    expect((yield* delivery.operations.readInbox({})).items).toEqual([]);
  });
}

function refusesAHeldAllGatherWithoutOpeningIt() {
  return Effect.gen(function* () {
    const subject = yield* fixture;
    const delivery = yield* outgoingFixture(
      subject,
      policy(() => Effect.sleep(Duration.millis(1_100)).pipe(Effect.as(block))),
    );

    const refusal = yield* Effect.flip(
      sendClosingInASecond(delivery, "all_gather"),
    );

    expect(refusal).toBeInstanceOf(FirewallSendError);
    expect(yield* unfinishedIntents(subject)).toEqual([]);
  });
}

/** The time from now until just after `at`. */
function untilPast(at: number): Duration.Duration {
  return Duration.millis(Math.max(0, at - Date.now()) + 50);
}

/** Wait, up to ten seconds, until the test's sends have bound `count` intents. */
function awaitBoundIntents(subject: Fixture, count: number) {
  return unfinishedIntents(subject).pipe(
    Effect.delay(Duration.millis(10)),
    Effect.repeat({ until: (intents) => intents.length >= count }),
    Effect.timeoutFail({
      duration: Duration.seconds(10),
      onTimeout: () => new Error(`fewer than ${count} intents bound`),
    }),
  );
}

function bindsNothingWhenStoppedDuringAGatherCheck() {
  return Effect.gen(function* () {
    const subject = yield* fixture;
    const entered = yield* Deferred.make<undefined>();
    const suspended = policy(() =>
      Deferred.succeed(entered, undefined).pipe(Effect.zipRight(Effect.never)),
    );
    const delivery = yield* outgoingFixture(subject, suspended);
    const sending = yield* delivery.operations
      .send({ input: gatherSend(question) })
      .pipe(Effect.forkScoped);
    yield* Deferred.await(entered);
    yield* Fiber.interrupt(sending);

    expect(yield* unfinishedIntents(subject)).toEqual([]);
    const attempts = yield* subject.store.readFirewallDecisions();
    const checks = yield* Effect.forEach(
      attempts,
      (entry) => decodeFirewallAuditEntry(entry),
      { concurrency: 1 },
    );
    expect(checks).toEqual([]);
  });
}

/** A policy that leaves its norm judgment of every message unsettled. */
const unsettled = policy(() =>
  Effect.succeed({
    findings: [
      {
        ruleId: rule.id,
        outcome: "pass",
        reason: "uncertain",
        choice: "none",
        probability: 0.33,
      },
    ],
    expectations: [],
  }),
);

function returnsAnAnswersPendingDelivery() {
  return Effect.gen(function* () {
    const subject = yield* engineFixture(() => true);
    yield* seedRequest(subject, Date.now() + 60_000, question);
    const runtime = yield* incomingFixture(subject, unsettled, {}, false);
    yield* admitPending(runtime);
    const answer = {
      input: answerBob({ slot: "mon" }),
    } as const;

    const failure = yield* Effect.flip(
      runtime.delivery.operations.send(answer),
    );

    expect(failure).toMatchObject({
      _tag: "SendError",
      reason: "delivery-pending",
    });
    expect(runtime.emitted).toEqual([]);
  });
}

function returnsAnAllGathersPendingDelivery() {
  return Effect.gen(function* () {
    const subject = yield* engineFixture(() => true);
    const runtime = yield* incomingFixture(subject, unsettled);

    const failure = yield* Effect.flip(
      runtime.delivery.operations.send({
        input: gatherSend(question, "all_gather"),
      }),
    );

    expect(failure).toMatchObject({
      _tag: "SendError",
      reason: "delivery-pending",
    });
    expect(runtime.emitted).toEqual([]);
  });
}

/**
 * A bound request remains pending when another send prevents activation.
 */
function keepsAllGatherPendingBehindStalledSend() {
  return Effect.gen(function* () {
    const writes = { made: 0 };
    const subject = yield* engineFixture(() => writes.made++ > 0);
    const runtime = yield* incomingFixture(
      subject,
      policy(() => Effect.succeed(pass)),
      {
        mode: "guidance",
      },
    );
    const stalled = yield* runtime.delivery.operations
      .send({ input: sendInput({ to: bob, text: "Tuesday." }) })
      .pipe(Effect.forkScoped);
    yield* Deferred.await(subject.outbound);

    const pending = yield* Effect.flip(
      runtime.delivery.operations.send({
        input: sendInput({
          to: group,
          text: question,
          collective: {
            op: "all_gather",
            deadline: 1,
            requestedSchema: formSchema,
          },
        }),
      }),
    );

    expect(pending).toMatchObject({
      _tag: "SendError",
      reason: "delivery-pending",
    });
    expect(runtime.emitted).toEqual([]);
    yield* Fiber.interrupt(stalled);
  });
}

describe("collective sends under a firewall", () => {
  it(
    "refuses a held gather on the tool call before binding a request",
    refusesAHeldGatherOnTheToolCall,
  );
  it(
    "binds every request message of a gather a guidance-mode check would hold",
    bindsAShadowGatherInGuidanceMode,
  );
  it(
    "checks an all_gather's group message as its question and binds nothing when held",
    checksAnAllGatherAsItsQuestion,
  );
  it(
    "keeps a request open after its answer is refused",
    keepsARequestOpenAfterARefusedAnswer,
  );
  it(
    "retains one original answer when two assessed drafts race for the same request",
    sendsOneOfTwoConcurrentAnswers,
  );
  it(
    "refuses an answer whose request expires during its check, keeping the check's judgment",
    refusesAnAnswerWhoseRequestExpiresDuringItsCheck,
  );
  it("fails a gather whose deadline passes during its check, sending nothing", () =>
    failsWhenTheDeadlinePassesDuringTheCheck("gather"));
  it("fails an all_gather whose deadline passes during its check, sending nothing", () =>
    failsWhenTheDeadlinePassesDuringTheCheck("all_gather"));
  it(
    "refuses a held all_gather on its check alone, never opening it",
    refusesAHeldAllGatherWithoutOpeningIt,
  );
  it(
    "binds nothing when the daemon stops during a gather's check",
    bindsNothingWhenStoppedDuringAGatherCheck,
  );
});

describe("collective sends whose bound message fails activation", () => {
  it(
    "returns pending delivery when an admitted answer cannot activate",
    returnsAnAnswersPendingDelivery,
  );
  it(
    "returns pending delivery when an admitted all_gather cannot activate",
    returnsAnAllGathersPendingDelivery,
  );
  it(
    "keeps a bound all_gather pending when another send stalls",
    keepsAllGatherPendingBehindStalledSend,
  );
});
