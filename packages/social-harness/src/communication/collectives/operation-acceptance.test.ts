/** @file Plain sends distinguish Router attachment from ownership of a bound collective message. */

import { SqlClient } from "@effect/sql";

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
import {
  identifier,
  testAgentView,
} from "../../__tests__/agent-card-fixtures.js";
import { signEvidence } from "../../__tests__/certified-history-fixtures.js";
import { makeCollectiveOperations } from "../../__tests__/collective-send.js";
import { engineFixture } from "../../__tests__/firewall-runtime-fixtures.js";
import { pollCursor } from "../../__tests__/router-worker-fixtures.js";
import { makeHostDelivery } from "../../daemon/inbox/host-delivery.js";
import { WIRE_VERSION } from "../../identity/wire-version.js";
import { makeEndpointEngine } from "../conversations/index.js";
import {
  ActionCore,
  CertifiedRecord,
  hashAction,
  hashAnchor,
  hashMessageIntent,
  hashRecord,
  InitialAnchorBody,
  MembershipDescriptor,
  MessageAddressInput,
  MessageIntent,
  type RecordCore,
  signOuterPacket,
  verifyMembershipDescriptor,
} from "../records/index.js";
import { RouterInstanceId } from "../router/api/contract.js";
import { RouterWorkerUnavailableError } from "../router/index.js";
import { decodeRuntimeValue } from "../store/index.js";

it("waits for Router attachment before reporting a bound all-gather as pending", () =>
  Effect.gen(function* () {
    const fixture = yield* attachingEndpoint();
    const sending = yield* fixture.send(60).pipe(Effect.fork);
    yield* Deferred.await(fixture.attaching);
    yield* TestClock.adjust("20 seconds");

    expect(Option.isNone(yield* Fiber.poll(sending))).toBe(true);
    expect(
      yield* fixture.run(fixture.store.readCollectiveOperations()),
    ).toEqual([]);
    expect(yield* fixture.run(fixture.store.readCollectiveMessages())).toEqual(
      [],
    );

    yield* Deferred.succeed(fixture.attached, undefined);
    expect(yield* Effect.flip(Fiber.join(sending))).toMatchObject({
      reason: "delivery-pending",
    });
    const operations = yield* fixture.run(
      fixture.store.readCollectiveOperations(),
    );
    const messages = yield* fixture.run(fixture.store.readCollectiveMessages());
    expect(operations).toHaveLength(1);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      operationId: operations[0]?.operationId,
      role: "request",
    });
    const certified = yield* certifyPendingRequest(fixture);
    expect(yield* fixture.engine.observeMessage(certified.msgId)).toEqual(
      certified,
    );
    expect(
      (yield* fixture.run(fixture.store.readCollectiveMessages())).map(
        (message) => message.intent.msgId,
      ),
    ).toEqual([certified.msgId]);
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
    expect(
      yield* fixture.run(fixture.store.readCollectiveOperations()),
    ).toEqual([]);
    expect(yield* fixture.run(fixture.store.readCollectiveMessages())).toEqual(
      [],
    );
  }));

function attachingEndpoint() {
  return Effect.gen(function* () {
    const subject = yield* engineFixture();
    const attaching = yield* Deferred.make<undefined>();
    const attached = yield* Deferred.make<undefined>();
    const { engine, anchor } = yield* attachingEngine(
      subject,
      attaching,
      attached,
    );
    const scope = yield* Scope.Scope;
    const collectives = yield* makeCollectiveOperations({
      self: testAgentView("agent:alice"),
      sendMessage: engine.send,
      prepareMessage: engine.prepare,
      acceptMessage: engine.accept,
      observeMessage: engine.observeMessage,
      reportStorageFault: () => Effect.dieMessage("unexpected storage fault"),
      emit: () => Effect.void,
      scope,
    }).pipe(Effect.provideService(SqlClient.SqlClient, subject.sql));
    const delivery = yield* makeHostDelivery({
      collectives: () => collectives,
      scope,
      historyExport: { record: () => Effect.void },
    }).pipe(Effect.provideService(SqlClient.SqlClient, subject.sql));
    return {
      store: subject.store,
      run: subject.run,
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
    }).pipe(Effect.provideService(SqlClient.SqlClient, subject.sql));
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
      msgId: action.messageIntent.msgId,
      recordHash: record.actionCertifiedRecord.recordHash,
    };
  });
}

function pendingAction(
  fixture: Effect.Effect.Success<ReturnType<typeof attachingEndpoint>>,
) {
  return Effect.gen(function* () {
    const recovery = yield* fixture.run(fixture.store.recover());
    const bound = yield* Effect.fromNullable(recovery.messageIntents[0]);
    const storedMembership = yield* Effect.fromNullable(
      recovery.memberships[0],
    );
    const storedAnchor = yield* Effect.fromNullable(recovery.anchors[0]);
    const intent = yield* decodeRuntimeValue(
      MessageIntent,
      bound.canonicalIntent,
    );
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
      messageIntent: intent,
      messageIntentHash: yield* hashMessageIntent(intent),
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
