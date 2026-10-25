/** @file Exact preflight, proposal-lock, certification, and delivery tests. */

import { live as it } from "@effect/vitest";
import { Effect } from "effect";
// eslint-disable-next-line agent-code-guard/prefer-effect-platform -- Tests create and inspect exact real-SQLite permission fixtures around the scoped Effect resource.
import { readFileSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect } from "vitest";
import {
  bytes,
  databasePath,
  stateDirectory,
  withStore,
} from "../../__tests__/store-schema-fixtures.js";
import { LIVE_WIRE_VERSIONS, WIRE_VERSION } from "../../identity/wire-version.js";
import {
  type CertifiedRecord,
  type ConversationFoundation,
  type DisseminationObligation,
  type EmptyConversationRestart,
  type EndpointRecovery,
  type EndpointStore,
  EndpointStoreError,
  type InboundDeliveryInput,
  openEndpointStore,
  type OutboundMessageInput,
  type PostIntent,
  type ProposalLock,
  type ProtocolEvidence,
  type RestartedEmptyConversation,
  type StagedReanchor,
  type StagedRecord,
  type StoredOutboundMessage,
  type StoreMutation,
} from "./index.js";

const DATABASE_FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const EXISTING_MUTATION: StoreMutation = "existing";
const INSERTED_MUTATION: StoreMutation = "inserted";
const LOCAL_AGENT_ID = "agent:local";

function initializesEmptyDatabase() {
  const directory = stateDirectory();
  const initialize = withStore(directory, (store) =>
    store.recover().pipe(
      Effect.tap((recovery) => {
        expect(recovery.certifiedRecords).toEqual([]);
        return Effect.void;
      }),
    ),
  );
  return initialize.pipe(
    Effect.zipRight(withStore(directory, (store) => store.recover())),
    Effect.tap(() =>
      Effect.sync(() => {
        assertInitializedDatabase(directory);
      }),
    ),
  );
}

function rejectsNonemptyDatabaseWithoutInitialization() {
  const directory = stateDirectory();
  const path = databasePath(directory);
  const database = new DatabaseSync(path);
  database.exec("CREATE TABLE unexpected_state (value TEXT) STRICT");
  database.close();
  const original = readFileSync(path);

  return expectReason(
    Effect.scoped(
      openEndpointStore(directory, { liveWireVersions: LIVE_WIRE_VERSIONS }),
    ).pipe(
      Effect.catchTag("OutboxTooOldError", () =>
        Effect.dieMessage("unexpected pending outbox"),
      ),
    ),
    "pre-reset",
  ).pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        expect(readFileSync(path)).toEqual(original);
      }),
    ),
  );
}

function retainsFirstProposalAcrossRestart() {
  const directory = stateDirectory();
  const conversationId = "conversation:lock";
  const first = proposal(conversationId, `ach_${conversationId}:0`);
  return withStore(directory, (store) =>
    Effect.gen(function* () {
      yield* bindLocalIdentity(store);
      yield* store.putConversationFoundation(foundation(conversationId));
      const localSignature = localActionEvidence(
        conversationId,
        first.actionHash,
      );
      yield* expectReason(store.mergeEvidence(localSignature), "not-found");
      expect(yield* store.lockProposal(first)).toBe(INSERTED_MUTATION);
      expect(yield* store.mergeEvidence(localSignature)).toBe(
        INSERTED_MUTATION,
      );
      expect(yield* store.lockProposal(first)).toBe(EXISTING_MUTATION);
      yield* expectReason(
        store.lockProposal(proposal(conversationId, "ach_competing")),
        "conflict",
      );
    }),
  ).pipe(
    Effect.zipRight(
      withStore(directory, (store) =>
        store.recover().pipe(
          Effect.tap((recovery) => {
            expect(recovery.proposalLocks).toEqual([first]);
            return Effect.void;
          }),
        ),
      ),
    ),
  );
}

/**
 * Replaces a lock held on one action with the lock on an action whose
 * certificate the endpoint verified, together with that certificate. A
 * certificate for another action is refused and leaves the held lock in
 * place; after the replacement, a reopened store holds the new lock with its
 * certificate and none of the released action's evidence.
 * @returns Completion once the reopened store is checked.
 */
function supersedesAConflictingLockWithItsCertificate() {
  const directory = stateDirectory();
  const conversationId = "conversation:supersede";
  const held = proposal(conversationId, "ach_held");
  const certified = proposal(conversationId, "ach_certified");
  const certificate = actionCertificate(conversationId, certified.actionHash);
  return withStore(directory, (store) =>
    Effect.gen(function* () {
      yield* bindLocalIdentity(store);
      yield* store.putConversationFoundation(foundation(conversationId));
      yield* store.lockProposal(held);
      yield* store.mergeEvidence(
        localActionEvidence(conversationId, held.actionHash),
      );
      yield* expectReason(
        store.supersedeProposalLock(certified, [
          ...certificate.slice(1),
          localActionEvidence(conversationId, held.actionHash),
        ]),
        "invalid-input",
      );
      expect((yield* store.recover()).proposalLocks).toEqual([held]);
      expect(yield* store.supersedeProposalLock(certified, certificate)).toBe(
        INSERTED_MUTATION,
      );
    }),
  ).pipe(
    Effect.zipRight(
      withStore(directory, (store) =>
        store.recover().pipe(
          Effect.tap((recovery) => {
            expect(recovery.proposalLocks).toEqual([certified]);
            expect(recovery.evidence).toEqual(certificate);
            return Effect.void;
          }),
        ),
      ),
    ),
  );
}

function atomicallyBindsFirstIntentWithItsFoundation() {
  const directory = stateDirectory();
  const firstConversationId = "conversation:intent:first";
  const competingConversationId = "conversation:intent:competing";
  const firstIntent = postIntent(firstConversationId, "pst_atomic");
  const competingIntent = postIntent(competingConversationId, "pst_atomic");
  return withStore(directory, (store) =>
    Effect.gen(function* () {
      yield* bindLocalIdentity(store);
      expect(
        yield* store.bindPostIntent({
          kind: "new-conversation",
          foundation: foundation(firstConversationId),
          intent: firstIntent,
        }),
      ).toBe(INSERTED_MUTATION);
      expect(
        yield* store.bindPostIntent({
          kind: "new-conversation",
          foundation: foundation(firstConversationId),
          intent: firstIntent,
        }),
      ).toBe(EXISTING_MUTATION);
      yield* expectReason(
        store.bindPostIntent({
          kind: "new-conversation",
          foundation: foundation(competingConversationId),
          intent: competingIntent,
        }),
        "conflict",
      );
      const recovery = yield* store.recover();
      expect(recovery.postIntents).toEqual([firstIntent]);
      expect(recovery.memberships.map((item) => item.conversationId)).toEqual([
        firstConversationId,
      ]);
    }),
  );
}

function atomicallyLocksVerifiedGenesisFoundation() {
  const directory = stateDirectory();
  const conversationId = "conversation:genesis-lock";
  const retainedFoundation = foundation(conversationId);
  const first = proposal(conversationId, "ach_genesis:first");
  return withStore(directory, (store) =>
    Effect.gen(function* () {
      expect(yield* store.lockGenesisProposal(retainedFoundation, first)).toBe(
        INSERTED_MUTATION,
      );
      expect(yield* store.lockGenesisProposal(retainedFoundation, first)).toBe(
        EXISTING_MUTATION,
      );
      yield* expectReason(
        store.lockGenesisProposal(
          retainedFoundation,
          proposal(conversationId, "ach_genesis:competing"),
        ),
        "conflict",
      );
      const recovery = yield* store.recover();
      expect(recovery.memberships).toHaveLength(1);
      expect(recovery.anchors).toHaveLength(1);
      expect(recovery.proposalLocks).toEqual([first]);
    }),
  );
}

function promotesRemoteRecordWithStableDelivery() {
  const directory = stateDirectory();
  const conversationId = "conversation:remote";
  const record = certifiedRecord(conversationId, "agent:remote");
  const delivery: InboundDeliveryInput = {
    recipientAgentId: LOCAL_AGENT_ID,
    canonicalMessage: bytes("message:remote"),
  };
  return withStore(directory, (store) =>
    writeRemoteDelivery(store, record, delivery),
  ).pipe(
    Effect.flatMap((retainedToken) =>
      withStore(directory, (store) =>
        verifyRemoteDeliveryRecovery(store, record, retainedToken),
      ),
    ),
  );
}

function rollsBackRemoteRecordWithoutDelivery() {
  const directory = stateDirectory();
  const conversationId = "conversation:atomic";
  const record = certifiedRecord(conversationId, "agent:remote");
  return withStore(directory, (store) =>
    Effect.gen(function* () {
      yield* bindLocalIdentity(store);
      yield* store.putConversationFoundation(foundation(conversationId));
      yield* expectReason(store.applyCertifiedRecord(record), "invalid-input");
      const recovery = yield* store.recover();
      expect(recovery.positions[0]?.headRecordHash).toBeUndefined();
      expect(recovery.stagedRecords).toEqual([]);
      expect(recovery.certifiedRecords).toEqual([]);
      expect(recovery.evidence).toEqual([]);
      expect(recovery.pendingDeliveries).toEqual([]);
    }),
  );
}

/**
 * The endpoint stages its own post for its vote and stores that vote, then
 * receives the post whole, with its own vote in the durability certificate.
 * The store applies it over the staged record and the stored vote, completes
 * the local post intent and retains no delivery to this endpoint itself.
 * Fails when applying a whole record refuses a vote of this endpoint's own
 * that it already holds, or delivers a local post to its author.
 * @returns The trace, run to completion.
 */
function completesLocalPostWithoutSelfDelivery() {
  const directory = stateDirectory();
  const conversationId = "conversation:local";
  const record = certifiedRecord(conversationId, LOCAL_AGENT_ID);
  return withStore(directory, (store) =>
    Effect.gen(function* () {
      yield* lockLocalPost(store, record);
      yield* store.stageRecordForDissemination(stagedRecord(record));
      yield* Effect.forEach(
        record.durabilityEvidence,
        (vote) => store.mergeEvidence(vote),
        { concurrency: 1, discard: true },
      );
      yield* store.applyCertifiedRecord(record);
      const recovery = yield* store.recover();
      expect(recovery.postIntents[0]?.completedRecordHash).toBe(
        record.recordHash,
      );
      expect(recovery.pendingDeliveries).toEqual([]);
    }),
  );
}

/**
 * The endpoint holds a certified head and a staged successor of it that it
 * voted durable. The store refuses a re-anchor candidate away from that head
 * under the same anchor, so this endpoint's signatures never land on both a
 * re-anchor away from the head and a durability certificate extending it,
 * whatever order recovery and ingress reach the store in. Fails when the
 * store stages that candidate.
 * @returns The trace, run to completion.
 */
function refusesAReanchorAwayFromAStagedSuccessor() {
  const directory = stateDirectory();
  const conversationId = "conversation:staged-successor";
  const head = certifiedRecord(conversationId, LOCAL_AGENT_ID);
  const successor = stagedRecord(
    certifiedRecord(conversationId, LOCAL_AGENT_ID, 1),
  );
  return withStore(directory, (store) =>
    Effect.gen(function* () {
      yield* lockLocalPost(store, head);
      yield* store.applyCertifiedRecord(head);
      yield* store.stageRecordForDissemination(successor);

      yield* expectReason(
        store.stageReanchor(reanchorAwayFrom(head)),
        "conflict",
      );
      expect((yield* store.recover()).stagedReanchors).toEqual([]);
    }),
  );
}

/**
 * The endpoint locks a successor of its certified head, then stages a
 * re-anchor candidate away from the head's anchor, and then receives the
 * successor whole, which it stores without voting for it. The store refuses
 * this endpoint's durability vote for the successor, whether a whole record's
 * durability certificate carries it or the endpoint casts it, so its
 * signatures never land on both a re-anchor away from the head and a
 * durability certificate extending it, in this order as in the other. Fails
 * when the store checks only the proposal lock before it keeps the vote, or
 * checks the re-anchor only for a vote the endpoint casts.
 * Value: protects=no local vote is kept under an anchor this endpoint
 *     re-anchors away from; fails_when=the re-anchor check covers mergeEvidence
 *     but not a whole record's certificate; why_new=no other test stores a
 *     whole record carrying this endpoint's vote under such an anchor;
 *     seam=none.
 * @returns The trace, run to completion.
 */
function refusesALocalVoteUnderAnAnchorItReanchorsAwayFrom() {
  const directory = stateDirectory();
  const conversationId = "conversation:reanchored-vote";
  const head = certifiedRecord(conversationId, LOCAL_AGENT_ID);
  const successor = certifiedRecord(conversationId, "agent:remote", 1);
  const localVote: ProtocolEvidence = {
    conversationId,
    kind: "durability",
    subjectId: successor.recordHash,
    evidenceKey: LOCAL_AGENT_ID,
    canonicalEvidence: bytes("durability-vote:local"),
  };
  const delivery: InboundDeliveryInput = {
    recipientAgentId: LOCAL_AGENT_ID,
    canonicalMessage: bytes("message:successor"),
  };
  return withStore(directory, (store) =>
    Effect.gen(function* () {
      yield* lockLocalPost(store, head);
      yield* store.applyCertifiedRecord(head);
      yield* store.lockProposal({
        ...proposal(conversationId, successor.actionHash),
        previousRecordHash: head.recordHash,
      });
      yield* store.stageReanchor(reanchorAwayFrom(head));
      yield* expectReason(
        store.applyCertifiedRecord(
          {
            ...successor,
            durabilityEvidence: [...successor.durabilityEvidence, localVote],
          },
          delivery,
        ),
        "conflict",
      );
      yield* store.applyCertifiedRecord(successor, delivery);

      yield* expectReason(store.mergeEvidence(localVote), "conflict");
      expect((yield* store.recover()).evidence).not.toContainEqual(localVote);
    }),
  );
}

interface OutboundLifecycleFixture {
  readonly directory: string;
  readonly message: OutboundMessageInput;
}

function persistsExactOutboundLifecycleAcrossRestart() {
  const fixture: OutboundLifecycleFixture = {
    directory: stateDirectory(),
    message: outboundMessage("conversation:outbound", "msg_outbound", "outer"),
  };
  return stageInitialOutbound(fixture).pipe(
    Effect.zipRight(completeRetriedOutbound(fixture)),
    Effect.zipRight(verifyOutboundComplete(fixture.directory)),
  );
}

function stageInitialOutbound(fixture: OutboundLifecycleFixture) {
  return withStore(fixture.directory, (store) =>
    Effect.gen(function* () {
      yield* store.putConversationFoundation(
        foundation(fixture.message.conversationId),
      );
      const staged = yield* store.enqueueOutbound(fixture.message);
      expect(staged.messageId).toBe(fixture.message.messageId);
      expect(yield* store.beginOutbound(staged.messageId)).toEqual({
        kind: "pending",
        mode: "initial",
        outbound: staged,
      });
    }),
  );
}

function completeRetriedOutbound(fixture: OutboundLifecycleFixture) {
  return withStore(fixture.directory, (store) =>
    Effect.gen(function* () {
      const replay = yield* recoverOnlyOutbound(store);
      expect(replay).toEqual({
        ...fixture.message,
      });
      expect(yield* store.beginOutbound(replay.messageId)).toEqual({
        kind: "pending",
        mode: "retry",
        outbound: replay,
      });
      expect(yield* store.completeOutbound(replay)).toBe(INSERTED_MUTATION);
      expect(yield* store.completeOutbound(replay)).toBe(EXISTING_MUTATION);
    }),
  );
}

function verifyOutboundComplete(directory: string) {
  return withStore(directory, (store) =>
    store.recover().pipe(
      Effect.tap((recovery) => {
        expect(recovery.outboundMessages).toEqual([]);
        return Effect.void;
      }),
    ),
  );
}

function recoverOnlyOutbound(
  store: EndpointStore,
): Effect.Effect<StoredOutboundMessage, EndpointStoreError> {
  return store.recover().pipe(
    Effect.flatMap((recovery) => {
      const outbound = recovery.outboundMessages[0];
      return outbound === undefined
        ? Effect.die("pending outbound was not recovered")
        : Effect.succeed(outbound);
    }),
  );
}

interface DisseminationLifecycleFixture {
  readonly directory: string;
  readonly conversationId: string;
  readonly record: CertifiedRecord;
  readonly actionObligation: DisseminationObligation;
  readonly actionEnvelope: OutboundMessageInput;
}

function retainsRecordDisseminationAcrossCrashWindows() {
  const directory = stateDirectory();
  const conversationId = "conversation:dissemination";
  const record = certifiedRecord(conversationId, LOCAL_AGENT_ID);
  const fixture: DisseminationLifecycleFixture = {
    directory,
    conversationId,
    record,
    actionObligation: {
      conversationId: record.conversationId,
      recordHash: record.recordHash,
    },
    actionEnvelope: outboundMessage(
      conversationId,
      "msg_action_certified",
      "outer:action-certified",
    ),
  };
  return stageDisseminationObligation(fixture).pipe(
    Effect.zipRight(reconcileDisseminationCrashWindows(fixture)),
  );
}

function stageDisseminationObligation(fixture: DisseminationLifecycleFixture) {
  return withStore(fixture.directory, (store) =>
    Effect.gen(function* () {
      yield* lockLocalPost(store, fixture.record);
      yield* expectReason(
        store.enqueueDisseminationOutbound(
          fixture.actionObligation,
          fixture.actionEnvelope,
        ),
        "not-found",
      );
      expect((yield* store.recover()).outboundMessages).toEqual([]);
      expect(
        yield* store.stageRecordForDissemination(stagedRecord(fixture.record)),
      ).toBe(INSERTED_MUTATION);
      expect(
        yield* store.stageRecordForDissemination(stagedRecord(fixture.record)),
      ).toBe(EXISTING_MUTATION);
      expect((yield* store.recover()).disseminationObligations).toEqual([
        fixture.actionObligation,
      ]);
    }),
  );
}

function reconcileDisseminationCrashWindows(
  fixture: DisseminationLifecycleFixture,
) {
  return withStore(fixture.directory, (store) =>
    Effect.gen(function* () {
      const outbound = yield* store.enqueueDisseminationOutbound(
        fixture.actionObligation,
        fixture.actionEnvelope,
      );
      const attached = yield* store.recover();
      expect(attached.disseminationObligations).toEqual([]);
      expect(attached.outboundMessages).toEqual([outbound]);
      expect(yield* store.promoteRecord(fixture.record)).toBe(
        INSERTED_MUTATION,
      );
      expect((yield* store.recover()).disseminationObligations).toEqual([]);
      expect(yield* store.discardOutbound([outbound])).toBe(INSERTED_MUTATION);
      expect((yield* store.recover()).disseminationObligations).toEqual([
        fixture.actionObligation,
      ]);
    }),
  );
}

interface EmptyRestartFixture {
  readonly directory: string;
  readonly conversationId: string;
  readonly newFoundation: ConversationFoundation;
  readonly intent: PostIntent;
  readonly staged: StagedRecord;
  readonly lock: ProposalLock;
  readonly restart: EmptyConversationRestart;
}

function restartsOnlyAnEmptyConversationAtomically() {
  const directory = stateDirectory();
  const conversationId = "conversation:empty-restart";
  const oldFoundation = foundation(conversationId);
  const newFoundation: ConversationFoundation = {
    ...oldFoundation,
    anchorHash: `anc_${conversationId}:1`,
    canonicalAnchor: bytes(`anchor:${conversationId}:1`),
  };
  const intent = postIntent(conversationId, "pst_restart");
  const staged = stagedRecord(certifiedRecord(conversationId, LOCAL_AGENT_ID));
  const fixture: EmptyRestartFixture = {
    directory,
    conversationId,
    newFoundation,
    intent,
    staged,
    lock: proposal(conversationId, staged.actionHash),
    restart: {
      expectedFoundation: oldFoundation,
      replacementFoundation: newFoundation,
    },
  };
  return restartEmptyConversation(fixture);
}

function restartEmptyConversation(fixture: EmptyRestartFixture) {
  return withStore(fixture.directory, (store) =>
    prepareEmptyRestartState(store, fixture).pipe(
      Effect.zipRight(store.restartEmptyConversation(fixture.restart)),
      Effect.tap((restarted) =>
        Effect.sync(() => {
          assertRestartedEmptyConversation(restarted, fixture);
        }),
      ),
      Effect.zipRight(store.recover()),
      Effect.tap((recovery) =>
        Effect.sync(() => {
          assertEmptyRestartRecovery(recovery, fixture);
        }),
      ),
    ),
  );
}

function prepareEmptyRestartState(
  store: EndpointStore,
  fixture: EmptyRestartFixture,
) {
  return Effect.gen(function* () {
    yield* bindLocalIdentity(store);
    yield* store.bindPostIntent({
      kind: "new-conversation",
      foundation: fixture.restart.expectedFoundation,
      intent: fixture.intent,
    });
    yield* store.lockProposal(fixture.lock);
    yield* store.stageRecordForDissemination(fixture.staged);
    yield* store.mergeEvidence({
      conversationId: fixture.conversationId,
      kind: "action",
      subjectId: fixture.staged.actionHash,
      evidenceKey: LOCAL_AGENT_ID,
      canonicalEvidence: bytes("action:stale"),
    });
    yield* store.mergeEvidence({
      conversationId: fixture.conversationId,
      kind: "durability",
      subjectId: fixture.staged.recordHash,
      evidenceKey: LOCAL_AGENT_ID,
      canonicalEvidence: bytes("durability:stale"),
    });
    yield* store.enqueueOutbound(
      outboundMessage(fixture.conversationId, "msg_stale", "outer:stale"),
    );
  });
}

function assertRestartedEmptyConversation(
  restarted: RestartedEmptyConversation,
  fixture: EmptyRestartFixture,
): void {
  expect(restarted).toEqual({
    foundation: fixture.newFoundation,
    postIntents: [fixture.intent],
  });
}

function assertEmptyRestartRecovery(
  recovery: EndpointRecovery,
  fixture: EmptyRestartFixture,
): void {
  expect(recovery.anchors).toEqual([
    {
      conversationId: fixture.conversationId,
      anchorHash: fixture.newFoundation.anchorHash,
      canonicalAnchor: fixture.newFoundation.canonicalAnchor,
    },
  ]);
  expect(recovery.positions).toEqual([
    {
      conversationId: fixture.conversationId,
      membershipHash: fixture.newFoundation.membershipHash,
      currentAnchorHash: fixture.newFoundation.anchorHash,
    },
  ]);
  expect(recovery.postIntents).toEqual([fixture.intent]);
  expect(recovery.proposalLocks).toEqual([]);
  expect(recovery.stagedRecords).toEqual([]);
  expect(recovery.evidence).toEqual([]);
  expect(recovery.disseminationObligations).toEqual([]);
  expect(recovery.outboundMessages).toEqual([]);
}

function refusesEmptyRestartAfterCertification() {
  const directory = stateDirectory();
  const conversationId = "conversation:certified-restart";
  const oldFoundation = foundation(conversationId);
  const record = certifiedRecord(conversationId, LOCAL_AGENT_ID);
  const replacement: ConversationFoundation = {
    ...oldFoundation,
    anchorHash: `anc_${conversationId}:1`,
    canonicalAnchor: bytes(`anchor:${conversationId}:1`),
  };
  return withStore(directory, (store) =>
    Effect.gen(function* () {
      yield* lockLocalPost(store, record);
      yield* store.applyCertifiedRecord(record);
      yield* expectReason(
        store.restartEmptyConversation({
          expectedFoundation: oldFoundation,
          replacementFoundation: replacement,
        }),
        "conflict",
      );
      const recovery = yield* store.recover();
      expect(recovery.positions[0]?.headRecordHash).toBe(record.recordHash);
      expect(recovery.positions[0]?.currentAnchorHash).toBe(
        oldFoundation.anchorHash,
      );
    }),
  );
}

function discardsOnlyAnExactCurrentOutboundSet() {
  const directory = stateDirectory();
  const conversationId = "conversation:discard-outbound";
  const first = outboundMessage(conversationId, "msg_discard_a", "outer:a");
  const second = outboundMessage(conversationId, "msg_discard_b", "outer:b");
  return withStore(directory, (store) =>
    Effect.gen(function* () {
      yield* store.putConversationFoundation(foundation(conversationId));
      const retainedFirst = yield* store.enqueueOutbound(first);
      const retainedSecond = yield* store.enqueueOutbound(second);
      yield* expectReason(
        store.discardOutbound([
          retainedFirst,
          {
            ...retainedSecond,
            wireVersion: WIRE_VERSION,
            canonicalSignedMessage: bytes("outer:changed"),
          },
        ]),
        "conflict",
      );
      expect((yield* store.recover()).outboundMessages).toEqual([
        retainedFirst,
        retainedSecond,
      ]);
      expect(
        yield* store.discardOutbound([retainedFirst, retainedSecond]),
      ).toBe(INSERTED_MUTATION);
      expect(
        yield* store.discardOutbound([retainedFirst, retainedSecond]),
      ).toBe(EXISTING_MUTATION);
      expect((yield* store.recover()).outboundMessages).toEqual([]);
    }),
  );
}

function assertInitializedDatabase(directory: string): void {
  const path = databasePath(directory);
  expect(statSync(directory).mode & 0o777).toBe(DIRECTORY_MODE);
  expect(statSync(path).mode & 0o777).toBe(DATABASE_FILE_MODE);
}

function writeRemoteDelivery(
  store: EndpointStore,
  record: CertifiedRecord,
  delivery: InboundDeliveryInput,
) {
  return Effect.gen(function* () {
    yield* bindLocalIdentity(store);
    yield* store.putConversationFoundation(foundation(record.conversationId));
    expect(yield* store.applyCertifiedRecord(record, delivery)).toBe(
      INSERTED_MUTATION,
    );
    const firstReplay = yield* store.readPendingDeliveries();
    expect(firstReplay).toHaveLength(1);
    const firstDelivery = firstReplay[0];
    if (firstDelivery === undefined) {
      return yield* Effect.die("pending delivery did not retain a row");
    }
    expect(firstDelivery.deliveryToken).toMatch(/^dlv_[A-Za-z0-9_-]{43}$/u);
    expect(yield* store.applyCertifiedRecord(record, delivery)).toBe(
      EXISTING_MUTATION,
    );
    expect((yield* store.readPendingDeliveries())[0]?.deliveryToken).toBe(
      firstDelivery.deliveryToken,
    );
    yield* expectReason(
      store.applyCertifiedRecord(record, {
        ...delivery,
        canonicalMessage: bytes("message:collision"),
      }),
      "conflict",
    );
    expect(yield* store.acknowledgeDelivery(firstDelivery.deliveryToken)).toBe(
      INSERTED_MUTATION,
    );
    expect(yield* store.acknowledgeDelivery(firstDelivery.deliveryToken)).toBe(
      EXISTING_MUTATION,
    );
    expect(yield* store.readPendingDeliveries()).toEqual([]);
    return firstDelivery.deliveryToken;
  });
}

function verifyRemoteDeliveryRecovery(
  store: EndpointStore,
  record: CertifiedRecord,
  retainedToken: string,
) {
  return Effect.gen(function* () {
    expect(yield* store.readPendingDeliveries()).toEqual([]);
    const recovery = yield* store.recover();
    expect(recovery.positions[0]?.headRecordHash).toBe(record.recordHash);
    expect(recovery.certifiedRecords[0]?.actionEvidence).toEqual(
      record.actionEvidence,
    );
    expect(recovery.certifiedRecords[0]?.durabilityEvidence).toEqual(
      record.durabilityEvidence,
    );
    expect(recovery.pendingDeliveries).toHaveLength(1);
    expect(recovery.pendingDeliveries[0]).toMatchObject({
      deliveryToken: retainedToken,
      acknowledged: true,
      recordHash: record.recordHash,
    });
  });
}

/**
 * A certified record under a conversation's first anchor, with one action
 * signature and one durability vote, both its author's.
 * @param conversationId Conversation under whose first foundation it is.
 * @param authorAgentId Agent that authored it and signed both certificates.
 * @param ordinal Its position in the conversation, extending the record one
 *     position before it.
 * @returns A record whose hashes and bytes follow from its position.
 */
function certifiedRecord(
  conversationId: string,
  authorAgentId: string,
  ordinal = 0,
): CertifiedRecord {
  const actionHash = `ach_${conversationId}:${ordinal}`;
  const recordHash = `rch_${conversationId}:${ordinal}`;
  const conversationFoundation = foundation(conversationId);
  return {
    conversationId,
    recordHash,
    ...(ordinal === 0
      ? {}
      : { previousRecordHash: `rch_${conversationId}:${ordinal - 1}` }),
    membershipHash: conversationFoundation.membershipHash,
    anchorHash: conversationFoundation.anchorHash,
    actionHash,
    authorAgentId,
    postId: `pst_${authorAgentId}:${ordinal}`,
    canonicalRecordCore: bytes(`record:${conversationId}:${ordinal}`),
    actionEvidence: [
      {
        conversationId,
        kind: "action",
        subjectId: actionHash,
        evidenceKey: authorAgentId,
        canonicalEvidence: bytes(`action-signature:${authorAgentId}`),
      },
    ],
    durabilityEvidence: [
      {
        conversationId,
        kind: "durability",
        subjectId: recordHash,
        evidenceKey: authorAgentId,
        canonicalEvidence: bytes(`durability-vote:${authorAgentId}`),
      },
    ],
  };
}

/**
 * Bind this endpoint's identity and its post intent for `record`, with the
 * conversation's first foundation, and lock `record`'s action: the state in
 * which this endpoint proposes its own post.
 * @param store Store that takes the identity, the intent and the lock.
 * @param record Record whose post intent is bound and whose action is locked.
 * @returns Completion once all three are durable.
 */
function lockLocalPost(store: EndpointStore, record: StagedRecord) {
  return Effect.gen(function* () {
    yield* bindLocalIdentity(store);
    yield* store.bindPostIntent({
      kind: "new-conversation",
      foundation: foundation(record.conversationId),
      intent: postIntent(record.conversationId, record.postId),
    });
    yield* store.lockProposal(
      proposal(record.conversationId, record.actionHash),
    );
  });
}

function reanchorAwayFrom(head: CertifiedRecord): StagedReanchor {
  return {
    conversationId: head.conversationId,
    anchorHash: `anc_${head.conversationId}:1`,
    previousAnchorHash: head.anchorHash,
    routerInstanceId: `rti_${head.conversationId}`,
    selectedRecordHash: head.recordHash,
    canonicalBody: bytes(`reanchor:${head.conversationId}:1`),
  };
}

function stagedRecord(record: CertifiedRecord): StagedRecord {
  return {
    conversationId: record.conversationId,
    recordHash: record.recordHash,
    ...(record.previousRecordHash === undefined
      ? {}
      : { previousRecordHash: record.previousRecordHash }),
    membershipHash: record.membershipHash,
    anchorHash: record.anchorHash,
    actionHash: record.actionHash,
    authorAgentId: record.authorAgentId,
    postId: record.postId,
    canonicalRecordCore: record.canonicalRecordCore,
  };
}

function postIntent(conversationId: string, postId: string): PostIntent {
  return {
    conversationId,
    membershipHash: foundation(conversationId).membershipHash,
    authorAgentId: LOCAL_AGENT_ID,
    postId,
    canonicalIntent: bytes(`intent:${conversationId}:${postId}`),
  };
}

function foundation(conversationId: string): ConversationFoundation {
  return {
    conversationId,
    membershipHash: `mbr_${conversationId}`,
    canonicalMembership: bytes(`membership:${conversationId}`),
    anchorHash: `anc_${conversationId}:0`,
    canonicalAnchor: bytes(`anchor:${conversationId}:0`),
  };
}

function proposal(conversationId: string, actionHash: string): ProposalLock {
  return {
    conversationId,
    actionHash,
    canonicalActionCore: bytes(`action:${actionHash}`),
  };
}

function outboundMessage(
  conversationId: string,
  messageId: string,
  canonical: string,
): OutboundMessageInput {
  return {
    conversationId,
    messageId,
    wireVersion: WIRE_VERSION,
    canonicalSignedMessage: bytes(canonical),
  };
}

function localActionEvidence(
  conversationId: string,
  actionHash: string,
): ProtocolEvidence {
  return {
    conversationId,
    kind: "action",
    subjectId: actionHash,
    evidenceKey: LOCAL_AGENT_ID,
    canonicalEvidence: bytes("action-signature:local"),
  };
}

function actionCertificate(
  conversationId: string,
  actionHash: string,
): readonly ProtocolEvidence[] {
  return ["agent:a", "agent:b", "agent:c"].map(
    (signer): ProtocolEvidence => ({
      conversationId,
      kind: "action",
      subjectId: actionHash,
      evidenceKey: signer,
      canonicalEvidence: bytes(`action-signature:${signer}`),
    }),
  );
}

function bindLocalIdentity(
  store: EndpointStore,
): Effect.Effect<StoreMutation, EndpointStoreError> {
  return store.bindIdentity({
    agentId: LOCAL_AGENT_ID,
    canonicalAgentCard: bytes("card:local"),
  });
}

function expectReason<Value>(
  effect: Effect.Effect<Value, EndpointStoreError>,
  reason: EndpointStoreError["reason"],
): Effect.Effect<void> {
  return Effect.flip(effect).pipe(
    Effect.orDie,
    Effect.tap((failure) => {
      expect(failure).toBeInstanceOf(EndpointStoreError);
      expect(failure.reason).toBe(reason);
      expect(Object.hasOwn(failure, "cause")).toBe(false);
      return Effect.void;
    }),
    Effect.asVoid,
  );
}

describe("endpoint SQLite preflight", () => {
  it("initializes an empty database and reopens it", initializesEmptyDatabase);

  it(
    "rejects an unversioned populated database without changing its bytes",
    rejectsNonemptyDatabaseWithoutInitialization,
  );
});

// @agent-code-guard/regression-only: these cases pin the proposal-lock store contract.
describe("endpoint proposal locking", () => {
  it(
    "atomically binds the first post intent with its foundation",
    atomicallyBindsFirstIntentWithItsFoundation,
  );

  it(
    "atomically locks a verified genesis with its foundation",
    atomicallyLocksVerifiedGenesisFoundation,
  );

  it(
    "retains the first proposal lock across conflicts and restart",
    retainsFirstProposalAcrossRestart,
  );

  it(
    "replaces a conflicting lock with a certified one and its certificate",
    supersedesAConflictingLockWithItsCertificate,
  );
});

describe("endpoint record certification and delivery", () => {
  it(
    "atomically applies a remote record received whole and replays one stable delivery",
    promotesRemoteRecordWithStableDelivery,
  );

  it(
    "rolls back a record received whole, its staging included, when its delivery is absent",
    rollsBackRemoteRecordWithoutDelivery,
  );

  it(
    "completes a local post intent without creating self-delivery",
    completesLocalPostWithoutSelfDelivery,
  );
});

describe("endpoint re-anchor candidates", () => {
  it(
    "refuses a candidate away from a head it holds a staged successor of",
    refusesAReanchorAwayFromAStagedSuccessor,
  );

  it(
    "refuses its own durability vote under an anchor it staged a candidate away from",
    refusesALocalVoteUnderAnAnchorItReanchorsAwayFrom,
  );
});

describe("endpoint durable Router outbox", () => {
  it(
    "replays, retries, and completes exact envelopes",
    persistsExactOutboundLifecycleAcrossRestart,
  );

  it(
    "invalidates only an exact current envelope set atomically",
    discardsOnlyAnExactCurrentOutboundSet,
  );

  it(
    "recovers record dissemination before and after outbox attachment",
    retainsRecordDisseminationAcrossCrashWindows,
  );
});

describe("endpoint empty-history Router restart", () => {
  it(
    "retains intents while replacing only incomplete state",
    restartsOnlyAnEmptyConversationAtomically,
  );

  it(
    "refuses to replace a foundation after certification",
    refusesEmptyRestartAfterCertification,
  );
});
