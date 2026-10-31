/** @file Outgoing messages are checked before communication accepts them. */

import { scopedLive as it } from "@effect/vitest";
import { Deferred, Duration, Effect, Fiber } from "effect";
import { describe, expect } from "vitest";
import type { MiddlewareInput } from "../../firewall/check.js";
import {
  admitPending,
  answerBob,
  formSchema,
  gatherSend,
  group,
  holdMarked,
  marker,
  question,
  seedRequest,
  sendInput,
  unfinishedIntents,
} from "../../__tests__/collective-delivery-fixtures.js";
import { collectiveOperationId } from "../../__tests__/collective-id-fixtures.js";
import {
  fixture,
  type Fixture,
  seedIncoming,
} from "../../__tests__/conversation-fixtures.js";
import {
  auditChecks,
  block,
  destination,
  incomingFixture,
  outgoingFixture,
  pass,
  policy,
} from "../../__tests__/daemon-delivery-fixtures.js";
import { decodeFirewallAuditEntry } from "../../firewall/store/index.js";
import { FirewallSendError } from "../../host-protocol/advice.js";
import { renderOutcome } from "../../host-protocol/render.js";

// @agent-code-guard/regression-only: Real SQL and the conversation engine exercise cancellation, deadlines and accepted sends.

it(
  "does not accept a cancelled draft and releases its check permit",
  interruptedSend,
);

function interruptedSend() {
  return Effect.gen(function* () {
    const subject = yield* fixture;
    const entered = yield* Deferred.make<undefined>();
    let calls = 0;
    const delivery = yield* outgoingFixture(
      subject,
      policy(() =>
        Effect.suspend(() => {
          calls += 1;
          return calls === 1
            ? Deferred.succeed(entered, undefined).pipe(
                Effect.zipRight(Effect.never),
              )
            : Effect.succeed(block);
        }),
      ),
      { maximumConcurrentChecks: 1 },
    );
    const sending = yield* delivery.operations
      .send({ input: { to: destination, text: "Cancelled draft" } })
      .pipe(Effect.forkScoped);
    yield* Deferred.await(entered);
    yield* Fiber.interrupt(sending);
    expect(
      (yield* subject.run(subject.store.recover())).messageIntents,
    ).toEqual([]);
    expect(
      yield* Effect.flip(
        delivery.operations.send({
          input: { to: destination, text: "Another draft" },
        }),
      ),
    ).toMatchObject({ refusal: "rule-violation" });
  });
}

it("keeps one captured assessment and exact draft while retained visibility changes", () =>
  Effect.gen(function* () {
    const subject = yield* fixture;
    yield* seedIncoming(subject, true);
    const entered = yield* Deferred.make<undefined>();
    const release = yield* Deferred.make<undefined>();
    const seen: MiddlewareInput[] = [];
    const delivery = yield* outgoingFixture(
      subject,
      policy(captureAndWait(seen, entered, release)),
    );
    const originalText = "Captured original draft";
    const changedText = "Caller changed the draft";
    const draft = { to: destination, text: originalText };
    const sending = yield* delivery.operations
      .send({ input: draft })
      .pipe(Effect.forkScoped);
    yield* Deferred.await(entered);
    draft.text = changedText;
    yield* delivery.queueLocalItem({
      kind: "operationFailed",
      operationId: collectiveOperationId(subject.local.card.agentId),
      to: destination,
      error: "A later local result",
    });
    yield* Deferred.succeed(release, undefined);
    yield* Deferred.await(subject.outbound);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.event.message?.text).toBe(originalText);
    const pending = (yield* subject.run(
      subject.store.recover(),
    )).messageIntents.filter(
      (intent) => intent.completedRecordHash === undefined,
    );
    expect(pending).toHaveLength(1);
    const retained = yield* Effect.fromNullable(pending[0]);
    expect(new TextDecoder().decode(retained.canonicalIntent)).toContain(
      originalText,
    );
    expect(new TextDecoder().decode(retained.canonicalIntent)).not.toContain(
      changedText,
    );
    yield* Fiber.interrupt(sending);
  }));

function captureAndWait(
  seen: MiddlewareInput[],
  entered: Deferred.Deferred<undefined>,
  release: Deferred.Deferred<undefined>,
) {
  return (input: MiddlewareInput) =>
    Effect.gen(function* () {
      seen.push(input);
      yield* Deferred.succeed(entered, undefined);
      yield* Deferred.await(release);
      return pass;
    });
}

function refusesGatherBeforeAcceptance() {
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

function acceptsGatherInGuidanceMode() {
  return Effect.gen(function* () {
    const subject = yield* fixture;
    const delivery = yield* outgoingFixture(subject, holdMarked(), {
      mode: "guidance",
    });

    const sending = yield* delivery.operations
      .send({ input: gatherSend(`${marker} ${question}`) })
      .pipe(Effect.forkScoped);
    yield* Deferred.await(subject.outbound);

    expect(yield* awaitAcceptedMessages(subject, 2)).toHaveLength(2);
    yield* Fiber.interrupt(sending);
  });
}

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

function refusesAllGatherBeforeAcceptance() {
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
function awaitAcceptedMessages(subject: Fixture, count: number) {
  return unfinishedIntents(subject).pipe(
    Effect.delay(Duration.millis(10)),
    Effect.repeat({ until: (intents) => intents.length >= count }),
    Effect.timeoutFail({
      duration: Duration.seconds(10),
      onTimeout: () => new Error(`fewer than ${count} intents bound`),
    }),
  );
}

function doesNotAcceptCancelledGather() {
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
    const attempts = yield* subject.run(subject.store.readFirewallDecisions());
    const checks = yield* Effect.forEach(
      attempts,
      (entry) => decodeFirewallAuditEntry(entry),
      { concurrency: 1 },
    );
    expect(checks).toEqual([]);
  });
}

describe("checking collective sends", () => {
  it(
    "refuses a gather before accepting any request message",
    refusesGatherBeforeAcceptance,
  );
  it(
    "accepts gather requests in guidance mode despite policy findings",
    acceptsGatherInGuidanceMode,
  );
  it(
    "checks the all-gather question before accepting its message",
    checksAnAllGatherAsItsQuestion,
  );
  it(
    "keeps a request open after its answer is refused",
    keepsARequestOpenAfterARefusedAnswer,
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
    "refuses an all-gather before creating its request",
    refusesAllGatherBeforeAcceptance,
  );
  it(
    "accepts no request when its check is cancelled",
    doesNotAcceptCancelledGather,
  );
});
