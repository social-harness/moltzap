/** @file Message admission through real Client storage and send preparation. */

import { scopedLive as it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Queue, Schema } from "effect";
import { expect } from "vitest";
import type { FirewallOptions } from "./firewall.js";
import { digest } from "../../__tests__/agent-card-fixtures.js";
import { appendCertifiedPost } from "../../__tests__/certified-history-fixtures.js";
import {
  group,
  sendInput,
} from "../../__tests__/firewall-collective-fixtures.js";
import {
  addConversation,
  auditChecks,
  block,
  churnPolicy,
  destination,
  fixture,
  incomingFixture,
  installation,
  outgoingFixture,
  pass,
  policy,
  renderedWaitAction,
  revise,
  rule,
  seedIncoming,
  waitAction,
} from "../../__tests__/firewall-runtime-fixtures.js";
import { InboundItem } from "../../communication/collectives/inbound.js";
import { eventIdOf } from "../../harness/protocol/operations.js";
import {
  type DecisionProvider,
  type DecisionRequest,
  type MessageMiddleware,
  MiddlewareError,
  type MiddlewareInput,
  type TextRule,
} from "../evaluator/contract/index.js";
import { makeTextPolicy } from "../evaluator/index.js";
import { type LocalGuidance, renderLocalGuidance } from "../outcome/index.js";

// @agent-code-guard/regression-only: Exercises durable admission, replay, interruption and races through SQLite and the protocol engine.

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
          eventId: eventIdOf(runtime.candidate.deliveryToken),
        }),
      ),
    ).toEqual({ reason: "unknown-event" });
    expect(yield* subject.store.readPendingDeliveries()).toEqual([]);
    const seen: MiddlewareInput[] = [];
    const outgoing = yield* outgoingFixture(
      subject,
      policy((input) =>
        Effect.sync(() => {
          seen.push(input);
          return revise;
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
      page.items[0]?.guidance,
    );
    expect(seen[0]?.context.history).toEqual([]);
    expect(seen[0]?.event.message.sender).toBe(subject.remote.card.agentId);
    expect(seen[0]?.context.participants).toContainEqual({
      agentId: subject.remote.card.agentId,
      principal: subject.remote.card.principalId,
    });
    expect(
      (yield* runtime.delivery.operations.readEvent({
        eventId: eventIdOf(runtime.candidate.deliveryToken),
      })).guidance,
    ).toEqual(page.items[0]?.guidance);
  });
}

/** Render production guidance with certified peer and local-agent addresses. */
function expectNamedSubjects(
  sender: string,
  recipient: string,
  guidance?: LocalGuidance,
) {
  if (guidance === undefined) {
    throw new Error("Expected produced guidance");
  }
  expect(guidance).toMatchObject({
    instructions: [{ instruction: rule.guidance }],
    subjects: [{ sender, recipients: [recipient] }],
  });
  const rendered = renderLocalGuidance(guidance);
  expect(rendered).toContain(`"sender":"${sender}"`);
  expect(rendered).toContain(`"recipients":["${recipient}"]`);
}

it(
  "admits an incoming message whose norm judgment is unsettled, advising that judgment",
  unsettledIncoming,
);

function unsettledIncoming() {
  return Effect.gen(function* () {
    const subject = yield* fixture;
    const runtime = yield* incomingFixture(
      subject,
      policy(() =>
        Effect.succeed({
          findings: [
            {
              ruleId: rule.id,
              outcome: "pass",
              reason: "uncertain",
              choice: "required",
              probability: 0.4,
            },
          ],
          expectations: [],
        }),
      ),
    );
    yield* runtime.runPass;
    yield* Queue.take(runtime.completed);
    expect(runtime.published).toMatchObject([
      {
        guidance: {
          subjects: [],
          instructions: [
            {
              middlewareId: "communication",
              ruleId: rule.id,
              uncertain: { choice: "required", probability: 0.4 },
              instruction: rule.guidance,
            },
          ],
        },
      },
    ]);
  });
}

/** A rounded near-tie, as Jev reports one: the stated choice trails the maximum by one hundredth. */
const nearTie = {
  choice: "relevant",
  probabilities: { relevant: 0.49, irrelevant: 0.5, unresolved: 0.01 },
};

const announceOnce: TextRule = {
  id: "announce-once",
  kind: "norm",
  text: "Announce the final meeting time once.",
  guidance: "Announce the final time once.",
};

it(
  "admits a group message under enforcement when a norm's applicability is uncertain, advising that judgment",
  uncertainNormApplicability,
);

function uncertainNormApplicability() {
  return Effect.gen(function* () {
    const subject = yield* fixture;
    const delivery = yield* outgoingFixture(
      subject,
      yield* nearTiePolicy(announceOnce),
    );
    const sending = yield* delivery.operations
      .send({
        input: sendInput({ to: group, text: "The meeting is Tuesday." }),
      })
      .pipe(Effect.forkScoped);
    yield* Deferred.await(subject.outbound);
    const [checked] = yield* auditChecks(subject);
    expect(checked).toMatchObject({
      direction: "outgoing",
      disposition: "admitted",
      result: { judgment: "allow" },
    });
    expect(checked?.result?.guidance).toContainEqual({
      middlewareId: "owner",
      ruleId: announceOnce.id,
      uncertain: { choice: "relevant", probability: 0.49 },
      instruction: announceOnce.guidance,
    });
    yield* Fiber.interrupt(sending);
  });
}

it(
  "holds a group message under enforcement when a safety rule's applicability is uncertain",
  uncertainSafetyApplicability,
);

function uncertainSafetyApplicability() {
  return Effect.gen(function* () {
    const subject = yield* fixture;
    const delivery = yield* outgoingFixture(
      subject,
      yield* nearTiePolicy({
        id: "privacy",
        kind: "safety",
        text: "Do not disclose private appointments.",
      }),
    );
    const refusal = yield* Effect.flip(
      delivery.operations.send({
        input: sendInput({ to: group, text: "The meeting is Tuesday." }),
      }),
    );
    expect(refusal).toMatchObject({ refusal: "unresolved-evidence" });
  });
}

/** A text policy of one rule, decided by `nearTieProvider`. */
function nearTiePolicy(rule: TextRule) {
  return makeTextPolicy({
    id: "owner",
    rules: [rule],
    provider: nearTieProvider(rule),
    settings: {
      minimumProbability: 0.5,
      maximumRequestBytes: 60_000,
      timeoutMilliseconds: 5_000,
    },
  });
}

/** A decision provider certain of everything but `rule`'s applicability, which it answers with a near-tie. */
function nearTieProvider(rule: TextRule): DecisionProvider {
  return {
    decide: (request) =>
      Effect.succeed({
        provider: "test-provider",
        model: "test-model",
        usage: {},
        raw: "",
        answers: Object.fromEntries(
          Object.entries(request.questions).map(([id, question]) => [
            id,
            request.stage === "applicability" && question.ruleId === rule.id
              ? nearTie
              : certainAnswer(question),
          ]),
        ),
      }),
  };
}

/** A question's first permitting choice, answered with certainty. */
function certainAnswer(question: DecisionRequest["questions"][string]) {
  const choices = Object.keys(question.criteria);
  const choice =
    ["compliant", "none", "relevant"].find((candidate) =>
      choices.includes(candidate),
    ) ?? "unresolved";
  return {
    choice,
    probabilities: Object.fromEntries(
      choices.map((option) => [option, option === choice ? 1 : 0]),
    ),
  };
}

it(
  "records a shadow block while guidance mode admits the original message",
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
    expect(runtime.published[0]?.guidance).toBeUndefined();
  });
}

it(
  "rechecks an allow after evidence changes and then refuses the same unsent candidate",
  recheckedSend,
);

function recheckedSend() {
  return Effect.gen(function* () {
    const subject = yield* fixture;
    yield* seedIncoming(subject, true);
    const entered = yield* Deferred.make<undefined>();
    const release = yield* Deferred.make<undefined>();
    const seen: MiddlewareInput[] = [];
    const delivery = yield* outgoingFixture(
      subject,
      policy((input) =>
        Effect.gen(function* () {
          seen.push(input);
          if (seen.length === 1) {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
            return pass;
          }
          return block;
        }),
      ),
    );
    const sending = yield* delivery.operations
      .send({ input: { to: destination, text: "Draft before new evidence" } })
      .pipe(Effect.forkScoped);
    yield* Deferred.await(entered);
    yield* subject.store.bindPostIntent({
      kind: "existing-conversation",
      intent: {
        conversationId: subject.membership.descriptor.conversationId,
        membershipHash: subject.membership.hash,
        authorAgentId: subject.local.card.agentId,
        postId: "pst_concurrent",
        canonicalIntent: new Uint8Array([1]),
      },
    });
    yield* Deferred.succeed(release, undefined);
    expect(yield* Effect.flip(Fiber.join(sending))).toMatchObject({
      refusal: "prohibited",
    });
    expect(seen).toHaveLength(2);
    expect(seen[1]?.event).toEqual(seen[0]?.event);
    expect(
      (yield* subject.store.recover()).postIntents
        .filter((intent) => intent.completedRecordHash === undefined)
        .map((intent) => intent.postId),
    ).toEqual(["pst_concurrent"]);
  });
}

it(
  "does not admit an interrupted checker and releases its shared permit",
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
    expect((yield* subject.store.recover()).postIntents).toEqual([]);
    expect(
      yield* Effect.flip(
        delivery.operations.send({
          input: { to: destination, text: "Another draft" },
        }),
      ),
    ).toMatchObject({ refusal: "prohibited" });
  });
}

it(
  "holds a concurrent send when its evidence is incomplete and its recheck is unavailable",
  concurrentSends,
);
it("holds outgoing admission after two stale checks", () =>
  staleOutgoing("enforcement"));
it("admits an outgoing shadow after two stale checks without running a third inference", () =>
  staleOutgoing("guidance"));
it("holds incoming admission after two stale checks", () =>
  staleIncoming("enforcement"));
it("admits an incoming shadow after two stale checks without stale guidance", () =>
  staleIncoming("guidance"));
it(
  "captures immutable installation provenance and distinguishes provider model changes",
  installationProvenance,
);

function concurrentSends() {
  return Effect.gen(function* () {
    const subject = yield* fixture;
    const entered = yield* Queue.unbounded<MiddlewareInput>();
    const release = yield* Deferred.make<undefined>();
    const delivery = yield* outgoingFixture(
      subject,
      policy((input) =>
        Queue.offer(entered, input).pipe(
          Effect.zipRight(
            input.context.gaps.length === 0
              ? Deferred.await(release).pipe(Effect.as(pass))
              : Effect.fail(new MiddlewareError({ reason: "unavailable" })),
          ),
        ),
      ),
    );
    const first = yield* delivery.operations
      .send({ input: { to: destination, text: "First proposal" } })
      .pipe(Effect.forkScoped);
    const second = yield* delivery.operations
      .send({ input: { to: destination, text: "Second proposal" } })
      .pipe(Effect.forkScoped);
    yield* Queue.take(entered);
    yield* Queue.take(entered);
    yield* Deferred.succeed(release, undefined);
    yield* Deferred.await(subject.outbound);
    const refusal = yield* Effect.race(
      Effect.flip(Fiber.join(first)),
      Effect.flip(Fiber.join(second)),
    );
    expect(refusal).toMatchObject({ refusal: "check-unavailable" });
    expect((yield* Queue.take(entered)).context.gaps).not.toEqual([]);
    expect((yield* subject.store.recover()).postIntents).toHaveLength(1);
    yield* Fiber.interrupt(first);
    yield* Fiber.interrupt(second);
  });
}

function staleOutgoing(mode: FirewallOptions["mode"]) {
  return Effect.gen(function* () {
    const subject = yield* fixture;
    const churn = yield* churnPolicy(subject);
    const delivery = yield* outgoingFixture(churn.subject, churn.middleware, {
      mode,
    });
    const sending = yield* delivery.operations
      .send({
        input: { to: destination, text: "Draft while evidence changes" },
      })
      .pipe(Effect.forkScoped);
    if (mode === "enforcement") {
      const refusal = yield* Effect.flip(Fiber.join(sending));
      expect(refusal.message).toContain(renderedWaitAction);
      expect(refusal).toMatchObject({
        refusal: "unresolved-evidence",
        feedback: [{ nextAction: waitAction }],
      });
      expect((yield* subject.store.recover()).postIntents).toEqual([]);
    } else {
      yield* Deferred.await(subject.outbound);
      expect((yield* subject.store.recover()).postIntents).toHaveLength(1);
      yield* Fiber.interrupt(sending);
    }
    expect(churn.count()).toBe(2);
  });
}

function staleIncoming(mode: FirewallOptions["mode"]) {
  return Effect.gen(function* () {
    const subject = yield* fixture;
    const churn = yield* churnPolicy(subject);
    const runtime = yield* incomingFixture(churn.subject, churn.middleware, {
      mode,
    });
    yield* runtime.runPass;
    yield* Queue.take(runtime.completed);
    const event = yield* runtime.delivery.operations
      .readEvent({ eventId: eventIdOf(runtime.candidate.deliveryToken) })
      .pipe(Effect.either);
    expect(event._tag).toBe(mode === "guidance" ? "Right" : "Left");
    expect(churn.count()).toBe(2);
    expect(
      runtime.published.every((entry) => entry.guidance === undefined),
    ).toBe(true);
  });
}

function installationProvenance() {
  return Effect.gen(function* () {
    const model = "model-one";
    const registration = {
      ...policy(() => Effect.succeed(pass)),
      provenance: { format: "provider", data: model },
    };
    const subject = yield* fixture;
    const installed = yield* installation(subject.store, registration);
    registration.provenance.data = "model-two";
    const changed = yield* installation(subject.store, registration);
    expect(installed.metadata.incoming[0]?.provenance.data).toBe(model);
    expect(changed.configurationDigest).not.toBe(installed.configurationDigest);
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
      id: digest("col_", 84),
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
      (yield* subject.store.readFirewallFrontiers()).map(
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
  ownerHistoryStaysPrivate,
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
    const runtime = yield* incomingFixture(yield* fixture, middleware, {
      mode,
    });
    yield* runtime.runPass;
    yield* Queue.take(runtime.completed);
    expect(runtime.published).toHaveLength(mode === "guidance" ? 1 : 0);
    expect(
      runtime.published.every((entry) => entry.guidance === undefined),
    ).toBe(true);
    expect(yield* runtime.store.readFirewallFrontiers()).toEqual([]);
  });
}

function ownerHistoryStaysPrivate() {
  return Effect.gen(function* () {
    const subject = yield* fixture;
    const previous = yield* seedIncoming(subject, true);
    yield* appendCertifiedPost(subject, previous, "Can we meet?");
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
      subjects: [{ sender: `agent:${subject.remote.card.agentName}` }],
    });
  });
}
