/** @file The daemon checks and saves incoming messages before notifying the host. */

import { scopedLive as it } from "@effect/vitest";
import { Deferred, Duration, Effect, Fiber, Queue, Schema } from "effect";
import { describe, expect } from "vitest";
import type {
  MessageMiddleware,
  MiddlewareInput,
} from "../../firewall/check.js";
import type { FirewallOptions } from "../../firewall/index.js";
import type { LocalGuidance } from "../../host-protocol/advice.js";
import { testAgentView } from "../../__tests__/agent-card-fixtures.js";
import { appendCertifiedMessage } from "../../__tests__/certified-history-fixtures.js";
import {
  admitPending,
  answerBob,
  bob,
  formSchema,
  gatherRequestContent,
  holdMarked,
  type IncomingRuntime,
  marker,
  question,
  seedRequest,
  unfinishedIntents,
} from "../../__tests__/collective-delivery-fixtures.js";
import { collectiveOperationId } from "../../__tests__/collective-id-fixtures.js";
import { collectiveKey } from "../../__tests__/collective-operation-fixtures.js";
import {
  addConversation,
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
  rule,
} from "../../__tests__/daemon-delivery-fixtures.js";
import { InboundItem } from "../../host-protocol/items.js";
import { renderCollectiveRequestBody } from "../../host-protocol/render.js";

// @agent-code-guard/regression-only: Real SQLite and the protocol engine verify admission and host-visible publication.

it(
  "withholds a certified incoming message from every runtime read and notification",
  withheldIncoming,
);

function withheldIncoming() {
  return Effect.gen(function* () {
    const subject = yield* fixture;
    const runtime = yield* incomingFixture(
      subject,
      policy(() => Effect.succeed(block)),
    );
    yield* runtime.runPass;
    yield* Queue.take(runtime.completed);
    expect(runtime.published).toEqual([]);
    expect((yield* runtime.delivery.operations.readInbox({})).items).toEqual(
      [],
    );
    expect((yield* runtime.delivery.eventStore.readInbox()).items).toEqual([]);
    expect(
      (yield* runtime.delivery.operations.readInboxSummary()).pendingCount,
    ).toBe(0);
    expect(
      yield* Effect.flip(
        runtime.delivery.operations.readEvent({
          eventId: runtime.candidate.deliveryToken,
        }),
      ),
    ).toEqual({ reason: "unknown-event" });
    expect(yield* subject.run(subject.store.readPendingDeliveries())).toEqual(
      [],
    );
    const seen: MiddlewareInput[] = [];
    const outgoing = yield* outgoingFixture(
      subject,
      policy((input) =>
        Effect.sync(() => {
          seen.push(input);
          return block;
        }),
      ),
    );
    yield* Effect.flip(
      outgoing.operations.send({ input: { to: destination, text: "A reply" } }),
    );
    expect(seen[0]?.context.history).toMatchObject([
      {
        sender: subject.remote.card.agentId,
        visibility: "assessor",
        admission: "withheld",
      },
    ]);
  });
}

it(
  "admits original content with local guidance and verified attribution",
  guidanceIncoming,
);

function guidanceIncoming() {
  return Effect.gen(function* () {
    const subject = yield* fixture;
    const seen: MiddlewareInput[] = [];
    const runtime = yield* incomingFixture(
      subject,
      policy((input) =>
        Effect.sync(() => {
          seen.push(input);
          return {
            findings: pass.findings,
            expectations: [
              {
                ruleId: rule.id,
                expectation: "required",
                subjects: [input.event.message.id],
              },
            ],
          };
        }),
      ),
    );
    yield* runtime.runPass;
    yield* Queue.take(runtime.completed);
    const page = yield* runtime.delivery.operations.readInbox({});
    expect(page.items).toEqual(runtime.published);
    expect(page.items[0]?.item).toEqual({
      kind: "multicast",
      message: runtime.candidate.message,
    });
    expectNamedSubjects(
      `agent:${subject.remote.card.agentName}`,
      `agent:${subject.local.card.agentName}`,
      yield* Effect.fromNullable(page.items[0]?.guidance),
    );
    expect(seen[0]?.context.history).toEqual([]);
    expect(seen[0]?.event.message.sender).toBe(subject.remote.card.agentId);
    expect(seen[0]?.context.participants).toContainEqual({
      agentId: subject.remote.card.agentId,
      principal: subject.remote.card.principalId,
    });
    expect(
      (yield* runtime.delivery.operations.readEvent({
        eventId: runtime.candidate.deliveryToken,
      })).guidance,
    ).toEqual(page.items[0]?.guidance);
  });
}

/** Retained advice names the verified peer and local recipient. */
function expectNamedSubjects(
  sender: string,
  recipient: string,
  guidance: LocalGuidance,
) {
  expect(guidance).toMatchObject({
    instructions: [{ instruction: rule.guidance }],
    subjects: [
      { sender: testAgentView(sender), recipients: [testAgentView(recipient)] },
    ],
  });
}

it(
  "publishes the original message with advice when a guidance-mode check blocks it",
  shadowIncoming,
);

function shadowIncoming() {
  return Effect.gen(function* () {
    const runtime = yield* incomingFixture(
      yield* fixture,
      policy(() => Effect.succeed(block)),
      { mode: "guidance" },
    );
    yield* runtime.runPass;
    yield* Queue.take(runtime.completed);
    expect(runtime.published.map((event) => event.item)).toEqual([
      { kind: "multicast", message: runtime.candidate.message },
    ]);
    expect(runtime.published[0]?.guidance).toMatchObject({
      instructions: [{ instruction: rule.guidance }],
    });
  });
}

it(
  "keeps later work in another conversation moving while one assessment waits",
  independentConversations,
);

function independentConversations() {
  return Effect.gen(function* () {
    const subject = yield* fixture;
    yield* addConversation(subject);
    const blocked = yield* Deferred.make<undefined>();
    const middleware = policy((input) =>
      input.event.message.sender === subject.remote.card.agentId
        ? Deferred.succeed(blocked, undefined).pipe(
            Effect.zipRight(Effect.never),
          )
        : Effect.succeed(pass),
    );
    const runtime = yield* incomingFixture(subject, middleware, {
      mode: "guidance",
      maximumConcurrentChecks: 2,
    });
    yield* runtime.runPass;
    yield* Deferred.await(blocked);
    yield* Queue.take(runtime.completed);
    const later = Schema.decodeUnknownSync(InboundItem)({
      kind: "operationFailed",
      operationId: collectiveOperationId(
        testAgentView("agent:alice").agentId,
        84,
      ),
      to: "agent:carol",
      error: "Another operation completed.",
    });
    yield* runtime.delivery.queueLocalItem(later);
    yield* runtime.runPass;
    yield* Queue.take(runtime.completed);
    expect(
      (yield* runtime.delivery.operations.readInbox({})).items.map(
        (entry) => entry.item,
      ),
    ).toContainEqual(later);
    expect(
      (yield* subject.run(subject.store.readNextPendingMessages())).map(
        (entry) => entry.conversation,
      ),
    ).toEqual(["agent:bob"]);
  });
}

it("holds oversized incoming advice without publishing a partial projection", () =>
  oversizedAdvice("enforcement"));

it("admits the original without oversized advice in guidance mode", () =>
  oversizedAdvice("guidance"));

it(
  "does not expose locally authored history without runtime admission",
  locallyAuthoredHistoryStaysPrivate,
);

function oversizedAdvice(mode: FirewallOptions["mode"]) {
  return Effect.gen(function* () {
    const middleware: MessageMiddleware = {
      id: "large-norm",
      revision: "1",
      rules: [{ ...rule, guidance: "x".repeat(2 * 1024 * 1024) }],
      check: (input) =>
        Effect.succeed({
          findings: pass.findings,
          expectations: [
            {
              ruleId: rule.id,
              expectation: "required",
              subjects: [input.event.message.id],
            },
          ],
        }),
    };
    const subject = yield* fixture;
    const runtime = yield* incomingFixture(subject, middleware, {
      mode,
    });
    yield* runtime.runPass;
    yield* Queue.take(runtime.completed);
    expect(runtime.published).toHaveLength(mode === "guidance" ? 1 : 0);
    expect(
      runtime.published.every((entry) => entry.guidance === undefined),
    ).toBe(true);
    expect(yield* subject.run(subject.store.readNextPendingMessages())).toEqual(
      [],
    );
  });
}

function locallyAuthoredHistoryStaysPrivate() {
  return Effect.gen(function* () {
    const subject = yield* fixture;
    const previous = yield* seedIncoming(subject, true);
    yield* subject.run(
      appendCertifiedMessage(subject, previous, "Can we meet?"),
    );
    const seen: MiddlewareInput[] = [];
    const middleware = policy((input) =>
      Effect.sync(() => {
        seen.push(input);
        return {
          findings: pass.findings,
          expectations: [
            {
              ruleId: rule.id,
              expectation: "required",
              subjects: [input.event.message.id],
            },
          ],
        };
      }),
    );
    const runtime = yield* incomingFixture(subject, middleware, {}, false);
    yield* runtime.runPass;
    yield* Queue.take(runtime.completed);
    expect(seen).toMatchObject([
      {
        context: {
          history: [
            {
              sender: subject.local.card.agentId,
              visibility: "assessor",
              admission: "admitted",
            },
          ],
        },
      },
    ]);
    const guidance = (yield* runtime.delivery.operations.readInbox({})).items[0]
      ?.guidance;
    expect(guidance).toMatchObject({
      subjects: [
        { sender: testAgentView(`agent:${subject.remote.card.agentName}`) },
      ],
    });
  });
}

function withholdsAHeldRequest() {
  return Effect.gen(function* () {
    const subject = yield* fixture;
    yield* seedRequest(subject, Date.now() + 60_000, `${marker} ${question}`);
    const runtime = yield* incomingFixture(subject, holdMarked(), {}, false);
    yield* admitPending(runtime);

    const refusal = yield* Effect.flip(
      runtime.delivery.operations.send({ input: answerBob({ slot: "mon" }) }),
    );

    expect(runtime.published).toEqual([]);
    expect((yield* runtime.delivery.operations.readInbox({})).items).toEqual(
      [],
    );
    expect(refusal).toMatchObject({ failure: { kind: "request-none" } });
    expect(yield* unfinishedIntents(subject)).toEqual([]);
  });
}

function showsAHeldRequestInGuidanceMode() {
  return Effect.gen(function* () {
    const subject = yield* fixture;
    yield* seedRequest(subject, Date.now() + 60_000, `${marker} ${question}`);
    const runtime = yield* incomingFixture(
      subject,
      holdMarked(),
      { mode: "guidance" },
      false,
    );
    yield* admitPending(runtime);

    const answering = yield* runtime.delivery.operations
      .send({ input: answerBob({ slot: "mon" }) })
      .pipe(Effect.forkScoped);
    yield* Deferred.await(subject.outbound);

    expect(runtime.published.map((event) => event.item)).toMatchObject([
      { kind: "collectiveRequest", message: { author: testAgentView(bob) } },
    ]);
    expect(yield* unfinishedIntents(subject)).toHaveLength(1);
    yield* Fiber.interrupt(answering);
  });
}

/** The one request the subscription delivered. */
function deliveredRequest(runtime: IncomingRuntime) {
  const [delivered] = runtime.published;
  return delivered?.item.kind === "collectiveRequest"
    ? Effect.succeed(delivered.item)
    : Effect.dieMessage("expected the delivered request");
}

function checksARequestAsItsQuestion() {
  return Effect.gen(function* () {
    const subject = yield* fixture;
    const deadlineAt = Date.now() + 60_000;
    const firstMessage = yield* seedIncoming(subject, true);
    yield* subject.run(
      appendCertifiedMessage(subject, firstMessage, [
        ...(yield* gatherRequestContent(deadlineAt, question)),
        { type: "data", value: { agenda: ["mon", "tue"] } },
      ]),
    );
    const seen: MiddlewareInput[] = [];
    const runtime = yield* incomingFixture(
      subject,
      holdMarked(seen),
      {},
      false,
    );
    yield* admitPending(runtime);

    const message = yield* Effect.fromNullable(seen[0]?.event.message);
    const delivered = yield* deliveredRequest(runtime);
    expect(message.text).toBe(renderCollectiveRequestBody(delivered));
    expect(message.operation).toEqual({
      kind: "request",
      op: "gather",
      operationId: collectiveOperationId(testAgentView(bob).agentId),
      deadlineAt,
    });
    expect(seen[0]?.context.now).toEqual(expect.any(Number));
    expect((yield* auditChecks(subject))[0]?.input.message).toMatchObject({
      sender: subject.remote.card.agentId,
    });
  });
}

function withholdsARequestThatExpiresDuringItsCheck() {
  return Effect.gen(function* () {
    const subject = yield* fixture;
    const deadlineAt = Date.now() + 3_000;
    yield* seedRequest(subject, deadlineAt, question);
    const slow = policy(() =>
      Effect.sleep(
        Duration.millis(Math.max(0, deadlineAt - Date.now()) + 50),
      ).pipe(Effect.as(pass)),
    );
    const runtime = yield* incomingFixture(subject, slow, {}, false);
    yield* admitPending(runtime);

    expect(runtime.published).toEqual([]);
    expect(yield* auditChecks(subject)).toMatchObject([
      { disposition: "withheld", result: { judgment: "allow" } },
    ]);
  });
}

/**
 * A request whose deadline lies past the last instant a date can represent,
 * as a hostile peer could message it, then a plain message after it.
 */
function seedUnrenderableRequest(subject: Fixture) {
  return Effect.gen(function* () {
    const firstMessage = yield* seedIncoming(subject, true);
    const hostile = yield* subject.run(
      appendCertifiedMessage(subject, firstMessage, [
        { type: "text", text: question },
        {
          type: "data",
          value: {
            [collectiveKey]: {
              kind: "operation",
              op: "gather",
              operationId: collectiveOperationId(testAgentView(bob).agentId),
              deadlineAt: 9_000_000_000_000_000,
              requestedSchema: formSchema,
            },
          },
        },
      ]),
    );
    return yield* subject.run(
      appendCertifiedMessage(subject, hostile, "A later message"),
    );
  }).pipe(Effect.withSpan("seedUnrenderableRequest"));
}

function checksPastAnUnrenderableDeadline() {
  return Effect.gen(function* () {
    const subject = yield* fixture;
    yield* seedUnrenderableRequest(subject);
    const seen: MiddlewareInput[] = [];
    const runtime = yield* incomingFixture(
      subject,
      holdMarked(seen),
      {},
      false,
    );
    yield* admitPending(runtime);

    expect(runtime.published.map((event) => event.item)).toMatchObject([
      {
        kind: "multicast",
        message: { content: [{ text: "A later message" }] },
      },
    ]);
    expect(seen.at(-1)?.context.history.at(-1)).toMatchObject({
      visibility: "assessor",
    });
    expect(seen.at(-1)?.context.history.at(-1)?.operation).toBeUndefined();
  });
}

function retiresARequestThatExpiresBeforeItsCheck() {
  return Effect.gen(function* () {
    const subject = yield* fixture;
    const deadlineAt = Date.now() + 3_000;
    const firstMessage = yield* seedIncoming(subject, true);
    const earlier = yield* subject.run(
      appendCertifiedMessage(subject, firstMessage, "Earlier"),
    );
    yield* subject.run(
      appendCertifiedMessage(
        subject,
        earlier,
        yield* gatherRequestContent(deadlineAt, question),
      ),
    );
    const runtime = yield* incomingFixture(
      subject,
      policy((input) =>
        input.event.message.operation === undefined
          ? Effect.sleep(
              Duration.millis(Math.max(0, deadlineAt - Date.now()) + 50),
            ).pipe(Effect.as(pass))
          : Effect.dieMessage("a request past its deadline is never checked"),
      ),
      {},
      false,
    );
    yield* admitPending(runtime);
    yield* Queue.take(runtime.completed);

    const refusal = yield* Effect.flip(
      runtime.delivery.operations.send({ input: answerBob({ slot: "mon" }) }),
    );

    expect(runtime.published.map((event) => event.item.kind)).toEqual([
      "multicast",
    ]);
    expect(yield* auditChecks(subject)).toHaveLength(1);
    expect(refusal).toMatchObject({ failure: { kind: "request-none" } });
  });
}

describe("received request admission", () => {
  it(
    "withholds a request an enforcing check holds, so it cannot be answered",
    withholdsAHeldRequest,
  );
  it(
    "shows a held request in guidance mode, answerable",
    showsAHeldRequestInGuidanceMode,
  );
  it(
    "checks a request as exactly the question a model reads, before its answer instructions and without its data parts",
    checksARequestAsItsQuestion,
  );
  it(
    "does not present a request whose deadline passes while it is checked",
    withholdsARequestThatExpiresDuringItsCheck,
  );
  it(
    "retires a request whose deadline passes before its check starts, without checking it",
    retiresARequestThatExpiresBeforeItsCheck,
  );
  it(
    "checks later messages past a request whose deadline no date can represent",
    checksPastAnUnrenderableDeadline,
  );
});
