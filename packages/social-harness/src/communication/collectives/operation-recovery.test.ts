/** @file Signed collective messages and completion decisions survive endpoint restarts. */
import { live as it, scoped as itOnClock } from "@effect/vitest";
import {
  Clock,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Option,
  Schema,
  Scope,
  TestClock,
} from "effect";
import { expect } from "vitest";
import type { AgentId } from "../../identity/identifiers.js";
import type { CollectiveId } from "./contracts.js";
import type { InboundItem } from "./inbound.js";
import type {
  BindHold,
  CollectiveAdmission,
  CollectivePorts,
  EngineSendInput,
} from "./ports.js";
import { untilLive } from "../../__tests__/advance-clock.js";
import { testAgentView } from "../../__tests__/agent-card-fixtures.js";
import {
  appendCertifiedIntent,
  appendCertifiedMessage,
  buildCertifiedFirstMessage,
  storeCertifiedFirstMessage,
} from "../../__tests__/certified-history-fixtures.js";
import {
  anchor,
  boundIntent,
  certifyBoundIntent,
  groupSubject,
  resumeEngine,
  seedGroupFirstMessage,
  waitForClose,
} from "../../__tests__/collective-recovery-fixtures.js";
import {
  engineFixture,
  type Fixture,
  installation,
  pass,
  policy,
} from "../../__tests__/firewall-runtime-fixtures.js";
import { withStore } from "../../__tests__/store-schema-fixtures.js";
import { collectiveAdmission } from "../../firewall/admission/index.js";
import { LIVE_WIRE_VERSIONS } from "../../identity/wire-version.js";
import { SendError } from "../conversations/errors.js";
import {
  AgentAddress,
  type CertifiedRecord,
  MessageAddressInput,
  MessageIntent,
  mintMsgId,
} from "../records/index.js";
import {
  decodeRuntimeValue,
  encodeRuntimeValue,
  type EndpointStore,
  type EndpointStoreError,
  openEndpointStore,
  type StoredCollectiveMessage,
  type MessageIntent as StoredMessageIntent,
} from "../store/index.js";
import { makeCollectiveOperations } from "./index.js";
import {
  encodeCollectiveContent,
  mintCollectiveId,
  readCollectiveValue,
} from "./wire/index.js";

const self = Schema.decodeUnknownSync(AgentAddress)("agent:alice");
const sender = Schema.decodeUnknownSync(AgentAddress)("agent:bob");
const response = {
  to: sender,
  collectiveResponse: { action: "accept", content: { answer: "yes" } },
} as const;

function resume(subject: Fixture, store: EndpointStore, failOutbound = false) {
  return Effect.gen(function* () {
    const engine = yield* resumeEngine(subject, store, failOutbound);
    const collective = yield* makeCollectiveOperations({
      store,
      self: testAgentView(self),
      scope: yield* Scope.Scope,
      lookupMember: (member) => Effect.succeed(testAgentView(member)),
      sendMessage: engine.send,
      bindMessage: engine.bind,
      sendAdmitted: engine.sendAdmitted,
      observeMessage: engine.observeMessage,
      reportStorageFault: () =>
        Effect.dieMessage("unexpected collective storage failure"),
      emit: () => Effect.dieMessage("a gather receiver emits no local result"),
    });
    const pending = yield* engine.readPendingMessages();
    yield* Effect.forEach(pending, collective.classify, {
      concurrency: 1,
      discard: true,
    });
    return collective;
  });
}

it(
  "keeps one bound response after caller failure and two engine restarts, then recognizes its certificate",
  () =>
    Effect.gen(function* () {
      const subject = yield* Effect.scoped(engineFixture());
      const request = yield* seedRemoteRequest(subject);
      const original = yield* claimPendingResponse(subject);
      yield* assertRecoveredResponse(subject, original, false);
      yield* certifyRecoveredResponse(subject, request, original);
      yield* assertRecoveredResponse(subject, original, true);
    }),
  20_000,
);

function seedRemoteRequest(subject: Fixture) {
  return withStore(subject.directory, (store) =>
    Effect.gen(function* () {
      const firstMessage = yield* buildCertifiedFirstMessage(
        subject.local,
        subject.remote,
        subject.membership,
        anchor.routerInstanceId,
      );
      yield* storeCertifiedFirstMessage(
        store,
        subject.local.card,
        subject.membership,
        firstMessage,
      );
      const operationId = yield* mintCollectiveId(
        testAgentView(sender).agentId,
      );
      const content = yield* encodeCollectiveContent(
        {
          kind: "operation",
          op: "gather",
          operationId,
          deadlineAt: Date.now() + 60_000,
          requestedSchema: {
            type: "object",
            properties: { answer: { type: "string" } },
            required: ["answer"],
          },
        },
        "Can you attend?",
      );
      return yield* appendCertifiedMessage(
        { ...subject, store },
        firstMessage,
        content,
      );
    }),
  );
}

function claimPendingResponse(subject: Fixture) {
  return Effect.scoped(
    Effect.gen(function* () {
      const store = yield* openEndpointStore(subject.directory, {
        liveWireVersions: LIVE_WIRE_VERSIONS,
      });
      const collective = yield* resume(subject, store, true);
      expect(yield* Effect.flip(collective.send(response))).toMatchObject({
        reason: "delivery-pending",
      });
      expect(yield* Effect.flip(collective.send(response))).toMatchObject({
        failure: { kind: "request-answered" },
      });
      const messages = yield* store.readCollectiveMessages();
      expect(messages).toHaveLength(1);
      const [message] = messages;
      if (message === undefined) {
        return yield* Effect.dieMessage("missing response intent");
      }
      return message.intent;
    }),
  );
}

function assertRecoveredResponse(
  subject: Fixture,
  original: StoredMessageIntent,
  completed: boolean,
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const store = yield* openEndpointStore(subject.directory, {
        liveWireVersions: LIVE_WIRE_VERSIONS,
      });
      const collective = yield* resume(subject, store);
      expect(yield* Effect.flip(collective.send(response))).toMatchObject({
        failure: { kind: "request-answered" },
      });
      const messages = yield* store.readCollectiveMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0]?.intent).toMatchObject({
        msgId: original.msgId,
        canonicalIntent: original.canonicalIntent,
      });
      expect(messages[0]?.intent.completedRecordHash !== undefined).toBe(
        completed,
      );
    }),
  );
}

itOnClock(
  "does not finalize an all-gather while its bind hold has no durable operation",
  () =>
    Effect.gen(function* () {
      const fixture = yield* pausedAdmission("bind");
      const sending = yield* fixture.layer
        .send({
          to: fixture.group,
          text: "Choose a time",
          collective: {
            op: "all_gather",
            deadline: 60,
            requestedSchema: fixture.schema,
          },
        })
        .pipe(Effect.fork);
      yield* Deferred.await(fixture.entered);
      yield* TestClock.adjust(Duration.minutes(2));
      expect(fixture.faults).toEqual([]);
      expect(fixture.emitted).toEqual([]);
      expect(yield* fixture.subject.store.readCollectiveOperations()).toEqual(
        [],
      );
      yield* Deferred.succeed(fixture.release, undefined);
      expect(yield* Effect.flip(Fiber.join(sending))).toMatchObject({
        failure: { kind: "members-unreachable" },
      });
    }),
);

itOnClock(
  "retires a gather refused after delayed admission so restart cannot publish it",
  () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.scoped(retireDelayedGather());
      const store = yield* openEndpointStore(fixture.directory, {
        liveWireVersions: LIVE_WIRE_VERSIONS,
      });
      yield* makeCollectiveOperations({
        ...fixture.ports,
        store,
        scope: yield* Scope.Scope,
      });
      expect(fixture.emitted).toEqual([]);
    }),
);

function retireDelayedGather() {
  return Effect.gen(function* () {
    const fixture = yield* pausedAdmission("gather");
    const sending = yield* fixture.layer
      .send({
        to: sender,
        text: "Choose a time",
        collective: {
          op: "gather",
          deadline: 60,
          requestedSchema: fixture.schema,
        },
      })
      .pipe(Effect.fork);
    yield* Deferred.await(fixture.entered);
    yield* TestClock.adjust(Duration.minutes(2));
    yield* Deferred.succeed(fixture.release, undefined);
    expect(yield* Effect.flip(Fiber.join(sending))).toMatchObject({
      failure: { kind: "deadline-passed" },
    });
    expect(
      yield* fixture.subject.store.readCollectiveOperations(),
    ).toMatchObject([{ phase: "completed" }]);
    return {
      directory: fixture.subject.directory,
      ports: fixture.ports,
      emitted: fixture.emitted,
    };
  });
}

function pausedAdmission(mode: "bind" | "gather") {
  return Effect.gen(function* () {
    const subject = yield* engineFixture();
    const entered = yield* Deferred.make<undefined>();
    const release = yield* Deferred.make<undefined>();
    const faults: EndpointStoreError[] = [];
    const emitted: InboundItem[] = [];
    const admission = pausedAdmissionPorts(
      subject.store,
      mode,
      entered,
      release,
    );
    const ports: CollectivePorts = {
      store: subject.store,
      self: testAgentView(self),
      scope: yield* Scope.Scope,
      lookupMember: (member) => Effect.succeed(testAgentView(member)),
      sendMessage: () => Effect.never,
      bindMessage: () =>
        Effect.dieMessage("checked sends use the admission port"),
      sendAdmitted: () => Effect.never,
      observeMessage: () => Effect.never,
      reportStorageFault: (error) =>
        Effect.sync(() => {
          faults.push(error);
        }),
      emit: (item) =>
        Effect.sync(() => {
          emitted.push(item);
        }),
      admission,
    };
    return {
      subject,
      ports,
      entered,
      release,
      faults,
      emitted,
      layer: yield* makeCollectiveOperations(ports),
      group: Schema.decodeUnknownSync(MessageAddressInput)(
        "group:alice,bob,carol",
      ),
      schema: { type: "object" as const, properties: {} },
    };
  });
}

function pausedAdmissionPorts(
  store: EndpointStore,
  mode: "bind" | "gather",
  entered: Deferred.Deferred<undefined>,
  release: Deferred.Deferred<undefined>,
): CollectiveAdmission {
  const barrier = Deferred.succeed(entered, undefined).pipe(
    Effect.zipRight(Deferred.await(release)),
  );
  return {
    bindMessage: <E>(...args: [EngineSendInput, BindHold<E>]) =>
      Effect.gen(function* () {
        const giveUp = yield* args[1];
        yield* barrier;
        yield* giveUp;
        return yield* new SendError({ reason: "network-unavailable" });
      }),
    admitGather: (candidate) =>
      Effect.gen(function* () {
        if (mode !== "gather" || candidate.operation === undefined) {
          return yield* Effect.dieMessage("unexpected gather admission");
        }
        yield* store.putCollectiveOperation(candidate.operation);
        yield* barrier;
        return { sendRequest: () => Effect.never };
      }),
  };
}

itOnClock(
  "finishes the same all-gather after interruption during its committed bind",
  () =>
    Effect.gen(function* () {
      const fixture = yield* interruptedBindFixture();
      const sending = yield* fixture.layer
        .send({
          to: Schema.decodeUnknownSync(MessageAddressInput)(
            "group:alice,bob,carol",
          ),
          text: "Choose a time",
          collective: {
            op: "all_gather",
            deadline: 60,
            requestedSchema: { type: "object", properties: {} },
          },
        })
        .pipe(Effect.fork);
      yield* Effect.raceFirst(
        Deferred.await(fixture.bound),
        Fiber.join(sending).pipe(
          Effect.zipRight(
            Effect.dieMessage(
              "send completed before its bound intent was observed",
            ),
          ),
        ),
      );
      const original = yield* boundIntent(fixture.store, "request");
      yield* Fiber.interruptFork(sending);
      yield* Deferred.succeed(fixture.release, undefined);
      expect(Exit.isInterrupted(yield* Fiber.await(sending))).toBe(true);
      const request = yield* certifyBoundIntent(
        fixture,
        fixture.head,
        original,
      );
      yield* TestClock.adjust(Duration.minutes(2));
      yield* waitForClose(fixture.store);
      const close = yield* boundIntent(fixture.store, "close");
      yield* certifyBoundIntent(fixture, request, close);
      expect(yield* Deferred.await(fixture.emitted)).toMatchObject({
        kind: "collectiveResult",
        op: "all_gather",
      });
      expect(yield* fixture.store.readCollectiveMessages()).toMatchObject([
        { role: "request", intent: { msgId: original.msgId } },
        { role: "close", intent: { msgId: close.msgId } },
      ]);
    }),
);

function interruptedBindFixture(pause: "before" | "after" = "after") {
  return Effect.gen(function* () {
    const subject = yield* groupSubject(yield* Effect.scoped(engineFixture()));
    const head = yield* seedGroupFirstMessage(subject);
    const originalStore = yield* openEndpointStore(subject.directory, {
      liveWireVersions: LIVE_WIRE_VERSIONS,
    });
    const bound = yield* Deferred.make<undefined>();
    const release = yield* Deferred.make<undefined>();
    const emitted = yield* Deferred.make<InboundItem>();
    const store: EndpointStore = {
      ...originalStore,
      bindCheckedMessageIntent: (binding, completion) => {
        const bind = originalStore.bindCheckedMessageIntent(
          binding,
          completion,
        );
        const barrier = Deferred.succeed(bound, undefined).pipe(
          Effect.zipRight(Deferred.await(release)),
        );
        return pause === "before"
          ? barrier.pipe(Effect.zipRight(bind))
          : bind.pipe(Effect.tap(() => barrier));
      },
    };
    const engine = yield* resumeEngine(subject, store);
    const installed = yield* installation(
      store,
      policy(() => Effect.succeed(pass)),
    );
    const layer = yield* makeCollectiveOperations({
      store,
      self: testAgentView(self),
      scope: yield* Scope.Scope,
      lookupMember: (member) => Effect.succeed(testAgentView(member)),
      sendMessage: engine.send,
      bindMessage: engine.bind,
      sendAdmitted: engine.sendAdmitted,
      observeMessage: engine.observeMessage,
      reportStorageFault: () =>
        Effect.dieMessage("unexpected persistence fault"),
      emit: (item) => Deferred.succeed(emitted, item).pipe(Effect.asVoid),
      admission: collectiveAdmission(
        { installed, store, localAgentCard: subject.local.card },
        engine,
      ),
    });
    return { subject, head, store, engine, layer, bound, release, emitted };
  });
}

itOnClock(
  "keeps an interrupted bound answer claimed and includes it in the group close",
  () =>
    Effect.gen(function* () {
      const fixture = yield* interruptedBindFixture();
      const request = yield* admittedGroupRequest(fixture);
      const input = {
        to: Schema.decodeUnknownSync(MessageAddressInput)(
          "group:alice,bob,carol",
        ),
        collectiveResponse: { action: "accept", content: { answer: "Monday" } },
      } as const;
      const sending = yield* fixture.layer.send(input).pipe(Effect.fork);
      yield* Deferred.await(fixture.bound);
      const original = yield* boundIntent(fixture.store, "response");
      yield* Fiber.interruptFork(sending);
      yield* Deferred.succeed(fixture.release, undefined);
      expect(Exit.isInterrupted(yield* Fiber.await(sending))).toBe(true);
      expect(yield* Effect.flip(fixture.layer.send(input))).toMatchObject({
        failure: { kind: "request-answered" },
      });
      const answer = yield* certifyBoundIntent(
        fixture,
        request.record,
        original,
      );
      const close = yield* certifyBoundIntent(fixture, answer, {
        ...request.record.actionCertifiedRecord.recordCore.action.messageIntent,
        msgId: yield* mintMsgId(),
        content: yield* encodeCollectiveContent({
          kind: "close",
          closedAt: 60_000,
          closedBy: "deadline",
          operationId: request.operationId,
          included: [answer.actionCertifiedRecord.recordHash],
        }),
      });
      yield* classifyCertified(fixture, close);
      assertOwnAnswer(yield* Deferred.await(fixture.emitted));
      expect(yield* fixture.store.readCollectiveMessages()).toMatchObject([
        { role: "response", intent: { msgId: original.msgId } },
      ]);
    }),
);

function admittedGroupRequest(
  fixture: Effect.Effect.Success<ReturnType<typeof interruptedBindFixture>>,
) {
  return Effect.gen(function* () {
    const operationId = yield* mintCollectiveId(testAgentView(sender).agentId);
    const content = yield* encodeCollectiveContent(
      {
        kind: "operation",
        op: "all_gather",
        operationId,
        deadlineAt: (yield* Clock.currentTimeMillis) + 60_000,
        requestedSchema: {
          type: "object",
          properties: { answer: { type: "string" } },
          required: ["answer"],
        },
      },
      "Choose a day",
    );
    const record = yield* certifyBoundIntent(fixture, fixture.head, {
      ...fixture.head.actionCertifiedRecord.recordCore.action.messageIntent,
      msgId: yield* mintMsgId(),
      content,
    });
    const { item, deliveryToken } = yield* classifyCertified(fixture, record);
    if (Option.isNone(item)) {
      return yield* Effect.dieMessage("missing group request");
    }
    yield* fixture.store.putInboxItem({
      deliveryToken,
      canonicalItem: yield* encodeRuntimeValue(item.value),
    });
    yield* fixture.layer.settleRequest(operationId, true);
    return { operationId, record };
  });
}

function classifyCertified(
  fixture: Effect.Effect.Success<ReturnType<typeof interruptedBindFixture>>,
  record: CertifiedRecord,
) {
  return fixture.engine.readPendingMessages().pipe(
    Effect.flatMap((pending) =>
      Effect.fromNullable(
        pending.find(
          (entry) =>
            entry.recordHash === record.actionCertifiedRecord.recordHash,
        ),
      ),
    ),
    Effect.flatMap((pending) =>
      fixture.layer.classify(pending).pipe(
        Effect.map((item) => ({
          item,
          deliveryToken: pending.deliveryToken,
        })),
      ),
    ),
  );
}

itOnClock(
  "keeps a local message pending when a peer certifies the same message ID",
  () =>
    Effect.gen(function* () {
      const subject = yield* Effect.scoped(engineFixture());
      const head = yield* seedRemoteRequest(subject);
      const store = yield* openEndpointStore(subject.directory, {
        liveWireVersions: LIVE_WIRE_VERSIONS,
      });
      const engine = yield* resumeEngine(subject, store);
      const sending = yield* engine
        .send({
          to: sender,
          content: [{ type: "text", text: "Local request" }],
        })
        .pipe(Effect.fork);
      yield* untilLive(
        store.recover().pipe(
          Effect.map((recovery) => recovery.messageIntents.length === 1),
          Effect.orDie,
        ),
      );
      const recovery = yield* store.recover();
      const retained = yield* Effect.fromNullable(recovery.messageIntents[0]);
      const intent = yield* decodeRuntimeValue(
        MessageIntent,
        retained.canonicalIntent,
      );
      const peer = yield* certifyBoundIntent({ subject, engine }, head, {
        ...intent,
        authorAgentId: subject.remote.card.agentId,
        content: [{ type: "text", text: "Peer request" }],
      });
      const observing = yield* engine
        .observeMessage(intent.msgId)
        .pipe(Effect.timeoutOption("10 millis"), Effect.fork);
      yield* TestClock.adjust("10 millis");
      expect(Option.isNone(yield* Fiber.join(observing))).toBe(true);
      const local = yield* certifyBoundIntent(
        { subject, engine },
        peer,
        intent,
      );
      expect(yield* engine.observeMessage(intent.msgId)).toEqual({
        msgId: intent.msgId,
        recordHash: local.actionCertifiedRecord.recordHash,
      });
      expect(
        (yield* store.recover()).messageIntents[0]?.completedRecordHash,
      ).toBe(local.actionCertifiedRecord.recordHash);
      yield* Fiber.interrupt(sending);
    }),
);

function certifyRecoveredResponse(
  subject: Fixture,
  request: CertifiedRecord,
  original: StoredMessageIntent,
) {
  return withStore(subject.directory, (store) =>
    Effect.gen(function* () {
      const intent = yield* decodeRuntimeValue(
        MessageIntent,
        original.canonicalIntent,
      );
      yield* appendCertifiedIntent({ ...subject, store }, request, intent);
    }),
  );
}

function assertOwnAnswer(item: InboundItem) {
  expect(item).toMatchObject({ kind: "collectiveResult", op: "all_gather" });
  const outcomes = item.kind === "collectiveResult" ? item.outcomes : [];
  expect(
    outcomes.find((outcome) => outcome.member.agentName === "alice"),
  ).toEqual({
    member: testAgentView(self),
    outcome: { kind: "answered", content: { answer: "Monday" } },
  });
}

itOnClock(
  "reports an expired request when its close wins before a held response binds",
  () =>
    Effect.gen(function* () {
      const fixture = yield* interruptedBindFixture("before");
      const request = yield* admittedGroupRequest(fixture);
      const close = yield* certifyBoundIntent(fixture, request.record, {
        ...request.record.actionCertifiedRecord.recordCore.action.messageIntent,
        msgId: yield* mintMsgId(),
        content: yield* encodeCollectiveContent({
          kind: "close",
          closedAt: 60_000,
          closedBy: "deadline",
          operationId: request.operationId,
          included: [],
        }),
      });
      const sending = yield* fixture.layer
        .send({
          to: Schema.decodeUnknownSync(MessageAddressInput)(
            "group:alice,bob,carol",
          ),
          collectiveResponse: {
            operationId: request.operationId,
            action: "accept",
            content: { answer: "Monday" },
          },
        })
        .pipe(Effect.fork);
      yield* Deferred.await(fixture.bound);
      yield* classifyCertified(fixture, close);
      yield* Deferred.succeed(fixture.release, undefined);
      const failure = yield* Effect.flip(Fiber.join(sending));
      expect(
        failure._tag === "CollectiveError"
          ? failure.failure
          : { kind: failure._tag, message: failure.message },
      ).toEqual({ kind: "request-expired" });
      expect(
        yield* fixture.store.readCollectiveMessages({
          operationId: request.operationId,
          role: "response",
        }),
      ).toEqual([]);
      expect(yield* Deferred.await(fixture.emitted)).toMatchObject({
        kind: "collectiveResult",
        operationId: request.operationId,
      });
    }),
);

it.each(["operation", "author"] as const)(
  "refuses a retained response whose %s disagrees with its accepted claim",
  (changed) =>
    Effect.gen(function* () {
      const subject = yield* Effect.scoped(engineFixture());
      yield* seedRemoteRequest(subject);
      yield* claimPendingResponse(subject);
      const otherOperationId = yield* mintCollectiveId(
        subject.remote.card.agentId,
      );
      const changes = {
        ...(changed === "operation" ? { operationId: otherOperationId } : {}),
        ...(changed === "author"
          ? { authorAgentId: subject.remote.card.agentId }
          : {}),
      };
      const failure = yield* withStore(subject.directory, (store) =>
        Effect.scoped(
          Effect.flip(resume(subject, corruptResponses(store, changes))),
        ),
      );
      expect(failure).toMatchObject({ reason: "corrupt" });
    }),
);

interface ResponseChanges {
  readonly operationId?: CollectiveId;
  readonly authorAgentId?: AgentId;
}

function corruptResponses(
  store: EndpointStore,
  changes: ResponseChanges,
): EndpointStore {
  return {
    ...store,
    readCollectiveMessages: (filter) =>
      store
        .readCollectiveMessages(filter)
        .pipe(
          Effect.flatMap((messages) =>
            Effect.forEach(
              messages,
              (message) => changedResponse(message, changes),
              { concurrency: 1 },
            ),
          ),
        ),
  };
}

function changedResponse(
  message: StoredCollectiveMessage,
  changes: ResponseChanges,
) {
  return Effect.gen(function* () {
    const intent = yield* decodeRuntimeValue(
      MessageIntent,
      message.intent.canonicalIntent,
    );
    const value = yield* readCollectiveValue(intent.content).pipe(Effect.orDie);
    if (Option.isNone(value) || value.value.kind !== "response") {
      return yield* Effect.dieMessage("expected a retained response");
    }
    const content =
      changes.operationId === undefined
        ? intent.content
        : yield* encodeCollectiveContent({
            ...value.value,
            operationId: changes.operationId,
          }).pipe(Effect.orDie);
    return {
      ...message,
      intent: {
        ...message.intent,
        canonicalIntent: yield* encodeRuntimeValue({
          ...intent,
          content,
          authorAgentId: changes.authorAgentId ?? intent.authorAgentId,
        }),
      },
    };
  });
}
