/** @file Real signed response intents remain the same answer through store and engine restarts. */

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
import type { InboundItem } from "./inbound.js";
import type {
  BindHold,
  CollectiveAdmission,
  CollectivePorts,
  EngineSendInput,
} from "./ports.js";
import { untilLive } from "../../__tests__/advance-clock.js";
import { identifier } from "../../__tests__/agent-card-fixtures.js";
import {
  appendCertifiedIntent,
  appendCertifiedPost,
  buildCertifiedGenesis,
  buildCertifiedPost,
  signEvidence,
  storeCertifiedGenesis,
} from "../../__tests__/certified-history-fixtures.js";
import {
  engineFixture,
  type Fixture,
  installation,
  pass,
  policy,
} from "../../__tests__/firewall-runtime-fixtures.js";
import { pollCursor } from "../../__tests__/router-worker-fixtures.js";
import { withStore } from "../../__tests__/store-schema-fixtures.js";
import { collectiveAdmission } from "../../firewall/admission/index.js";
import { AgentCard } from "../../identity/cards.js";
import {
  LIVE_WIRE_VERSIONS,
  WIRE_VERSION,
} from "../../identity/wire-version.js";
import { SendError } from "../conversations/errors.js";
import {
  type EndpointEngine,
  makeEndpointEngine,
} from "../conversations/index.js";
import {
  AgentAddress,
  type CertifiedRecord,
  deriveConversationId,
  MembershipDescriptor,
  MessageAddressInput,
  mintPostId,
  PostIntent,
  signOuterPacket,
  verifyMembershipDescriptor,
} from "../records/index.js";
import { RouterInstanceId } from "../router/api/contract.js";
import {
  decodeRuntimeValue,
  encodeRuntimeValue,
  type EndpointStore,
  EndpointStoreError,
  openEndpointStore,
  type PostIntent as StoredPostIntent,
} from "../store/index.js";
import { makeCollectiveOperations } from "./index.js";
import { encodeCollectiveContent, mintCollectiveId } from "./wire/index.js";

const self = Schema.decodeUnknownSync(AgentAddress)("agent:alice");
const sender = Schema.decodeUnknownSync(AgentAddress)("agent:bob");
const anchor = {
  routerInstanceId: Schema.decodeUnknownSync(RouterInstanceId)(
    identifier("rti_", 33),
  ),
  pollCursor: pollCursor(34),
};
const response = {
  to: sender,
  collectiveResponse: { action: "accept", content: { answer: "yes" } },
} as const;

function resume(subject: Fixture, store: EndpointStore, failOutbound = false) {
  return Effect.gen(function* () {
    const engine = yield* resumeEngine(subject, store, failOutbound);
    return yield* makeCollectiveOperations({
      store,
      self,
      scope: yield* Scope.Scope,
      lookupMember: () => Effect.void,
      sendPost: engine.send,
      sendAdmitted: engine.sendAdmitted,
      observePost: engine.observePost,
      reportStorageFault: () =>
        Effect.dieMessage("unexpected collective storage failure"),
      emit: () => Effect.dieMessage("a gather receiver emits no local result"),
    });
  });
}

function resumeEngine(
  subject: Fixture,
  store: EndpointStore,
  failOutbound = false,
) {
  return Effect.gen(function* () {
    const writes = { fail: false };
    const engine = yield* makeEndpointEngine({
      localAgentCard: subject.local.card,
      signingAuthority: subject.local.authority,
      registrySignerPublicKey: subject.signer,
      registry: {
        lookup: (request) =>
          Effect.succeed({
            kind: "found",
            agentCard:
              "agentName" in request &&
              request.agentName === subject.third.card.agentName
                ? subject.third.card
                : subject.remote.card,
          }),
      },
      store: {
        ...store,
        enqueueOutbound: (message) =>
          writes.fail
            ? Effect.fail(new EndpointStoreError({ reason: "persistence" }))
            : store.enqueueOutbound(message),
      },
      reportStorageFault: () => Effect.void,
      routerWorker: {
        currentAnchor: Effect.succeed(anchor),
        awaitAnchor: Effect.succeed(anchor),
        send: () => Effect.void,
      },
    });
    writes.fail = failOutbound;
    return engine;
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
      const genesis = yield* buildCertifiedGenesis(
        subject.local,
        subject.remote,
        subject.membership,
        anchor.routerInstanceId,
      );
      yield* storeCertifiedGenesis(
        store,
        subject.local.card,
        subject.membership,
        genesis,
      );
      const { id, nonce } = yield* mintCollectiveId(sender);
      const content = yield* encodeCollectiveContent(
        {
          kind: "operation",
          op: "gather",
          id,
          nonce,
          deadlineAt: Date.now() + 60_000,
          requestedSchema: {
            type: "object",
            properties: { answer: { type: "string" } },
            required: ["answer"],
          },
        },
        "Can you attend?",
      );
      return yield* appendCertifiedPost(
        { ...subject, store },
        genesis,
        content,
      );
    }),
  );
}

function deliverRecord(
  subject: Fixture,
  engine: EndpointEngine,
  record: CertifiedRecord,
) {
  return Effect.gen(function* () {
    const message = yield* signOuterPacket({
      packet: record,
      membership: subject.membership,
      agentCard: subject.remote.card,
      signingAuthority: subject.remote.authority,
    });
    const accepted = yield* engine.acceptRouterIngress({
      routerInstanceId: anchor.routerInstanceId,
      message,
      senderCard: subject.remote.card,
      payload: { kind: "direct", packet: record },
    });
    expect({ accepted }).toEqual({ accepted: "accepted" });
  });
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
      const posts = yield* store.readCollectivePosts();
      expect(posts).toHaveLength(1);
      const [post] = posts;
      if (post === undefined) {
        return yield* Effect.dieMessage("missing response intent");
      }
      return post.intent;
    }),
  );
}

function assertRecoveredResponse(
  subject: Fixture,
  original: StoredPostIntent,
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
      const posts = yield* store.readCollectivePosts();
      expect(posts).toHaveLength(1);
      expect(posts[0]?.intent).toMatchObject({
        postId: original.postId,
        canonicalIntent: original.canonicalIntent,
      });
      expect(posts[0]?.intent.completedRecordHash !== undefined).toBe(
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
      self,
      scope: yield* Scope.Scope,
      lookupMember: () => Effect.void,
      sendPost: () => Effect.never,
      sendAdmitted: () => Effect.never,
      observePost: () => Effect.never,
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
    bindPost: <E>(...args: [EngineSendInput, BindHold<E>]) =>
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
      expect(yield* fixture.store.readCollectivePosts()).toMatchObject([
        { role: "request", intent: { postId: original.postId } },
        { role: "close", intent: { postId: close.postId } },
      ]);
    }),
);

function interruptedBindFixture() {
  return Effect.gen(function* () {
    const subject = yield* groupSubject(yield* Effect.scoped(engineFixture()));
    const head = yield* seedGroupGenesis(subject);
    const originalStore = yield* openEndpointStore(subject.directory, {
      liveWireVersions: LIVE_WIRE_VERSIONS,
    });
    const bound = yield* Deferred.make<undefined>();
    const release = yield* Deferred.make<undefined>();
    const emitted = yield* Deferred.make<InboundItem>();
    const store: EndpointStore = {
      ...originalStore,
      bindCheckedPostIntent: (binding, completion) =>
        originalStore.bindCheckedPostIntent(binding, completion).pipe(
          Effect.tap(() => Deferred.succeed(bound, undefined)),
          Effect.tap(() => Deferred.await(release)),
        ),
    };
    const engine = yield* resumeEngine(subject, store);
    const installed = yield* installation(
      store,
      policy(() => Effect.succeed(pass)),
    );
    const layer = yield* makeCollectiveOperations({
      store,
      self,
      scope: yield* Scope.Scope,
      lookupMember: () => Effect.void,
      sendPost: engine.send,
      sendAdmitted: engine.sendAdmitted,
      observePost: engine.observePost,
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

function groupSubject(subject: Fixture) {
  return Effect.gen(function* () {
    const cards = [
      subject.local.card,
      subject.remote.card,
      subject.third.card,
    ] as const;
    const descriptor = yield* Schema.decodeUnknown(MembershipDescriptor)({
      sharnessVersion: WIRE_VERSION,
      kind: "membership_descriptor",
      conversationId: yield* deriveConversationId([
        subject.local.card.agentId,
        subject.remote.card.agentId,
        subject.third.card.agentId,
      ]),
      members: yield* Effect.forEach(
        cards,
        (card) => Schema.encode(AgentCard)(card),
        {
          concurrency: 1,
        },
      ),
    });
    return {
      ...subject,
      membership: yield* verifyMembershipDescriptor(descriptor, subject.signer),
    };
  });
}

function seedGroupGenesis(subject: Fixture) {
  return withStore(subject.directory, (store) =>
    Effect.gen(function* () {
      const partial = yield* buildCertifiedGenesis(
        subject.local,
        subject.remote,
        subject.membership,
        anchor.routerInstanceId,
      );
      const record = yield* completeGroupCertificate(subject, partial);
      yield* storeCertifiedGenesis(
        store,
        subject.local.card,
        subject.membership,
        record,
      );
      return record;
    }),
  );
}

function completeGroupCertificate(subject: Fixture, record: CertifiedRecord) {
  if (subject.membership.members.length === 2) {
    return Effect.succeed(record);
  }
  return Effect.gen(function* () {
    const certified = record.actionCertifiedRecord;
    const action = yield* signEvidence(subject.third, {
      sharnessVersion: WIRE_VERSION,
      kind: "action_signature",
      signerAgentId: subject.third.card.agentId,
      actionHash: certified.recordCore.actionHash,
    });
    const vote = yield* signEvidence(subject.third, {
      sharnessVersion: WIRE_VERSION,
      kind: "durability_vote",
      signerAgentId: subject.third.card.agentId,
      conversationId: subject.membership.descriptor.conversationId,
      membershipHash: subject.membership.hash,
      recordHash: certified.recordHash,
    });
    const completed: CertifiedRecord = {
      ...record,
      actionCertifiedRecord: {
        ...certified,
        actionCertificate: {
          ...certified.actionCertificate,
          signatures: [...certified.actionCertificate.signatures, action],
        },
      },
      durabilityCertificate: {
        ...record.durabilityCertificate,
        votes: [...record.durabilityCertificate.votes, vote],
      },
    };
    return completed;
  });
}

function boundIntent(
  store: EndpointStore,
  role: "request" | "response" | "close",
) {
  return store.readCollectivePosts().pipe(
    Effect.flatMap((posts) =>
      Effect.fromNullable(posts.find((post) => post.role === role)),
    ),
    Effect.flatMap((post) =>
      decodeRuntimeValue(PostIntent, post.intent.canonicalIntent),
    ),
  );
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
        ...request.record.actionCertifiedRecord.recordCore.action.postIntent,
        postId: yield* mintPostId(),
        content: yield* encodeCollectiveContent({
          kind: "close",
          id: request.id,
          included: [answer.actionCertifiedRecord.recordHash],
        }),
      });
      yield* classifyCertified(fixture, close);
      assertOwnAnswer(yield* Deferred.await(fixture.emitted));
      expect(yield* fixture.store.readCollectivePosts()).toMatchObject([
        { role: "response", intent: { postId: original.postId } },
      ]);
    }),
);

function admittedGroupRequest(
  fixture: Effect.Effect.Success<ReturnType<typeof interruptedBindFixture>>,
) {
  return Effect.gen(function* () {
    const { id, nonce } = yield* mintCollectiveId(sender);
    const content = yield* encodeCollectiveContent(
      {
        kind: "operation",
        op: "all_gather",
        id,
        nonce,
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
      ...fixture.head.actionCertifiedRecord.recordCore.action.postIntent,
      postId: yield* mintPostId(),
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
    yield* fixture.layer.settleRequest(id, true);
    return { id, record };
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

function certifyBoundIntent(
  fixture: { readonly subject: Fixture; readonly engine: EndpointEngine },
  previous: CertifiedRecord,
  intent: PostIntent,
) {
  return buildCertifiedPost(fixture.subject, previous, intent).pipe(
    Effect.flatMap((record) =>
      completeGroupCertificate(fixture.subject, record),
    ),
    Effect.tap((record) =>
      deliverRecord(fixture.subject, fixture.engine, record),
    ),
  );
}

itOnClock(
  "keeps a local post pending when a peer certifies the same post ID",
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
          Effect.map((recovery) => recovery.postIntents.length === 1),
          Effect.orDie,
        ),
      );
      const recovery = yield* store.recover();
      const retained = yield* Effect.fromNullable(recovery.postIntents[0]);
      const intent = yield* decodeRuntimeValue(
        PostIntent,
        retained.canonicalIntent,
      );
      const peer = yield* certifyBoundIntent({ subject, engine }, head, {
        ...intent,
        authorAgentId: subject.remote.card.agentId,
        content: [{ type: "text", text: "Peer request" }],
      });
      const observing = yield* engine
        .observePost(intent.postId)
        .pipe(Effect.timeoutOption("10 millis"), Effect.fork);
      yield* TestClock.adjust("10 millis");
      expect(Option.isNone(yield* Fiber.join(observing))).toBe(true);
      const local = yield* certifyBoundIntent(
        { subject, engine },
        peer,
        intent,
      );
      expect(yield* engine.observePost(intent.postId)).toEqual({
        postId: intent.postId,
        recordHash: local.actionCertifiedRecord.recordHash,
      });
      expect((yield* store.recover()).postIntents[0]?.completedRecordHash).toBe(
        local.actionCertifiedRecord.recordHash,
      );
      yield* Fiber.interrupt(sending);
    }),
);

function certifyRecoveredResponse(
  subject: Fixture,
  request: CertifiedRecord,
  original: StoredPostIntent,
) {
  return withStore(subject.directory, (store) =>
    Effect.gen(function* () {
      const intent = yield* decodeRuntimeValue(
        PostIntent,
        original.canonicalIntent,
      );
      yield* appendCertifiedIntent({ ...subject, store }, request, intent);
    }),
  );
}

function waitForClose(store: EndpointStore) {
  return untilLive(
    store.readCollectivePosts().pipe(
      Effect.map((posts) => posts.some((post) => post.role === "close")),
      Effect.orDie,
    ),
  );
}

function assertOwnAnswer(item: InboundItem) {
  expect(item).toMatchObject({ kind: "collectiveResult", op: "all_gather" });
  const outcomes = item.kind === "collectiveResult" ? item.outcomes : [];
  expect(outcomes.find((outcome) => outcome.member === self)).toEqual({
    member: self,
    outcome: { kind: "answered", content: { answer: "Monday" } },
  });
}
