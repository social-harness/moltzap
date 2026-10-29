/** @file Real signed records and reopened stores support collective recovery tests. */
import { Deferred, Effect, Schema } from "effect";
import { expect } from "vitest";
import type { InboundItem } from "../communication/collectives/inbound.js";
import type { CollectivePorts } from "../communication/collectives/ports.js";
import type { Fixture } from "./firewall-runtime-fixtures.js";
import {
  type EndpointEngine,
  makeEndpointEngine,
} from "../communication/conversations/index.js";
import {
  type CertifiedRecord,
  deriveConversationId,
  MembershipDescriptor,
  PostIntent,
  signOuterPacket,
  verifyMembershipDescriptor,
} from "../communication/records/index.js";
import { RouterInstanceId } from "../communication/router/api/contract.js";
import {
  decodeRuntimeValue,
  encodeRuntimeValue,
  type EndpointStore,
  EndpointStoreError,
} from "../communication/store/index.js";
import { AgentCard } from "../identity/cards.js";
import { WIRE_VERSION } from "../identity/wire-version.js";
import { untilLive } from "./advance-clock.js";
import { identifier } from "./agent-card-fixtures.js";
import {
  buildCertifiedFirstMessage,
  buildCertifiedPost,
  signEvidence,
  storeCertifiedFirstMessage,
} from "./certified-history-fixtures.js";
import { pollCursor } from "./router-worker-fixtures.js";
import { withStore } from "./store-schema-fixtures.js";
/** A fixed anchor keeps records verifiable after each fixture restart. */
export const anchor = {
  routerInstanceId: Schema.decodeUnknownSync(RouterInstanceId)(
    identifier("rti_", 33),
  ),
  pollCursor: pollCursor(34),
};
/** Uses the same verified peer cards and Router anchor when reopening a real store. */
export function resumeEngine(
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
  }).pipe(Effect.withSpan("resumeEngine"));
}

/** Adds the third verified member needed for a group conversation. */
export function groupSubject(subject: Fixture) {
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
  }).pipe(Effect.withSpan("groupSubject"));
}

/** Seeds a signed group head before the test binds its first operation. */
export function seedGroupFirstMessage(subject: Fixture) {
  return withStore(subject.directory, (store) =>
    Effect.gen(function* () {
      const partial = yield* buildCertifiedFirstMessage(
        subject.local,
        subject.remote,
        subject.membership,
        anchor.routerInstanceId,
      );
      const record = yield* completeGroupCertificate(subject, partial);
      yield* storeCertifiedFirstMessage(
        store,
        subject.local.card,
        subject.membership,
        record,
      );
      return record;
    }),
  ).pipe(Effect.withSpan("seedGroupFirstMessage"));
}

/** Reads the exact durable intent that the resumed endpoint must continue. */
export function boundIntent(
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

/** Completes the retained intent with real member signatures and delivers its certificate. */
export function certifyBoundIntent(
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

/** Waits until the requester has durably bound its close post. */
export function waitForClose(store: EndpointStore) {
  return untilLive(
    store.readCollectivePosts().pipe(
      Effect.map((posts) => posts.some((post) => post.role === "close")),
      Effect.orDie,
    ),
  );
}

/** Publishes a terminal result with the operation’s retained delivery identity. */
export function retainingEmitter(
  store: EndpointStore,
  emitted: Deferred.Deferred<InboundItem>,
): CollectivePorts["emit"] {
  return (item, ...[, terminal]) =>
    Effect.gen(function* () {
      if (terminal === undefined || item.kind !== "collectiveResult") {
        return yield* Effect.dieMessage(
          "expected one retained collective result",
        );
      }
      yield* store.publishCollectiveItem({
        ...terminal,
        canonicalItem: yield* encodeRuntimeValue(item),
        conversation: item.to,
        firewall: false,
      });
      yield* Deferred.succeed(emitted, item);
    }).pipe(Effect.orDie, Effect.withSpan("retainingEmitter"));
}

/** Verifies a signed peer packet through the engine’s ingress boundary. */
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
