/** @file Plain sends distinguish Router attachment from ownership of a bound collective post. */

import { scoped as it } from "@effect/vitest";
import {
  Deferred,
  Effect,
  Fiber,
  Option,
  Schema,
  Scope,
  TestClock,
} from "effect";
import { expect } from "vitest";
import { identifier } from "../../__tests__/agent-card-fixtures.js";
import { signEvidence } from "../../__tests__/certified-history-fixtures.js";
import { engineFixture } from "../../__tests__/firewall-runtime-fixtures.js";
import { pollCursor } from "../../__tests__/router-worker-fixtures.js";
import { makeHostDelivery } from "../../daemon/inbox/host-delivery.js";
import { WIRE_VERSION } from "../../identity/wire-version.js";
import { makeEndpointEngine } from "../conversations/index.js";
import {
  ActionCore,
  AgentAddress,
  CertifiedRecord,
  hashAction,
  hashAnchor,
  hashPostIntent,
  hashRecord,
  InitialAnchorBody,
  MembershipDescriptor,
  MessageAddressInput,
  PostIntent,
  type RecordCore,
  signOuterPacket,
  verifyMembershipDescriptor,
} from "../records/index.js";
import { RouterInstanceId } from "../router/api/contract.js";
import { RouterWorkerUnavailableError } from "../router/index.js";
import { decodeRuntimeValue, type EndpointStore } from "../store/index.js";
import { makeCollectiveOperations } from "./index.js";

it("waits for Router attachment before reporting a bound all-gather as pending", () =>
  Effect.gen(function* () {
    const fixture = yield* attachingEndpoint();
    const sending = yield* fixture.send(60).pipe(Effect.fork);
    yield* Deferred.await(fixture.attaching);
    yield* TestClock.adjust("20 seconds");

    expect(Option.isNone(yield* Fiber.poll(sending))).toBe(true);
    expect(yield* fixture.store.readCollectiveOperations()).toEqual([]);
    expect(yield* fixture.store.readCollectivePosts()).toEqual([]);

    yield* Deferred.succeed(fixture.attached, undefined);
    expect(yield* Effect.flip(Fiber.join(sending))).toMatchObject({
      reason: "delivery-pending",
    });
    const operations = yield* fixture.store.readCollectiveOperations();
    const posts = yield* fixture.store.readCollectivePosts();
    expect(operations).toHaveLength(1);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      operationId: operations[0]?.operationId,
      role: "request",
    });
    const certified = yield* certifyPendingRequest(fixture);
    expect(yield* fixture.engine.observePost(certified.postId)).toEqual(
      certified,
    );
    expect(
      (yield* fixture.store.readCollectivePosts()).map(
        (post) => post.intent.postId,
      ),
    ).toEqual([certified.postId]);
  }));

it("refuses an all-gather whose deadline passes before Router attachment without binding it", () =>
  Effect.gen(function* () {
    const fixture = yield* attachingEndpoint();
    const sending = yield* fixture.send(5).pipe(Effect.fork);
    yield* Deferred.await(fixture.attaching);
    yield* TestClock.adjust("10 seconds");
    yield* Deferred.succeed(fixture.attached, undefined);

    expect(yield* Effect.flip(Fiber.join(sending))).toMatchObject({
      failure: { kind: "deadline-passed" },
    });
    expect(yield* fixture.store.readCollectiveOperations()).toEqual([]);
    expect(yield* fixture.store.readCollectivePosts()).toEqual([]);
  }));

it("refuses an all-gather whose deadline passes while another send owns the engine gate", () =>
  Effect.gen(function* () {
    const binding = yield* Deferred.make<undefined>();
    const bound = yield* Deferred.make<undefined>();
    const fixture = yield* attachingEndpoint(
      Deferred.succeed(binding, undefined).pipe(
        Effect.zipRight(Deferred.await(bound)),
      ),
    );
    yield* Deferred.succeed(fixture.attached, undefined);
    const first = yield* fixture.engine
      .bind(
        {
          to: Schema.decodeUnknownSync(MessageAddressInput)("agent:bob"),
          content: [{ type: "text", text: "Earlier message" }],
        },
        Effect.succeed(Effect.void),
      )
      .pipe(Effect.fork);
    yield* Deferred.await(binding);

    const sending = yield* fixture.send(5).pipe(Effect.fork);
    yield* TestClock.adjust("10 seconds");
    yield* Deferred.succeed(bound, undefined);
    yield* Fiber.join(first);

    expect(yield* Effect.flip(Fiber.join(sending))).toMatchObject({
      failure: { kind: "deadline-passed" },
    });
    expect(yield* fixture.store.readCollectiveOperations()).toEqual([]);
    expect(yield* fixture.store.readCollectivePosts()).toEqual([]);
    expect((yield* fixture.store.recover()).postIntents).toHaveLength(1);
  }));

function attachingEndpoint(pausePlainBind?: Effect.Effect<unknown>) {
  return Effect.gen(function* () {
    const subject = yield* engineFixture();
    const attaching = yield* Deferred.make<undefined>();
    const attached = yield* Deferred.make<undefined>();
    const { engine, anchor } = yield* attachingEngine(
      subject,
      attaching,
      attached,
      pausePlainBind ?? Effect.void,
    );
    const scope = yield* Scope.Scope;
    const collectives = yield* makeCollectiveOperations({
      store: subject.store,
      self: Schema.decodeUnknownSync(AgentAddress)("agent:alice"),
      lookupMember: engine.resolveAddress,
      sendPost: engine.send,
      bindPost: engine.bind,
      sendAdmitted: engine.sendAdmitted,
      observePost: engine.observePost,
      reportStorageFault: () => Effect.dieMessage("unexpected storage fault"),
      emit: () => Effect.void,
      scope,
    });
    const delivery = yield* makeHostDelivery({
      store: subject.store,
      collectives: () => collectives,
      scope,
      historyExport: { record: () => Effect.void },
    });
    return {
      store: subject.store,
      subject,
      engine,
      anchor,
      attaching,
      attached,
      send: (deadline: number) =>
        delivery.operations.send({ input: allGatherInput(deadline) }),
    };
  });
}

function attachingEngine(
  subject: Effect.Effect.Success<ReturnType<typeof engineFixture>>,
  attaching: Deferred.Deferred<undefined>,
  attached: Deferred.Deferred<undefined>,
  pausePlainBind: Effect.Effect<unknown>,
) {
  return Effect.gen(function* () {
    const anchor = {
      routerInstanceId: Schema.decodeUnknownSync(RouterInstanceId)(
        identifier("rti_", 61),
      ),
      pollCursor: pollCursor(62),
    };
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
      store: pauseUnrelatedBinds(subject.store, pausePlainBind),
      reportStorageFault: () => Effect.dieMessage("unexpected storage fault"),
      routerWorker: {
        currentAnchor: Deferred.isDone(attached).pipe(
          Effect.flatMap((ready) =>
            ready
              ? Effect.succeed(anchor)
              : Effect.fail(new RouterWorkerUnavailableError()),
          ),
        ),
        awaitAnchor: Deferred.succeed(attaching, undefined).pipe(
          Effect.zipRight(Deferred.await(attached)),
          Effect.as(anchor),
        ),
        send: () => Effect.void,
      },
    });
    return { engine, anchor };
  });
}

function certifyPendingRequest(
  fixture: Effect.Effect.Success<ReturnType<typeof attachingEndpoint>>,
) {
  return Effect.gen(function* () {
    const action = yield* pendingAction(fixture);
    const record = yield* certifyAction(fixture, action);
    const membership = yield* verifyMembershipDescriptor(
      action.membership,
      fixture.subject.signer,
    );
    const message = yield* signOuterPacket({
      packet: record,
      membership,
      agentCard: fixture.subject.remote.card,
      signingAuthority: fixture.subject.remote.authority,
    });
    yield* fixture.engine.acceptRouterIngress({
      routerInstanceId: fixture.anchor.routerInstanceId,
      message,
      senderCard: fixture.subject.remote.card,
      payload: { kind: "direct", packet: record },
    });
    return {
      postId: action.postIntent.postId,
      recordHash: record.actionCertifiedRecord.recordHash,
    };
  });
}

function pendingAction(
  fixture: Effect.Effect.Success<ReturnType<typeof attachingEndpoint>>,
) {
  return Effect.gen(function* () {
    const recovery = yield* fixture.store.recover();
    const bound = yield* Effect.fromNullable(recovery.postIntents[0]);
    const storedMembership = yield* Effect.fromNullable(
      recovery.memberships[0],
    );
    const storedAnchor = yield* Effect.fromNullable(recovery.anchors[0]);
    const intent = yield* decodeRuntimeValue(PostIntent, bound.canonicalIntent);
    const action = yield* Schema.decodeUnknown(ActionCore)({
      sharnessVersion: WIRE_VERSION,
      kind: "FIRST_MESSAGE",
      conversationId: intent.conversationId,
      membership: yield* decodeRuntimeValue(
        MembershipDescriptor,
        storedMembership.canonicalMembership,
      ),
      anchor: yield* decodeRuntimeValue(
        InitialAnchorBody,
        storedAnchor.canonicalAnchor,
      ),
      previousRecordHash: null,
      postIntent: intent,
      postIntentHash: yield* hashPostIntent(intent),
    });
    if (action.kind !== "FIRST_MESSAGE") {
      return yield* Effect.dieMessage("expected the first group request");
    }
    return action;
  });
}

function certifyAction(
  fixture: Effect.Effect.Success<ReturnType<typeof attachingEndpoint>>,
  action: Extract<ActionCore, { kind: "FIRST_MESSAGE" }>,
) {
  return Effect.gen(function* () {
    const { core, recordHash, signatures, votes } =
      yield* certificationEvidence(fixture, action);
    const record = yield* Schema.decodeUnknown(CertifiedRecord)({
      sharnessVersion: WIRE_VERSION,
      kind: "certified_record",
      actionCertifiedRecord: {
        sharnessVersion: WIRE_VERSION,
        kind: "action_certified_record",
        recordHash,
        recordCore: core,
        routerAnchor: action.anchor,
        actionCertificate: {
          sharnessVersion: WIRE_VERSION,
          kind: "action_certificate",
          actionHash: core.actionHash,
          signatures,
        },
      },
      durabilityCertificate: {
        sharnessVersion: WIRE_VERSION,
        kind: "durability_certificate",
        recordHash,
        votes,
      },
    });
    return record;
  });
}

function allGatherInput(deadline: number) {
  return {
    to: Schema.decodeUnknownSync(MessageAddressInput)("group:alice,bob,carol"),
    text: "Choose a time",
    collective: {
      op: "all_gather" as const,
      deadline,
      requestedSchema: { type: "object" as const, properties: {} },
    },
  };
}

function certificationEvidence(
  fixture: Effect.Effect.Success<ReturnType<typeof attachingEndpoint>>,
  action: Extract<ActionCore, { kind: "FIRST_MESSAGE" }>,
) {
  return Effect.gen(function* () {
    const core: RecordCore = {
      sharnessVersion: WIRE_VERSION,
      kind: "record_core",
      membership: action.membership,
      anchorHash: yield* hashAnchor(action.anchor),
      action,
      actionHash: yield* hashAction(action),
    };
    const recordHash = yield* hashRecord(core);
    const membership = yield* verifyMembershipDescriptor(
      action.membership,
      fixture.subject.signer,
    );
    const signers = [
      fixture.subject.local,
      fixture.subject.remote,
      fixture.subject.third,
    ];
    const signatures = yield* Effect.forEach(
      signers,
      (signer) =>
        signEvidence(signer, {
          sharnessVersion: WIRE_VERSION,
          kind: "action_signature",
          signerAgentId: signer.card.agentId,
          actionHash: core.actionHash,
        }),
      { concurrency: 1 },
    );
    const votes = yield* Effect.forEach(
      signers,
      (signer) =>
        signEvidence(signer, {
          sharnessVersion: WIRE_VERSION,
          kind: "durability_vote",
          signerAgentId: signer.card.agentId,
          conversationId: action.conversationId,
          membershipHash: membership.hash,
          recordHash,
        }),
      { concurrency: 1 },
    );
    return { core, recordHash, signatures, votes };
  });
}

function pauseUnrelatedBinds(
  store: EndpointStore,
  pause: Effect.Effect<unknown>,
): EndpointStore {
  return {
    ...store,
    bindPostIntent: (binding) =>
      (binding.collective === undefined ? pause : Effect.void).pipe(
        Effect.zipRight(store.bindPostIntent(binding)),
      ),
  };
}
