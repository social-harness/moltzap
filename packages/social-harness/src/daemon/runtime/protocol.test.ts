/** @file A daemon ignores a peer's outer body that does not open for it, and its Router worker keeps accepting sealed traffic. */

import { scopedLive as it } from "@effect/vitest";
import {
  type Context,
  Deferred,
  Effect,
  Queue,
  Ref,
  Schema,
  Scope,
} from "effect";
import { describe, expect } from "vitest";
import type { SigningIdentity } from "../../__tests__/certified-history-fixtures.js";
import type { EndpointEngine } from "../../communication/conversations/index.js";
import type { Router } from "../../communication/router/api/client.js";
import type { VerifiedAgentCard } from "../../identity/cards.js";
import type { DaemonRuntimeError } from "../errors.js";
import { digest, identifier } from "../../__tests__/agent-card-fixtures.js";
import { makeFixture } from "../../__tests__/daemon-runtime-fixtures.js";
import { makeStore } from "../../__tests__/daemon-runtime-harness.js";
import {
  batch,
  emptyBatch,
  makeIdentityFixture,
  pollCursor,
  registryLayer,
  routerInstanceId,
} from "../../__tests__/router-worker-fixtures.js";
import {
  type CatchUpRequest,
  ConversationId,
  type DecodedOuterBody,
  DirectPacket,
  MembershipHash,
  signOuterPacket,
} from "../../communication/records/index.js";
import {
  makeRouterWorker,
  type RouterWorker,
} from "../../communication/router/index.js";
import { encodeCanonical } from "../../encoding/canonical-json.js";
import { SealedBody } from "../../identity/envelope/sealed-body.js";
import {
  type LiveSignedMessage,
  MessageId,
  SignedMessage,
} from "../../identity/envelope/signed-message.js";
import { Registry } from "../../identity/registry/index.js";
import { WIRE_VERSION } from "../../identity/wire-version.js";
import { acquireProtocol } from "./protocol.js";

/** The daemon's identity, the peer it shares a conversation with, and an agent outside it. */
interface Members {
  readonly local: SigningIdentity;
  readonly peer: SigningIdentity;
  readonly outsider: SigningIdentity;
}

/**
 * An envelope addressed to the daemon and the peer that the daemon must not
 * open: the peer seals the plaintext to `sealedTo` under MessageId byte
 * `sealedAs`, or leaves it plaintext when `sealedTo` is absent, and `signer`
 * signs the result under MessageId byte `signedAs`.
 */
interface RefusedEnvelope {
  readonly sealedTo?: (members: Members) => readonly VerifiedAgentCard[];
  readonly sealedAs: number;
  readonly signer: (members: Members) => SigningIdentity;
  readonly signedAs: number;
}

const instance = routerInstanceId(21);

const messageId = (byte: number) =>
  Schema.decodeUnknownSync(MessageId)(identifier("msg_", byte));

const catchUpRequestFrom = (requester: VerifiedAgentCard): CatchUpRequest => ({
  sharnessVersion: WIRE_VERSION,
  kind: "catch_up_request",
  conversationId: Schema.decodeUnknownSync(ConversationId)(digest("cnv_", 22)),
  membershipHash: Schema.decodeUnknownSync(MembershipHash)(digest("mbr_", 23)),
  requesterAgentId: requester.agentId,
  knownRecordHash: null,
  knownAnchorHash: null,
});

const buildRefusedEnvelope = (
  refused: RefusedEnvelope,
  members: Members,
  plaintext: Uint8Array,
) => {
  const signer = refused.signer(members);
  const body =
    refused.sealedTo === undefined
      ? Effect.succeed(plaintext)
      : SealedBody.seal({
          senderAgentId: members.peer.card.agentId,
          recipientAgentCards: refused.sealedTo(members),
          messageId: messageId(refused.sealedAs),
          plaintext,
        });
  return body.pipe(
    Effect.flatMap((sealed) =>
      SignedMessage.sign({
        agentCard: signer.card,
        signingAuthority: signer.authority,
        recipientAgentIds: new Set([
          members.local.card.agentId,
          members.peer.card.agentId,
        ]),
        messageId: messageId(refused.signedAs),
        body: sealed,
      }),
    ),
  );
};

const memberOf = (byte: number, name: string): Effect.Effect<SigningIdentity> =>
  makeIdentityFixture(byte, name).pipe(
    Effect.map((fixture) => ({
      card: fixture.localCard,
      authority: fixture.localAuthority,
    })),
  );

/**
 * A Router whose tail probe answers at once and whose cursor polls wait for
 * `released`. The first released poll carries `feed`; every later poll
 * signals `polledAgain` and stays open, as a held long poll does.
 */
const routerFeeding = (input: {
  readonly feed: readonly LiveSignedMessage[];
  readonly released: Deferred.Deferred<undefined>;
  readonly polledAgain: Deferred.Deferred<undefined>;
  readonly fed: Ref.Ref<boolean>;
}): Context.Tag.Service<typeof Router> => ({
  poll: (call) =>
    call.request.pollCursor === undefined
      ? Effect.succeed(emptyBatch(instance, pollCursor(24)))
      : Deferred.await(input.released).pipe(
          Effect.zipRight(Ref.getAndSet(input.fed, true)),
          Effect.flatMap((alreadyFed) =>
            alreadyFed
              ? Deferred.succeed(input.polledAgain, undefined).pipe(
                  Effect.zipRight(Effect.never),
                )
              : Effect.succeed(batch(instance, pollCursor(25), input.feed)),
          ),
        ),
  send: () => Effect.dieMessage("the daemon sends nothing in this test"),
});

/** An engine that records every payload its Router worker hands it. */
const recordingEngine = (
  accepted: Queue.Queue<DecodedOuterBody>,
): EndpointEngine => ({
  observePost: () =>
    Effect.dieMessage("no retained post is observed in this test"),
  send: () => Effect.dieMessage("the daemon sends nothing in this test"),
  bindChecked: () => Effect.dieMessage("the daemon sends nothing in this test"),
  sendAdmitted: () =>
    Effect.dieMessage("the daemon sends nothing in this test"),
  resolveAddress: () => Effect.dieMessage("no address is resolved here"),
  resolveConversation: () => Effect.dieMessage("no address is resolved here"),
  readPendingMessages: () => Effect.succeed([]),
  acknowledgeMessage: () => Effect.dieMessage("nothing is delivered here"),
  acceptRouterIngress: (ingress) =>
    Queue.offer(accepted, ingress.payload).pipe(Effect.as("accepted" as const)),
  recoverCertifiedHistory: () => Effect.void,
  drainOutbound: Effect.void,
  runOutbound: Effect.never,
  abandonVolatileFolds: () => Effect.void,
  rearmCatchUp: Effect.void,
});

/** What a running daemon protocol exposes to the test that started it. */
interface RunningProtocol {
  readonly worker: RouterWorker;
  readonly accepted: Queue.Queue<DecodedOuterBody>;
  readonly fatal: Deferred.Deferred<never, DaemonRuntimeError>;
}

/**
 * Acquire the daemon's protocol over a real Router worker, a Router that
 * carries `feed` once `released` resolves and signals `polledAgain` on the
 * poll after it, and an engine that records every payload it accepts.
 */
const runProtocol = (input: {
  readonly fixture: Effect.Effect.Success<typeof makeFixture>;
  readonly members: Members;
  readonly feed: readonly LiveSignedMessage[];
  readonly released: Deferred.Deferred<undefined>;
  readonly polledAgain: Deferred.Deferred<undefined>;
}): Effect.Effect<RunningProtocol, unknown, Scope.Scope> =>
  Effect.gen(function* () {
    const workerReady = yield* Deferred.make<RouterWorker>();
    const accepted = yield* Queue.unbounded<DecodedOuterBody>();
    const fatal = yield* Deferred.make<never, DaemonRuntimeError>();
    yield* acquireProtocol(
      {
        store: makeStore(input.fixture, true),
        bootstrap: input.fixture.bootstrap,
        edges: {
          makeWorker: (workerInput) =>
            makeRouterWorker(workerInput).pipe(
              Effect.tap((worker) => Deferred.succeed(workerReady, worker)),
            ),
          makeEngine: () => Effect.succeed(recordingEngine(accepted)),
        },
        registry: yield* Effect.provide(
          Registry,
          registryLayer([
            input.members.local.card,
            input.members.peer.card,
            input.members.outsider.card,
          ]),
        ),
        router: routerFeeding({
          feed: input.feed,
          released: input.released,
          polledAgain: input.polledAgain,
          fed: yield* Ref.make(false),
        }),
        daemonScope: yield* Scope.Scope,
        fatal,
      },
      {
        retain: () => undefined,
        publishPending: Effect.void,
        emit: () => Effect.void,
      },
      input.fixture.localCard,
    );
    return { worker: yield* Deferred.await(workerReady), accepted, fatal };
  });

const ignoresRefusedBodyAndKeepsRunning = (refused: RefusedEnvelope) =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    const members: Members = {
      local: {
        card: fixture.localCard,
        authority: fixture.bootstrap.signingAuthority,
      },
      peer: yield* memberOf(2, "sealed-peer"),
      outsider: yield* memberOf(3, "sealed-outsider"),
    };
    const packet = catchUpRequestFrom(members.peer.card);
    const plaintext = yield* encodeCanonical(DirectPacket, packet);
    const sealed = yield* signOuterPacket({
      packet,
      membership: { members: [members.local.card, members.peer.card] },
      agentCard: members.peer.card,
      signingAuthority: members.peer.authority,
    });
    const released = yield* Deferred.make<undefined>();
    const polledAgain = yield* Deferred.make<undefined>();
    const running = yield* runProtocol({
      fixture,
      members,
      feed: [yield* buildRefusedEnvelope(refused, members, plaintext), sealed],
      released,
      polledAgain,
    });

    yield* running.worker.awaitAnchor;
    yield* Deferred.succeed(released, undefined);
    yield* Deferred.await(polledAgain).pipe(Effect.timeout("5 seconds"));

    expect(Array.from(yield* Queue.takeAll(running.accepted))).toStrictEqual([
      { kind: "direct", packet },
    ]);
    expect(yield* Deferred.isDone(running.fatal)).toBe(false);
  });

describe("daemon ingress of outer bodies", () => {
  it.each<{ readonly body: string; readonly refused: RefusedEnvelope }>([
    {
      body: "a plaintext body",
      refused: { sealedAs: 31, signer: ({ peer }) => peer, signedAs: 31 },
    },
    {
      body: "a body sealed to other recipients",
      refused: {
        sealedTo: ({ peer, outsider }) => [peer.card, outsider.card],
        sealedAs: 32,
        signer: ({ peer }) => peer,
        signedAs: 32,
      },
    },
    {
      body: "a sealed body re-signed by another sender",
      refused: {
        sealedTo: ({ local, peer }) => [local.card, peer.card],
        sealedAs: 33,
        signer: ({ outsider }) => outsider,
        signedAs: 33,
      },
    },
    {
      body: "a sealed body re-signed under another MessageId",
      refused: {
        sealedTo: ({ local, peer }) => [local.card, peer.card],
        sealedAs: 34,
        signer: ({ peer }) => peer,
        signedAs: 35,
      },
    },
  ])("ignores $body and goes on accepting sealed traffic", ({ refused }) =>
    ignoresRefusedBodyAndKeepsRunning(refused),
  );
});
