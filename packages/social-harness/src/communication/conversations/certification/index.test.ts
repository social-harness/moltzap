/** @file Real N4 fixed-post certification through four durable endpoint engines. */

import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { scopedLive as it, scoped as itOnTestClock } from "@effect/vitest";
import {
  Cause,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Option,
  Queue,
  Ref,
  Schema,
  type Scope,
  Stream,
  SubscriptionRef,
} from "effect";
import { generateKeyPairSync } from "node:crypto";
import { describe, expect } from "vitest";
import type { RegistryLookupResult } from "../../../identity/registry/contract.js";
import type { AddressRegistryPort } from "../address.js";
import { advanceClock, untilLive } from "../../../__tests__/advance-clock.js";
import {
  digest,
  identifier,
  issueTestCard,
  makeTestAuthority,
  type RegistryKeyPair,
} from "../../../__tests__/agent-card-fixtures.js";
import { forwardStoredOutbound } from "../../../__tests__/forward-stored-outbound.js";
import { openOuterBody } from "../../../__tests__/outer-body-fixtures.js";
import { pollCursor as fixturePollCursor } from "../../../__tests__/router-worker-fixtures.js";
import {
  decodeCanonical,
  encodeCanonical,
} from "../../../encoding/canonical-json.js";
import { AgentCard, type VerifiedAgentCard } from "../../../identity/cards.js";
import {
  type AgentSigningAuthority,
  Ed25519PublicKey,
} from "../../../identity/keys.js";
import {
  LIVE_WIRE_VERSIONS,
  WIRE_VERSION,
  WireVersions,
} from "../../../identity/wire-version.js";
import { SignedMessage } from "../../envelope/signed-message.js";
import {
  type ActionCertifiedRecord as ActionCertifiedRecordValue,
  type ActionProposal,
  Content,
  ConversationId,
  type ConversationId as ConversationIdValue,
  type DecodedOuterBody,
  decodeOuterBody,
  deriveConversationId,
  DirectPacket,
  EvidenceStatement,
  hashAction,
  MembershipDescriptor,
  MembershipHash,
  type MembershipHash as MembershipHashValue,
  RecordCore,
  type RecordHash,
  signEvidenceMessage,
  signOuterEvidence,
  signOuterPacket,
  type VerifiedMembership,
  verifyMembershipDescriptor,
} from "../../records/index.js";
import { MessageAddressInput } from "../../records/values.js";
import { RouterInstanceId } from "../../router/api/contract.js";
import {
  type RouterIngressDisposition,
  type RouterTailAnchor,
  RouterWorkerDiscontinuityError,
  type RouterWorkerIngress,
  RouterWorkerPersistenceError,
  RouterWorkerRecoveryError,
  type RouterWorkerSendError,
  RouterWorkerTransportError,
  RouterWorkerUnavailableError,
} from "../../router/index.js";
import {
  type EndpointStore,
  EndpointStoreError,
  openEndpointStore,
} from "../../store/index.js";
import { SendError } from "../errors.js";
import { readStoredRecord } from "../history/index.js";
import {
  type EndpointEngine,
  type EndpointEngineInput,
  EngineInitializationError,
  type EngineOutboundError,
  type EngineSendInput,
  type EngineSentPost,
  makeEndpointEngine,
} from "../index.js";

/* eslint-disable max-lines, max-lines-per-function, max-statements, sonarjs/max-lines-per-function -- The full protocol traces share one four-endpoint harness and keep controlled Router phases beside durable assertions. */

/** The Router-worker operations an engine consumes. */
type EngineRouterPort = EndpointEngineInput["routerWorker"];

interface ProtocolIdentity {
  readonly card: VerifiedAgentCard;
  readonly authority: AgentSigningAuthority;
}

interface ProtocolHarness {
  readonly identities: readonly ProtocolIdentity[];
  readonly engines: readonly EndpointEngine[];
  readonly stores: readonly EndpointStore[];
  readonly membership: VerifiedMembership;
  readonly outbound: Queue.Queue<typeof SignedMessage.Type>;
  readonly groupAddress: string;
  readonly deliver: (
    messages: ReadonlyArray<typeof SignedMessage.Type>,
    endpointIndexes?: readonly number[],
  ) => Effect.Effect<readonly RouterIngressDisposition[]>;
  readonly drain: (endpointIndexes?: readonly number[]) => Effect.Effect<void>;
  readonly registry: AddressRegistryPort;
  readonly registrySignerPublicKey: typeof Ed25519PublicKey.Type;
}

const MEMBER_COUNT = 4;
/**
 * Bounds a hang while several N4 posts are signed, sealed, and verified.
 * Cryptographic work slows with machine load; no assertion depends on this
 * timeout.
 */
const TEST_TIMEOUT_MS = 60_000;

const routerInstanceId = Schema.decodeUnknownSync(RouterInstanceId)(
  identifier("rti_", 31),
);
const pollCursor = fixturePollCursor(32);
const unrelatedConversationId = Schema.decodeUnknownSync(ConversationId)(
  digest("cnv_", 35),
);
const unrelatedMembershipHash = Schema.decodeUnknownSync(MembershipHash)(
  digest("mbr_", 36),
);
function makeIdentities(
  registryKeys: RegistryKeyPair,
  endpointIndexes: readonly number[],
) {
  return Effect.forEach(
    endpointIndexes,
    (index) =>
      Effect.gen(function* () {
        const authority = yield* makeTestAuthority();
        return {
          card: yield* issueTestCard({
            byte: index + 1,
            name: `protocol-member-${index + 1}`,
            authority,
            registryKeys,
          }),
          authority,
        } satisfies ProtocolIdentity;
      }),
    { concurrency: 1 },
  );
}

function makeMembership(
  identities: readonly ProtocolIdentity[],
  registrySignerPublicKey: typeof Ed25519PublicKey.Type,
): Effect.Effect<VerifiedMembership> {
  return Effect.gen(function* () {
    const memberAgentIds = identities.map(({ card }) => card.agentId);
    const firstAgentId = memberAgentIds[0];
    const secondAgentId = memberAgentIds[1];
    if (firstAgentId === undefined || secondAgentId === undefined) {
      return yield* Effect.dieMessage("N4 membership is incomplete");
    }
    const conversationId = yield* deriveConversationId([
      firstAgentId,
      secondAgentId,
      ...memberAgentIds.slice(2),
    ]);
    const encodedCards = yield* Effect.forEach(
      identities,
      ({ card }) => Schema.encode(AgentCard)(card),
      { concurrency: 1 },
    );
    const firstCard = encodedCards[0];
    const secondCard = encodedCards[1];
    if (firstCard === undefined || secondCard === undefined) {
      return yield* Effect.dieMessage("N4 card encoding is incomplete");
    }
    const descriptor = yield* Schema.decodeUnknown(MembershipDescriptor)({
      sharnessVersion: WIRE_VERSION,
      kind: "membership_descriptor",
      conversationId,
      members: [firstCard, secondCard, ...encodedCards.slice(2)],
    });
    return yield* verifyMembershipDescriptor(
      descriptor,
      registrySignerPublicKey,
    );
  }).pipe(Effect.orDie);
}

function lookupIdentity(
  identities: readonly ProtocolIdentity[],
  request: Parameters<AddressRegistryPort["lookup"]>[0],
): RegistryLookupResult {
  const found = identities.find(({ card }) =>
    "agentName" in request
      ? card.agentName === request.agentName
      : card.agentId === request.agentId,
  );
  return found === undefined
    ? { kind: "not_found" }
    : { kind: "found", agentCard: found.card };
}

function requireAt<Value>(
  values: readonly Value[],
  index: number,
  label: string,
): Effect.Effect<Value> {
  const value = values[index];
  return value === undefined
    ? Effect.dieMessage(`missing ${label} ${index}`)
    : Effect.succeed(value);
}

/** The ingress one receiving member's Router worker hands its engine. */
function decodeIngress(
  identities: readonly ProtocolIdentity[],
  message: typeof SignedMessage.Type,
  reader: ProtocolIdentity,
): Effect.Effect<RouterWorkerIngress<DecodedOuterBody>> {
  return Effect.gen(function* () {
    const sender = yield* senderOf(identities, message);
    const live = yield* Schema.encode(SignedMessage)(message).pipe(
      Effect.flatMap(Schema.decodeUnknown(SignedMessage.live)),
    );
    const verified = yield* SignedMessage.verify({
      signedMessage: live,
      agentCard: sender.card,
    });
    return {
      routerInstanceId,
      message: verified,
      senderCard: sender.card,
      payload: yield* decodeOuterBody({
        message: verified,
        agentCard: reader.card,
        signingAuthority: reader.authority,
      }),
    };
  }).pipe(Effect.orDie);
}

type WorkerAttachment = Pick<EngineRouterPort, "awaitAnchor" | "currentAnchor">;

/** Replaces a worker's transmit, given the scripted Router forward. */
type WrapSend = (forward: EngineRouterPort["send"]) => EngineRouterPort["send"];

function attachesWhenResolved(
  attached: Deferred.Deferred<RouterTailAnchor>,
): WorkerAttachment {
  return {
    currentAnchor: Deferred.poll(attached).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new RouterWorkerUnavailableError()),
          onSome: (anchor: Effect.Effect<RouterTailAnchor>) => anchor,
        }),
      ),
    ),
    awaitAnchor: Deferred.await(attached),
  };
}

const neverAttaches: WorkerAttachment = {
  currentAnchor: Effect.fail(new RouterWorkerUnavailableError()),
  awaitAnchor: Effect.never,
};

/**
 * Start a member's engine again over its store, as the member does when it
 * restarts.
 * @param harness Registry and Router queue the engine uses.
 * @param identity Member whose engine starts again.
 * @param store Store the member's engine wrote before the restart.
 * @returns The restarted engine, or the error its startup failed with.
 */
function restartMember(
  harness: ProtocolHarness,
  identity: ProtocolIdentity,
  store: EndpointStore,
) {
  return makeEndpointEngine({
    localAgentCard: identity.card,
    signingAuthority: identity.authority,
    registrySignerPublicKey: harness.registrySignerPublicKey,
    registry: harness.registry,
    store,
    reportStorageFault: () => Effect.void,
    routerWorker: scriptedRouterWorker(store, harness.outbound),
  });
}

function scriptedRouterWorker(
  store: EndpointStore,
  outbound: Queue.Queue<typeof SignedMessage.Type>,
  attachment?: WorkerAttachment,
  wrapSend?: WrapSend,
): EngineRouterPort {
  const anchor = { routerInstanceId, pollCursor };
  const forward = (messageId: string) =>
    forwardStoredOutbound(store, outbound, messageId);
  return {
    currentAnchor: attachment?.currentAnchor ?? Effect.succeed(anchor),
    awaitAnchor: attachment?.awaitAnchor ?? Effect.succeed(anchor),
    send: wrapSend === undefined ? forward : wrapSend(forward),
  };
}

/**
 * Hands one message to each selected member at once, as separate endpoint
 * processes receive it, so the members' WebCrypto round trips overlap instead
 * of adding up. Each member still takes its deliveries in order, and the
 * dispositions come back in member order.
 * @param identities Every member, whose keys open the message.
 * @param engines Every member's engine.
 * @param selectedIndexes The members that receive the message.
 * @param message The outer message Router delivers.
 * @returns Each selected member's disposition, in member order.
 */
function deliverIngress(
  identities: readonly ProtocolIdentity[],
  engines: readonly EndpointEngine[],
  selectedIndexes: readonly number[],
  message: typeof SignedMessage.Type,
) {
  return Effect.forEach(
    selectedIndexes,
    (index) =>
      Effect.all([
        requireAt(identities, index, "identity"),
        requireAt(engines, index, "endpoint engine"),
      ]).pipe(
        Effect.flatMap(([reader, engine]) =>
          decodeIngress(identities, message, reader).pipe(
            Effect.flatMap((ingress) => engine.acceptRouterIngress(ingress)),
          ),
        ),
      ),
    { concurrency: selectedIndexes.length },
  );
}

function deliverMessages(
  identities: readonly ProtocolIdentity[],
  engines: readonly EndpointEngine[],
  messages: ReadonlyArray<typeof SignedMessage.Type>,
  selectedIndexes: readonly number[],
) {
  return Effect.forEach(
    messages,
    (message) => deliverIngress(identities, engines, selectedIndexes, message),
    { concurrency: 1 },
  ).pipe(
    Effect.map((dispositions) => dispositions.flat()),
    Effect.orDie,
  );
}

function drainEngines(
  engines: readonly EndpointEngine[],
  selectedIndexes: readonly number[],
) {
  return Effect.forEach(
    selectedIndexes,
    (index) =>
      requireAt(engines, index, "endpoint engine").pipe(
        Effect.flatMap((engine) => engine.drainOutbound),
      ),
    { concurrency: 1, discard: true },
  ).pipe(Effect.orDie);
}

interface HarnessOptions {
  readonly emittedVersions?: readonly string[];
  /** Members of the conversation; four when omitted. */
  readonly memberCount?: number;
  /** Present when the author's Router worker has not attached yet. */
  readonly attachment?: WorkerAttachment;
  /** Replaces the author's worker transmit. */
  readonly authorSend?: WrapSend;
  /** Receives the author engine's storage-fault reports. */
  readonly reportStorageFault?: Effect.Effect<void>;
  /** Replaces the store an endpoint's engine writes through. */
  readonly wrapStore?: (
    store: EndpointStore,
    identity: ProtocolIdentity,
    index: number,
  ) => EndpointStore;
}

function makeProtocolHarness(
  options: HarnessOptions = {},
): Effect.Effect<ProtocolHarness, never, Scope.Scope> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const registryKeys = generateKeyPairSync("ed25519");
    const registrySignerPublicKey = yield* Schema.decodeUnknown(
      Ed25519PublicKey,
    )(registryKeys.publicKey.export({ format: "jwk" }));
    const endpointIndexes = Array.from(
      Array(options.memberCount ?? MEMBER_COUNT).keys(),
    );
    const identities = yield* makeIdentities(registryKeys, endpointIndexes);
    const membership = yield* makeMembership(
      identities,
      registrySignerPublicKey,
    );
    const stores = yield* Effect.forEach(
      endpointIndexes,
      (index) =>
        fileSystem
          .makeTempDirectoryScoped({
            prefix: `sharness-engine-protocol-${index}-`,
          })
          .pipe(
            Effect.flatMap((directory) =>
              openEndpointStore(directory, {
                liveWireVersions: LIVE_WIRE_VERSIONS,
              }),
            ),
          ),
      { concurrency: 1 },
    );
    const outbound = yield* Queue.unbounded<typeof SignedMessage.Type>();
    const registry: AddressRegistryPort = {
      lookup: (request) => Effect.succeed(lookupIdentity(identities, request)),
    };
    const authorPorts = {
      reportStorageFault: () => options.reportStorageFault ?? Effect.void,
      attachment: options.attachment,
      authorSend: options.authorSend,
    };
    const memberPorts = {
      reportStorageFault: () => Effect.void,
      attachment: undefined,
      authorSend: undefined,
    };
    const engines = yield* Effect.forEach(
      identities,
      (identity, index) =>
        requireAt(stores, index, "endpoint store").pipe(
          Effect.flatMap((store) => {
            const ports = index === 0 ? authorPorts : memberPorts;
            return makeEndpointEngine({
              localAgentCard: identity.card,
              signingAuthority: identity.authority,
              registrySignerPublicKey,
              registry,
              store: options.wrapStore?.(store, identity, index) ?? store,
              reportStorageFault: ports.reportStorageFault,
              routerWorker: scriptedRouterWorker(
                store,
                outbound,
                ports.attachment,
                ports.authorSend,
              ),
            }).pipe(
              Effect.provideService(WireVersions, {
                emitted: options.emittedVersions?.[index] ?? WIRE_VERSION,
                live: options.emittedVersions ?? LIVE_WIRE_VERSIONS,
                history: options.emittedVersions ?? LIVE_WIRE_VERSIONS,
              }),
            );
          }),
        ),
      { concurrency: 1 },
    );
    const deliver: ProtocolHarness["deliver"] = (
      messages,
      selectedIndexes = endpointIndexes,
    ) => deliverMessages(identities, engines, messages, selectedIndexes);
    const drain: ProtocolHarness["drain"] = (
      selectedIndexes = endpointIndexes,
    ) => drainEngines(engines, selectedIndexes);
    return {
      identities,
      engines,
      stores,
      membership,
      outbound,
      groupAddress: `group:${identities.map(({ card }) => card.agentName).join(",")}`,
      deliver,
      drain,
      registry,
      registrySignerPublicKey,
    } satisfies ProtocolHarness;
  }).pipe(Effect.provide(NodeFileSystem.layer), Effect.orDie);
}

function sendInput(
  harness: ProtocolHarness,
  text: string,
): Effect.Effect<EngineSendInput> {
  return Effect.all({
    to: Schema.decodeUnknown(MessageAddressInput)(harness.groupAddress),
    content: Schema.decodeUnknown(Content)([{ type: "text", text }]),
  }).pipe(Effect.orDie);
}

function takeReadyBatch(harness: ProtocolHarness) {
  return Queue.take(harness.outbound).pipe(
    Effect.flatMap((first) =>
      Queue.takeAll(harness.outbound).pipe(
        Effect.map((remaining) => [first, ...remaining]),
      ),
    ),
  );
}

function takeQueued(harness: ProtocolHarness) {
  return Queue.takeAll(harness.outbound).pipe(
    Effect.map((messages) => Array.from(messages)),
  );
}

function protocolMessageKind(
  harness: Pick<ProtocolHarness, "identities">,
  message: typeof SignedMessage.Type,
): Effect.Effect<string> {
  return openAsSender(harness, message).pipe(
    Effect.flatMap((body) =>
      body.kind === "direct"
        ? Effect.succeed(body.packet.kind)
        : decodeCanonical(EvidenceStatement, body.message.body).pipe(
            Effect.map((statement) => statement.kind),
          ),
    ),
    Effect.orDie,
  );
}

/**
 * The messages in `messages` that `sender` sent and whose body is `kind`.
 * @param harness Members whose keys open the envelopes.
 * @param messages Envelopes in delivery order.
 * @param sender Member whose envelopes are kept.
 * @param kind Direct packet or evidence statement kind to keep.
 * @returns The matching envelopes, in order.
 */
function sentOfKind(
  harness: ProtocolHarness,
  messages: ReadonlyArray<typeof SignedMessage.Type>,
  sender: ProtocolIdentity,
  kind: string,
) {
  return messagesOfKind(
    harness,
    messages.filter(
      ({ senderAgentId }) => senderAgentId === sender.card.agentId,
    ),
    kind,
  );
}

function messagesOfKind(
  harness: Pick<ProtocolHarness, "identities">,
  messages: ReadonlyArray<typeof SignedMessage.Type>,
  kind: string,
) {
  return Effect.forEach(
    messages,
    (message) =>
      protocolMessageKind(harness, message).pipe(
        Effect.map((actualKind) => ({ actualKind, message })),
      ),
    { concurrency: 1 },
  ).pipe(
    Effect.map((classified) =>
      classified
        .filter(({ actualKind }) => actualKind === kind)
        .map(({ message }) => message),
    ),
  );
}

function decodeActionProposal(
  harness: Pick<ProtocolHarness, "identities">,
  message: typeof SignedMessage.Type,
): Effect.Effect<ActionProposal> {
  return openAsSender(harness, message).pipe(
    Effect.flatMap((body) =>
      body.kind === "direct" && body.packet.kind === "action_proposal"
        ? Effect.succeed(body.packet)
        : Effect.dieMessage("expected action proposal"),
    ),
    Effect.orDie,
  );
}

function decodeActionCertifiedRecord(
  harness: Pick<ProtocolHarness, "identities">,
  message: typeof SignedMessage.Type,
): Effect.Effect<ActionCertifiedRecordValue> {
  return openAsSender(harness, message).pipe(
    Effect.flatMap((body) =>
      body.kind === "direct" && body.packet.kind === "action_certified_record"
        ? Effect.succeed(body.packet)
        : Effect.dieMessage("expected action-certified record"),
    ),
    Effect.orDie,
  );
}

function decodeActionSignatureHash(
  harness: Pick<ProtocolHarness, "identities">,
  message: typeof SignedMessage.Type,
): Effect.Effect<Effect.Effect.Success<ReturnType<typeof hashAction>>> {
  return decodeEvidenceStatement(harness, message).pipe(
    Effect.flatMap((statement) =>
      statement.kind === "action_signature"
        ? Effect.succeed(statement.actionHash)
        : Effect.dieMessage("expected action signature"),
    ),
  );
}

function decodeEvidenceStatement(
  harness: Pick<ProtocolHarness, "identities">,
  message: typeof SignedMessage.Type,
): Effect.Effect<typeof EvidenceStatement.Type> {
  return openAsSender(harness, message).pipe(
    Effect.flatMap((body) =>
      body.kind === "evidence"
        ? decodeCanonical(EvidenceStatement, body.message.body)
        : Effect.dieMessage("expected evidence envelope"),
    ),
    Effect.orDie,
  );
}

/** Opens an envelope's sealed body as its sender, which every body is sealed to. */
function openAsSender(
  harness: Pick<ProtocolHarness, "identities">,
  message: typeof SignedMessage.Type,
): Effect.Effect<DecodedOuterBody> {
  return senderOf(harness.identities, message).pipe(
    Effect.flatMap((sender) => openOuterBody(message, sender)),
    Effect.orDie,
  );
}

function senderOf(
  identities: readonly ProtocolIdentity[],
  message: typeof SignedMessage.Type,
): Effect.Effect<ProtocolIdentity> {
  const identity = identities.find(
    ({ card }) => card.agentId === message.senderAgentId,
  );
  return identity === undefined
    ? Effect.dieMessage("unknown protocol sender")
    : Effect.succeed(identity);
}

/**
 * Count each member store's certified records, in member order.
 * @param harness Engines and the stores they persist to.
 * @returns One certified-record count per member.
 */
function certifiedRecordCounts(
  harness: ProtocolHarness,
): Effect.Effect<readonly number[]> {
  return Effect.forEach(
    harness.stores,
    (store) =>
      store.recover().pipe(
        Effect.orDie,
        Effect.map(({ certifiedRecords }) => certifiedRecords.length),
      ),
    { concurrency: 1 },
  );
}

/**
 * Deliver a batch to every engine, drain each, and repeat with whatever the
 * engines queued, until a round queues nothing. An exchange still producing
 * traffic after 32 rounds is a defect in the scripted Router, so it dies.
 * @param harness Engines and the scripted Router queue they send through.
 * @param initial First batch to deliver.
 * @param silent A member whose messages are dropped, as if it stopped
 *     sending.
 * @returns Every delivered message in delivery order, once the exchange is
 *   idle.
 */
function pump(
  harness: ProtocolHarness,
  initial: ReadonlyArray<typeof SignedMessage.Type>,
  silent?: string,
): Effect.Effect<ReadonlyArray<typeof SignedMessage.Type>> {
  return Effect.gen(function* () {
    const delivered: Array<typeof SignedMessage.Type> = [];
    let batch = initial;
    for (let round = 0; round < 32; round += 1) {
      batch = batch.filter((message) => message.senderAgentId !== silent);
      if (batch.length === 0) {
        return delivered;
      }
      yield* harness.deliver(batch);
      delivered.push(...batch);
      yield* harness.drain();
      batch = yield* takeQueued(harness);
    }
    return yield* Effect.dieMessage("scripted Router did not become idle");
  });
}

function certifyGenesisOf(
  harness: ProtocolHarness,
  sending: Fiber.RuntimeFiber<EngineSentPost, SendError>,
): Effect.Effect<RecordHash> {
  return Effect.gen(function* () {
    const initial = yield* takeReadyBatch(harness);
    const proposalMessage = yield* requireAt(initial, 0, "genesis proposal");
    const proposal = yield* decodeActionProposal(harness, proposalMessage);
    if (proposal.action.kind !== "GENESIS") {
      return yield* Effect.dieMessage("first addressed send was not GENESIS");
    }
    yield* pump(harness, initial);
    expect(yield* certifiedRecordCounts(harness)).toEqual([1, 1, 1, 1]);
    const sent = yield* Fiber.join(sending).pipe(Effect.orDie);
    return sent.recordHash;
  });
}

function certifyGenesis(harness: ProtocolHarness): Effect.Effect<RecordHash> {
  return Effect.gen(function* () {
    const author = yield* requireAt(harness.engines, 0, "endpoint engine");
    const sending = yield* Effect.fork(
      author.send(yield* sendInput(harness, "open group")),
    );
    return yield* certifyGenesisOf(harness, sending);
  });
}

function hostileDurabilityMessage(input: {
  readonly harness: ProtocolHarness;
  readonly signer: ProtocolIdentity;
  readonly recordHash: RecordHash;
  readonly conversationId: ConversationIdValue;
  readonly membershipHash: MembershipHashValue;
}) {
  return signEvidenceMessage({
    statement: {
      sharnessVersion: WIRE_VERSION,
      kind: "durability_vote",
      signerAgentId: input.signer.card.agentId,
      conversationId: input.conversationId,
      membershipHash: input.membershipHash,
      recordHash: input.recordHash,
    },
    agentCard: input.signer.card,
    signingAuthority: input.signer.authority,
  }).pipe(
    Effect.flatMap((evidence) =>
      signOuterEvidence({
        evidence,
        membership: input.harness.membership,
        agentCard: input.signer.card,
        signingAuthority: input.signer.authority,
      }),
    ),
    Effect.orDie,
  );
}

/**
 * The outer evidence message carrying an action signature that `signer` makes
 * for `actionHash` whatever it locked, as an equivocating member sends it.
 */
function hostileActionSignature(input: {
  readonly harness: ProtocolHarness;
  readonly signer: ProtocolIdentity;
  readonly actionHash: Effect.Effect.Success<ReturnType<typeof hashAction>>;
}) {
  return signEvidenceMessage({
    statement: {
      sharnessVersion: WIRE_VERSION,
      kind: "action_signature",
      signerAgentId: input.signer.card.agentId,
      actionHash: input.actionHash,
    },
    agentCard: input.signer.card,
    signingAuthority: input.signer.authority,
  }).pipe(
    Effect.flatMap((evidence) =>
      signOuterEvidence({
        evidence,
        membership: input.harness.membership,
        agentCard: input.signer.card,
        signingAuthority: input.signer.authority,
      }),
    ),
    Effect.orDie,
  );
}

/** The conversation and membership a durability vote is signed over. */
interface DurabilityBinding {
  readonly conversationId: ConversationIdValue;
  readonly membershipHash: MembershipHashValue;
}

/**
 * Stages the author's successor POST up to its action certificate, persists
 * a durability vote from member 3 under `bind`'s binding in the author's
 * store, and restarts the author's engine over that store. The vote belongs
 * to no certified record, so only the staged fold's evidence recovery reads
 * it.
 * @param bind Chooses the vote's binding from the conversation's membership.
 * @param filedUnder The member whose AgentId keys the vote's row; the voter
 *   is member 3.
 * @returns `"started"`, or the error the restart failed with.
 */
function restartOverPersistedDurabilityVote(
  bind: (membership: VerifiedMembership) => DurabilityBinding,
  filedUnder: number,
): Effect.Effect<"started" | EngineInitializationError, never, Scope.Scope> {
  return Effect.gen(function* () {
    const harness = yield* makeProtocolHarness();
    yield* certifyGenesis(harness);
    const author = yield* requireAt(harness.identities, 0, "identity");
    const voter = yield* requireAt(harness.identities, 3, "durability voter");
    const keyMember = yield* requireAt(
      harness.identities,
      filedUnder,
      "evidence key member",
    );
    const authorEngine = yield* requireAt(
      harness.engines,
      0,
      "endpoint engine",
    );
    const authorStore = yield* requireAt(harness.stores, 0, "endpoint store");
    const sending = yield* Effect.fork(
      authorEngine.send(yield* sendInput(harness, "stage successor")),
    );
    yield* harness.deliver(yield* takeReadyBatch(harness));
    yield* harness.drain();
    const actionSignatures = yield* messagesOfKind(
      harness,
      yield* takeQueued(harness),
      "action_signature",
    );
    yield* harness.deliver(actionSignatures.slice(0, 3));
    yield* harness.drain();
    const authorActionRecordMessage = (yield* messagesOfKind(
      harness,
      yield* takeQueued(harness),
      "action_certified_record",
    )).find((message) => message.senderAgentId === author.card.agentId);
    if (authorActionRecordMessage === undefined) {
      return yield* Effect.dieMessage(
        "author did not assemble the staged action certificate",
      );
    }
    const actionRecord = yield* decodeActionCertifiedRecord(
      harness,
      authorActionRecordMessage,
    );
    const vote = yield* signEvidenceMessage({
      statement: {
        sharnessVersion: WIRE_VERSION,
        kind: "durability_vote",
        signerAgentId: voter.card.agentId,
        ...bind(harness.membership),
        recordHash: actionRecord.recordHash,
      },
      agentCard: voter.card,
      signingAuthority: voter.authority,
    }).pipe(Effect.orDie);
    yield* authorStore
      .mergeEvidence({
        conversationId: harness.membership.descriptor.conversationId,
        kind: "durability",
        subjectId: actionRecord.recordHash,
        evidenceKey: keyMember.card.agentId,
        canonicalEvidence: yield* encodeCanonical(SignedMessage, vote).pipe(
          Effect.orDie,
        ),
      })
      .pipe(Effect.orDie);
    yield* Fiber.interrupt(sending);

    return yield* restartMember(harness, author, authorStore).pipe(
      Effect.match({
        onFailure: (error) => error,
        onSuccess: () => "started" as const,
      }),
    );
  });
}

/**
 * Member 2 misses member 1's proposal at the genesis head and locks its own
 * there, while members 1, 3 and 4 lock and sign member 1's. Member 4 then
 * falls silent, so member 1's post certifies only if member 2 adopts its
 * action certificate over its own lock and votes for it. Member 2's own post
 * is then proposed again from the new head and certifies, and its signature
 * on the released action is ignored. Restarted over its store, member 2 sends
 * no signature for the action it adopted.
 * @returns Completion once member 2 holds both posts and restarts cleanly.
 */
function adoptsAnActionCertificateOverItsOwnLock() {
  return Effect.gen(function* () {
    const harness = yield* makeProtocolHarness();
    yield* certifyGenesis(harness);
    const winnerAuthor = yield* requireAt(
      harness.engines,
      0,
      "endpoint engine",
    );
    const lagging = yield* requireAt(harness.engines, 1, "endpoint engine");
    const laggingIdentity = yield* requireAt(harness.identities, 1, "identity");
    const laggingStore = yield* requireAt(harness.stores, 1, "endpoint store");
    const winning = yield* Effect.fork(
      winnerAuthor.send(yield* sendInput(harness, "winner")),
    );
    const winnerBatch = yield* takeReadyBatch(harness);
    const winnerActionHash = yield* requireAt(
      winnerBatch,
      1,
      "winning proposal",
    ).pipe(
      Effect.flatMap((message) => decodeActionProposal(harness, message)),
      Effect.flatMap((proposal) =>
        hashAction(proposal.action).pipe(Effect.orDie),
      ),
    );
    const losing = yield* Effect.fork(
      lagging.send(yield* sendInput(harness, "member 2 post")),
    );
    const loserBatch = yield* takeReadyBatch(harness);

    const silent = yield* requireAt(harness.identities, 3, "identity");

    yield* harness.deliver(winnerBatch, [0, 2, 3]);
    yield* harness.deliver(loserBatch);
    yield* harness.drain();
    const signatures = yield* takeQueued(harness);
    yield* harness.deliver(signatures);
    yield* harness.drain();
    yield* pump(harness, yield* takeQueued(harness), silent.card.agentId);
    yield* Fiber.join(winning).pipe(Effect.orDie);
    yield* Fiber.join(losing).pipe(Effect.orDie);

    const pending = yield* lagging.readPendingMessages().pipe(Effect.orDie);
    expect(pending.map(({ message }) => message.content)).toEqual([
      [{ type: "text", text: "open group" }],
      [{ type: "text", text: "winner" }],
    ]);
    const recovered = yield* laggingStore.recover().pipe(Effect.orDie);
    expect(recovered.certifiedRecords).toHaveLength(3);
    const releasedSignature = yield* messagesOfKind(
      harness,
      signatures.filter(
        (message) => message.senderAgentId === laggingIdentity.card.agentId,
      ),
      "action_signature",
    );
    expect(yield* harness.deliver(releasedSignature, [1])).toEqual(["ignored"]);

    yield* takeQueued(harness);
    const restarted = yield* restartMember(
      harness,
      laggingIdentity,
      laggingStore,
    ).pipe(Effect.orDie);
    yield* restarted.drainOutbound.pipe(Effect.orDie);
    const resent = yield* messagesOfKind(
      harness,
      yield* takeQueued(harness),
      "action_signature",
    );
    const resentHashes = yield* Effect.forEach(
      resent,
      (message) => decodeActionSignatureHash(harness, message),
      { concurrency: 1 },
    );
    expect(resentHashes).not.toContain(winnerActionHash);
  });
}

/**
 * The latest POST record `author`'s store certified, sent whole by `author`.
 * @param harness Engines and the stores they persist to.
 * @param author The member whose store and identity send the record.
 * @returns The outer message carrying the `CertifiedRecord`.
 */
function certifiedRecordPacket(
  harness: ProtocolHarness,
  author: ProtocolIdentity,
) {
  return Effect.gen(function* () {
    const index = harness.identities.indexOf(author);
    const store = yield* requireAt(harness.stores, index, "endpoint store");
    const recovery = yield* store.recover();
    const stored = recovery.certifiedRecords
      .filter(({ previousRecordHash }) => previousRecordHash !== undefined)
      .at(-1);
    if (stored === undefined) {
      return yield* Effect.dieMessage("no POST record is certified");
    }
    const record = yield* readStoredRecord(
      harness.membership,
      recovery,
      stored,
    );
    return yield* signOuterPacket({
      packet: record,
      membership: harness.membership,
      agentCard: author.card,
      signingAuthority: author.authority,
    });
  }).pipe(Effect.orDie);
}

/**
 * Member 2 misses member 1's proposal at the genesis head and locks its own
 * there, while members 1, 3 and 4 lock, sign and vote for member 1's. Member
 * 2 also misses that post's action-certified copies, so the post first reaches
 * it as member 1's whole CertifiedRecord in a direct packet, which members
 * accept although none sends one. Member 2 accepts it over its own lock, and
 * its own post is then proposed again from the new head and certifies.
 * @returns Completion once member 2 holds both posts.
 */
function adoptsACertifiedRecordOverItsOwnLock() {
  return Effect.gen(function* () {
    const harness = yield* makeProtocolHarness();
    yield* certifyGenesis(harness);
    const winnerAuthor = yield* requireAt(
      harness.engines,
      0,
      "endpoint engine",
    );
    const winnerAuthorIdentity = yield* requireAt(
      harness.identities,
      0,
      "identity",
    );
    const lagging = yield* requireAt(harness.engines, 1, "endpoint engine");
    const laggingStore = yield* requireAt(harness.stores, 1, "endpoint store");
    const everyMemberButTheLagging = [0, 2, 3];
    const winning = yield* Effect.fork(
      winnerAuthor.send(yield* sendInput(harness, "winner")),
    );
    const winnerBatch = yield* takeReadyBatch(harness);
    const losing = yield* Effect.fork(
      lagging.send(yield* sendInput(harness, "member 2 post")),
    );
    const loserBatch = yield* takeReadyBatch(harness);

    yield* harness.deliver(winnerBatch, everyMemberButTheLagging);
    yield* harness.deliver(loserBatch);
    yield* harness.drain();
    yield* harness.deliver(yield* takeQueued(harness));
    yield* harness.drain();
    yield* harness.deliver(
      yield* takeQueued(harness),
      everyMemberButTheLagging,
    );
    yield* harness.drain();
    yield* takeQueued(harness);
    const winnerCertifiedRecord = yield* certifiedRecordPacket(
      harness,
      winnerAuthorIdentity,
    );
    const adopted = yield* harness.deliver([winnerCertifiedRecord], [1]);
    yield* harness.drain([1]);
    yield* pump(harness, yield* takeQueued(harness));
    yield* Fiber.join(winning).pipe(Effect.orDie);
    yield* Fiber.join(losing).pipe(Effect.orDie);

    expect(adopted).toEqual(["accepted"]);
    const pending = yield* lagging.readPendingMessages().pipe(Effect.orDie);
    expect(pending.map(({ message }) => message.content)).toEqual([
      [{ type: "text", text: "open group" }],
      [{ type: "text", text: "winner" }],
    ]);
    const recovered = yield* laggingStore.recover().pipe(Effect.orDie);
    expect(recovered.certifiedRecords).toHaveLength(3);
  });
}

/**
 * Members 1, 2 and 3 certify a post that member 4 misses, so the post first
 * reaches member 4 as member 1's whole CertifiedRecord and member 4 never
 * votes for it. Restarted over its store, member 4 resends the genesis vote
 * it signed and signs no vote for the post.
 * @returns Completion once member 4's restart traffic is checked.
 */
function restartSignsNoVoteForARecordAcceptedWhole() {
  return Effect.gen(function* () {
    const harness = yield* makeProtocolHarness();
    const genesisRecordHash = yield* certifyGenesis(harness);
    const authorIdentity = yield* requireAt(harness.identities, 0, "identity");
    yield* certifyAPostMember4Misses(harness, "certified without member 4");
    const accepted = yield* harness.deliver(
      [yield* certifiedRecordPacket(harness, authorIdentity)],
      [3],
    );
    yield* harness.drain([3]);
    yield* takeQueued(harness);

    const resent = yield* restartMember4(harness);
    const votes = yield* Effect.forEach(
      yield* messagesOfKind(harness, resent, "durability_vote"),
      (message) => decodeEvidenceStatement(harness, message),
      { concurrency: 1 },
    );

    expect(accepted).toEqual(["accepted"]);
    expect(votes).toMatchObject([{ recordHash: genesisRecordHash }]);
  });
}

/**
 * Members 1, 2 and 3 certify a post that member 4 misses, and member 4's store
 * refuses member 1's whole CertifiedRecord of it, as a crash before the store
 * commits the record leaves it. Every store refuses records received whole,
 * and member 4's is the only one that receives one. Member 4 keeps the post's
 * action certificate it verified on the way, so once restarted over its store
 * it resends its genesis signature and vote, then stages the post from that
 * certificate and sends its own action-certified copy of the post before its
 * vote. Fails when the record's core is stored apart from its durability
 * certificate: a restart cannot tell that core from one staged for this
 * member's own vote, and votes for it with no copy first.
 * @returns Completion once member 4's restart traffic is checked.
 */
function restartSendsItsCopyBeforeVotingForARecordItsStoreRefused() {
  return Effect.gen(function* () {
    const harness = yield* makeProtocolHarness({
      wrapStore: (store) => refusingWholeRecords(store),
    });
    yield* certifyGenesis(harness);
    const authorIdentity = yield* requireAt(harness.identities, 0, "identity");
    yield* certifyAPostMember4Misses(harness, "refused by member 4's store");
    const refused = yield* harness.deliver(
      [yield* certifiedRecordPacket(harness, authorIdentity)],
      [3],
    );
    yield* harness.drain([3]);
    yield* takeQueued(harness);

    const resent = yield* restartMember4(harness);
    const kinds = yield* Effect.forEach(
      resent,
      (message) => protocolMessageKind(harness, message),
      { concurrency: 1 },
    );

    expect(refused).toEqual(["ignored"]);
    expect(kinds).toEqual([
      "action_signature",
      "durability_vote",
      "action_certified_record",
      "durability_vote",
    ]);
  });
}

/**
 * Members 1, 2 and 3 certify a post that member 4 misses, and member 4's store
 * refuses member 1's whole CertifiedRecord of it. Without a restart, member 4
 * then receives member 1's action-certified copy of the post: it stages the
 * post from that copy and sends its own copy before its vote. Fails when
 * member 4's fold takes the refused record or its promotion ahead of the
 * store's commit, so the copy finds the post staged or certified only in
 * memory and draws no copy or no vote from member 4.
 */
function stagesFromALaterCopyARecordItsStoreRefusedWhole() {
  return Effect.gen(function* () {
    const harness = yield* makeProtocolHarness({
      wrapStore: (store) => refusingWholeRecords(store),
    });
    yield* certifyGenesis(harness);
    const authorIdentity = yield* requireAt(harness.identities, 0, "identity");
    const absentIdentity = yield* requireAt(harness.identities, 3, "identity");
    const authorCopy = yield* certifyAPostMember4Misses(
      harness,
      "copied after member 4's store refused it whole",
    );
    const refused = yield* harness.deliver(
      [yield* certifiedRecordPacket(harness, authorIdentity)],
      [3],
    );
    yield* harness.drain([3]);
    yield* takeQueued(harness);

    const answer = yield* harness.deliver(authorCopy, [3]);
    yield* harness.drain([3]);
    const kinds = yield* Effect.forEach(
      (yield* takeQueued(harness)).filter(
        ({ senderAgentId }) => senderAgentId === absentIdentity.card.agentId,
      ),
      (message) => protocolMessageKind(harness, message),
      { concurrency: 1 },
    );

    expect(refused).toEqual(["ignored"]);
    expect(answer).toEqual(["accepted"]);
    expect(kinds).toEqual(["action_certified_record", "durability_vote"]);
  });
}

/**
 * `store`, refusing every record received whole.
 * @param store A member's store.
 * @returns The wrapped store.
 */
function refusingWholeRecords(store: EndpointStore): EndpointStore {
  return {
    ...store,
    applyCertifiedRecord: () =>
      Effect.fail(new EndpointStoreError({ reason: "conflict" })),
  };
}

/**
 * Members 1, 2 and 3 certify member 1's post, which member 4 misses.
 * @param harness Four members whose genesis is certified.
 * @param text The post's text.
 * @returns Member 1's action-certified copy of the post.
 */
function certifyAPostMember4Misses(harness: ProtocolHarness, text: string) {
  return Effect.gen(function* () {
    const author = yield* requireAt(harness.engines, 0, "endpoint engine");
    const authorIdentity = yield* requireAt(harness.identities, 0, "identity");
    const everyMemberButTheAbsent = [0, 1, 2];
    const sending = yield* Effect.fork(
      author.send(yield* sendInput(harness, text)),
    );
    yield* harness.deliver(
      yield* takeReadyBatch(harness),
      everyMemberButTheAbsent,
    );
    yield* harness.drain(everyMemberButTheAbsent);
    yield* harness.deliver(yield* takeQueued(harness), everyMemberButTheAbsent);
    yield* harness.drain(everyMemberButTheAbsent);
    const certifying = yield* takeQueued(harness);
    const authorCopy = yield* sentOfKind(
      harness,
      certifying,
      authorIdentity,
      "action_certified_record",
    );
    yield* harness.deliver(certifying, everyMemberButTheAbsent);
    yield* harness.drain(everyMemberButTheAbsent);
    yield* takeQueued(harness);
    yield* Fiber.join(sending).pipe(Effect.orDie);
    return authorCopy;
  });
}

/**
 * Restart member 4 over the store its engine wrote, unwrapped.
 * @param harness Four members.
 * @returns What member 4 sends on restart, in order.
 */
function restartMember4(harness: ProtocolHarness) {
  return Effect.gen(function* () {
    const identity = yield* requireAt(harness.identities, 3, "identity");
    const store = yield* requireAt(harness.stores, 3, "endpoint store");
    const restarted = yield* restartMember(harness, identity, store).pipe(
      Effect.orDie,
    );
    yield* restarted.drainOutbound.pipe(Effect.orDie);
    return (yield* takeQueued(harness)).filter(
      ({ senderAgentId }) => senderAgentId === identity.card.agentId,
    );
  });
}

/**
 * Members 1, 2 and 3 certify a post that member 4 misses. Member 4's acceptance
 * of member 1's whole CertifiedRecord is interrupted right after its store
 * commits the post, as a Router worker that loses its generation does. The
 * acceptance still completes, so member 4 holds the post as its head: a later
 * action-certified copy of the post is ignored and draws no durability vote.
 * @returns Completion once member 4's answer to the copy is checked.
 */
function finishesAnInterruptedAcceptanceOfARecordReceivedWhole() {
  return Effect.gen(function* () {
    const hold = {
      armed: yield* Ref.make(false),
      committed: yield* Deferred.make<undefined>(),
      release: yield* Deferred.make<undefined>(),
    };
    const harness = yield* makeProtocolHarness({
      wrapStore: (store) => holdingWholeRecordCommit(store, hold),
    });
    yield* certifyGenesis(harness);
    const authorIdentity = yield* requireAt(harness.identities, 0, "identity");
    const absentIdentity = yield* requireAt(harness.identities, 3, "identity");
    const authorCopy = yield* certifyAPostMember4Misses(
      harness,
      "accepted whole",
    );

    yield* Ref.set(hold.armed, true);
    const accepting = yield* Effect.fork(
      harness.deliver(
        [yield* certifiedRecordPacket(harness, authorIdentity)],
        [3],
      ),
    );
    yield* Deferred.await(hold.committed);
    const interrupting = yield* Effect.fork(Fiber.interrupt(accepting));
    yield* Deferred.succeed(hold.release, undefined);
    yield* Fiber.join(interrupting);
    yield* harness.drain([3]);
    yield* takeQueued(harness);
    const answer = yield* harness.deliver(authorCopy, [3]);
    yield* harness.drain([3]);
    const votes = yield* sentOfKind(
      harness,
      yield* takeQueued(harness),
      absentIdentity,
      "durability_vote",
    );

    expect(answer).toEqual(["ignored"]);
    expect(votes).toEqual([]);
  });
}

/**
 * `store`, which, once `hold.armed` is set, signals `hold.committed` after it
 * commits a record received whole and then waits for `hold.release`: the
 * point an interruption right after the commit reaches.
 * @param store A member's store.
 * @param hold The switch and the two signals of the held commit.
 * @param hold.armed Whether commits are held.
 * @param hold.committed Completed once a held commit is done.
 * @param hold.release Awaited before a held commit returns.
 * @returns The wrapped store.
 */
function holdingWholeRecordCommit(
  store: EndpointStore,
  hold: Readonly<{
    armed: Ref.Ref<boolean>;
    committed: Deferred.Deferred<undefined>;
    release: Deferred.Deferred<undefined>;
  }>,
): EndpointStore {
  return {
    ...store,
    applyCertifiedRecord: (record, delivery) =>
      store
        .applyCertifiedRecord(record, delivery)
        .pipe(
          Effect.tap(() =>
            Ref.get(hold.armed).pipe(
              Effect.flatMap((armed) =>
                armed
                  ? Deferred.succeed(hold.committed, undefined).pipe(
                      Effect.zipRight(Deferred.await(hold.release)),
                    )
                  : Effect.void,
              ),
            ),
          ),
        ),
  };
}

/**
 * Member 2 locks its own post at the genesis head while members 1, 3 and 4
 * lock and sign member 1's. Member 2's store then starts refusing every other
 * member's action signature, so its acceptance of member 1's action-certified
 * record stops right after the lock is superseded, as an interruption there
 * would leave it. When member 1's proposal then reaches member 2, member 2 sends no
 * signature for the action it adopted.
 * @returns Completion once member 2's traffic is checked.
 */
function signsNothingForAnAdoptedActionWhenAcceptanceStops() {
  return Effect.gen(function* () {
    const refusing = yield* Ref.make(false);
    const harness = yield* makeProtocolHarness({
      wrapStore: (store, identity, index) =>
        index === 1
          ? refusingPeerActionEvidence(store, identity.card.agentId, refusing)
          : store,
    });
    yield* certifyGenesis(harness);
    const winnerAuthor = yield* requireAt(
      harness.engines,
      0,
      "endpoint engine",
    );
    const winnerAuthorIdentity = yield* requireAt(
      harness.identities,
      0,
      "identity",
    );
    const lagging = yield* requireAt(harness.engines, 1, "endpoint engine");
    const laggingIdentity = yield* requireAt(harness.identities, 1, "identity");
    const winning = yield* Effect.fork(
      winnerAuthor.send(yield* sendInput(harness, "winner")),
    );
    const winnerBatch = yield* takeReadyBatch(harness);
    const winnerActionHash = yield* requireAt(
      winnerBatch,
      1,
      "winning proposal",
    ).pipe(
      Effect.flatMap((message) => decodeActionProposal(harness, message)),
      Effect.flatMap((proposal) =>
        hashAction(proposal.action).pipe(Effect.orDie),
      ),
    );
    yield* Effect.forkScoped(
      lagging.send(yield* sendInput(harness, "member 2 post")),
    );
    const loserBatch = yield* takeReadyBatch(harness);

    yield* harness.deliver(winnerBatch, [0, 2, 3]);
    yield* harness.deliver(loserBatch);
    yield* harness.drain();
    yield* harness.deliver(yield* takeQueued(harness));
    yield* harness.drain();
    const winnerCertificate = (yield* messagesOfKind(
      harness,
      yield* takeQueued(harness),
      "action_certified_record",
    )).filter(
      (message) => message.senderAgentId === winnerAuthorIdentity.card.agentId,
    );
    yield* Ref.set(refusing, true);
    const stopped = yield* harness.deliver(winnerCertificate, [1]);
    yield* harness.deliver(winnerBatch, [1]);
    yield* harness.drain([1]);
    const sent = (yield* messagesOfKind(
      harness,
      yield* takeQueued(harness),
      "action_signature",
    )).filter(
      (message) => message.senderAgentId === laggingIdentity.card.agentId,
    );
    const signedHashes = yield* Effect.forEach(
      sent,
      (message) => decodeActionSignatureHash(harness, message),
      { concurrency: 1 },
    );

    expect(stopped).toEqual(["ignored"]);
    expect(signedHashes).not.toContain(winnerActionHash);
    yield* Fiber.interrupt(winning);
  });
}

/**
 * Wraps a store so that, while `refusing` holds, it refuses as a conflict
 * every action signature another member made.
 * @param store The store to wrap.
 * @param localAgentId The member whose own signatures the store still takes.
 * @param refusing Whether the store refuses those signatures now.
 * @returns The wrapping store.
 */
function refusingPeerActionEvidence(
  store: EndpointStore,
  localAgentId: string,
  refusing: Ref.Ref<boolean>,
): EndpointStore {
  return {
    ...store,
    mergeEvidence: (evidence) =>
      Ref.get(refusing).pipe(
        Effect.flatMap((refuse) =>
          refuse &&
          evidence.kind === "action" &&
          evidence.evidenceKey !== localAgentId
            ? Effect.fail(new EndpointStoreError({ reason: "conflict" }))
            : store.mergeEvidence(evidence),
        ),
      ),
  };
}

/**
 * Members 1, 2 and 3 lock and sign member 1's post, so member 2 stages it and
 * votes for it, and its record is not yet certified there. Member 4 never saw
 * that post and locks its own at the same head, and members 1 and 3 also sign
 * member 4's, which takes more than `f` faulty members. When member 4's
 * action-certified record reaches member 2, member 2 ignores it and keeps its
 * lock: it sends nothing, so it never signs or votes for a second successor
 * of that head.
 * @returns Completion once member 2's traffic and lock are checked.
 */
function refusesASecondCertificateOverAStagedAction() {
  return Effect.gen(function* () {
    const harness = yield* makeProtocolHarness();
    yield* certifyGenesis(harness);
    const [first, staging, equivocating, fourth] = yield* Effect.all([
      requireAt(harness.identities, 0, "identity"),
      requireAt(harness.identities, 1, "identity"),
      requireAt(harness.identities, 2, "identity"),
      requireAt(harness.identities, 3, "identity"),
    ]);
    const firstEngine = yield* requireAt(harness.engines, 0, "endpoint engine");
    const fourthEngine = yield* requireAt(
      harness.engines,
      3,
      "endpoint engine",
    );
    const stagingStore = yield* requireAt(harness.stores, 1, "endpoint store");
    yield* Effect.forkScoped(
      firstEngine.send(yield* sendInput(harness, "staged post")),
    );
    const stagedBatch = yield* takeReadyBatch(harness);
    const stagedActionHash = yield* requireAt(
      stagedBatch,
      1,
      "staged proposal",
    ).pipe(
      Effect.flatMap((message) => decodeActionProposal(harness, message)),
      Effect.flatMap((proposal) =>
        hashAction(proposal.action).pipe(Effect.orDie),
      ),
    );
    yield* Effect.forkScoped(
      fourthEngine.send(yield* sendInput(harness, "second post")),
    );
    const secondBatch = yield* takeReadyBatch(harness);
    const secondActionHash = yield* requireAt(
      secondBatch,
      1,
      "second proposal",
    ).pipe(
      Effect.flatMap((message) => decodeActionProposal(harness, message)),
      Effect.flatMap((proposal) =>
        hashAction(proposal.action).pipe(Effect.orDie),
      ),
    );

    yield* harness.deliver(stagedBatch, [0, 1, 2]);
    yield* harness.deliver(secondBatch, [3]);
    yield* harness.drain();
    const signatures = yield* takeQueued(harness);
    yield* harness.deliver(signatures, [0, 1, 2, 3]);
    yield* harness.drain();
    yield* takeQueued(harness);
    const beforeRefusal = yield* stagingStore.recover().pipe(Effect.orDie);
    const staged = beforeRefusal.stagedRecords.filter(
      ({ actionHash }) => actionHash === stagedActionHash,
    );
    const ownVotes = beforeRefusal.evidence.filter(
      ({ kind, evidenceKey }) =>
        kind === "durability" && evidenceKey === staging.card.agentId,
    );
    const equivocations = yield* Effect.forEach(
      [first, equivocating],
      (signer) =>
        hostileActionSignature({
          harness,
          signer,
          actionHash: secondActionHash,
        }),
      { concurrency: 1 },
    );
    yield* harness.deliver(equivocations, [3]);
    yield* harness.drain([3]);
    const secondCertificate = (yield* messagesOfKind(
      harness,
      yield* takeQueued(harness),
      "action_certified_record",
    )).filter((message) => message.senderAgentId === fourth.card.agentId);
    const refused = yield* harness.deliver(secondCertificate, [1]);
    yield* harness.deliver(secondBatch, [1]);
    yield* harness.drain([1]);
    const sentByStaging = (yield* takeQueued(harness)).filter(
      (message) => message.senderAgentId === staging.card.agentId,
    );
    const locks = (yield* stagingStore.recover().pipe(Effect.orDie))
      .proposalLocks;

    expect(staged).toHaveLength(1);
    expect(ownVotes.map(({ subjectId }) => subjectId)).toContain(
      staged[0]?.recordHash,
    );
    expect(secondCertificate).toHaveLength(1);
    expect(refused).toEqual(["ignored"]);
    expect(sentByStaging).toEqual([]);
    expect(locks.map(({ actionHash }) => actionHash)).not.toContain(
      secondActionHash,
    );
  });
}

/**
 * Member 2 is away while member 1 proposes a post and the members sign it,
 * so it holds no fold for the post. It is back for the action-certified
 * copies and the durability votes: it stages the record from a copy, sends
 * its own copy and then its vote, certifies the record from the votes it
 * receives, and delivers the post. Fails when no member sends its copy, or
 * when a member that staged from a copy sends none of its own or sends it
 * after its vote.
 * @returns Completion once member 2 holds the post.
 */
function certifiesFromActionCertifiedCopiesAfterMissingTheSignatures() {
  return Effect.gen(function* () {
    const harness = yield* makeProtocolHarness();
    yield* certifyGenesis(harness);
    const author = yield* requireAt(harness.engines, 0, "endpoint engine");
    const returning = yield* requireAt(harness.engines, 1, "endpoint engine");
    const present = [0, 2, 3];
    const sending = yield* Effect.fork(
      author.send(yield* sendInput(harness, "missed post")),
    );

    yield* harness.deliver(yield* takeReadyBatch(harness), present);
    yield* harness.drain(present);
    yield* harness.deliver(yield* takeQueued(harness), present);
    yield* harness.drain(present);
    const delivered = yield* pump(harness, yield* takeQueued(harness));
    yield* Fiber.join(sending).pipe(Effect.orDie);

    const pending = yield* returning.readPendingMessages().pipe(Effect.orDie);
    expect(pending.map(({ message }) => message.content)).toEqual([
      [{ type: "text", text: "open group" }],
      [{ type: "text", text: "missed post" }],
    ]);
    const returningIdentity = yield* requireAt(
      harness.identities,
      1,
      "identity",
    );
    expect(
      yield* Effect.forEach(
        delivered.filter(
          ({ senderAgentId }) =>
            senderAgentId === returningIdentity.card.agentId,
        ),
        (message) => protocolMessageKind(harness, message),
        { concurrency: 1 },
      ),
    ).toEqual(["action_certified_record", "durability_vote"]);
    expect(yield* certifiedRecordCounts(harness)).toEqual([2, 2, 2, 2]);
  });
}

/**
 * Member 4 is faulty. It seals its durability vote for member 1's first post
 * so that member 3 cannot open it, and member 2's vote reaches member 3 late.
 * Member 1 certifies the post from its own vote and those of members 3 and 4,
 * and proposes its second post while member 3 holds two votes, below `q(n)`.
 * Member 4 then sends nothing for the second post, so it certifies only if
 * member 3 signs it. Member 3 can open member 1's copy of the certified first
 * post, which member 1 sends ahead of its proposal. Fails when a proposer
 * proposes without its head's certified record: member 3 drops the proposal
 * as not gap-free and the second post never certifies.
 * @returns Completion once the second post certifies.
 */
function certifiesPastAVoteSealedAwayFromOneMember() {
  return Effect.gen(function* () {
    const harness = yield* makeProtocolHarness();
    yield* certifyGenesis(harness);
    const author = yield* requireAt(harness.engines, 0, "endpoint engine");
    const [first, second, lagging, faulty] = harness.identities;
    if (
      first === undefined ||
      second === undefined ||
      lagging === undefined ||
      faulty === undefined
    ) {
      return yield* Effect.dieMessage("the harness lacks members");
    }
    const sendingFirst = yield* Effect.fork(
      author.send(yield* sendInput(harness, "first post")),
    );
    yield* harness.deliver(yield* takeReadyBatch(harness));
    yield* harness.drain();
    yield* harness.deliver(yield* takeQueued(harness));
    yield* harness.drain();
    const staged = yield* takeQueued(harness);
    yield* harness.deliver(
      yield* messagesOfKind(harness, staged, "action_certified_record"),
    );
    const vote = (member: ProtocolIdentity) =>
      sentOfKind(harness, staged, member, "durability_vote");
    const allButLagging = [0, 1, 3];
    yield* harness.deliver(
      [
        ...(yield* vote(first)),
        ...(yield* vote(lagging)),
        ...(yield* vote(faulty)),
        ...(yield* vote(second)),
      ],
      allButLagging,
    );
    yield* harness.deliver(
      [...(yield* vote(first)), ...(yield* vote(lagging))],
      [2],
    );
    yield* harness.drain();
    yield* Fiber.join(sendingFirst).pipe(Effect.orDie);

    const sendingSecond = yield* Effect.fork(
      author.send(yield* sendInput(harness, "second post")),
    );
    yield* harness.deliver(yield* takeReadyBatch(harness));
    yield* harness.drain();
    yield* harness.deliver(yield* vote(second), [2]);
    yield* harness.drain([2]);
    yield* pump(harness, yield* takeQueued(harness), faulty.card.agentId);
    yield* Fiber.join(sendingSecond).pipe(Effect.orDie);

    const laggingEngine = yield* requireAt(
      harness.engines,
      2,
      "endpoint engine",
    );
    const pending = yield* laggingEngine
      .readPendingMessages()
      .pipe(Effect.orDie);
    expect(pending.map(({ message }) => message.content)).toEqual([
      [{ type: "text", text: "open group" }],
      [{ type: "text", text: "first post" }],
      [{ type: "text", text: "second post" }],
    ]);
  });
}

function certifiesOrdinaryN4Post() {
  return Effect.gen(function* () {
    const harness = yield* makeProtocolHarness();
    yield* certifyGenesis(harness);
    const author = yield* requireAt(harness.identities, 0, "identity");
    const authorEngine = yield* requireAt(
      harness.engines,
      0,
      "endpoint engine",
    );
    const authorStore = yield* requireAt(harness.stores, 0, "endpoint store");

    const sending = yield* Effect.fork(
      authorEngine.send(yield* sendInput(harness, "ordinary post")),
    );
    const proposalBatch = yield* takeReadyBatch(harness);
    const proposals = yield* messagesOfKind(
      harness,
      proposalBatch,
      "action_proposal",
    );
    const proposalMessage = yield* requireAt(proposals, 0, "POST proposal");
    const proposal = yield* decodeActionProposal(harness, proposalMessage);
    if (proposal.action.kind !== "POST") {
      return yield* Effect.dieMessage("ordinary send did not propose POST");
    }

    yield* harness.deliver(proposalBatch);
    yield* harness.drain();
    const signatureBatch = yield* takeQueued(harness);
    const actionSignatures = yield* messagesOfKind(
      harness,
      signatureBatch,
      "action_signature",
    );
    expect(actionSignatures).toHaveLength(MEMBER_COUNT);

    yield* harness.deliver(actionSignatures.slice(0, 3));
    yield* harness.drain();
    const certificationBatch = yield* takeQueued(harness);
    const actionRecordMessages = yield* messagesOfKind(
      harness,
      certificationBatch,
      "action_certified_record",
    );
    const durabilityMessages = yield* messagesOfKind(
      harness,
      certificationBatch,
      "durability_vote",
    );
    expect(actionRecordMessages).toHaveLength(MEMBER_COUNT);
    expect(durabilityMessages).toHaveLength(MEMBER_COUNT);

    const authorActionRecordMessage = actionRecordMessages.find(
      (message) => message.senderAgentId === author.card.agentId,
    );
    if (authorActionRecordMessage === undefined) {
      return yield* Effect.dieMessage(
        "author did not assemble the POST action certificate",
      );
    }
    const actionRecord = yield* decodeActionCertifiedRecord(
      harness,
      authorActionRecordMessage,
    );
    expect(actionRecord.recordCore.action.kind).toBe(proposal.action.kind);
    expect(actionRecord.actionCertificate.signatures).toHaveLength(3);
    const actionSigners = yield* Effect.forEach(
      actionRecord.actionCertificate.signatures,
      (representation) => Schema.decodeUnknown(SignedMessage)(representation),
      { concurrency: 1 },
    ).pipe(Effect.orDie);
    expect(
      actionSigners.some(
        (signature) => signature.senderAgentId === author.card.agentId,
      ),
    ).toBe(true);

    const staged = yield* authorStore.recover().pipe(Effect.orDie);
    expect(
      staged.stagedRecords.some(
        ({ recordHash }) => recordHash === actionRecord.recordHash,
      ),
    ).toBe(true);
    expect(
      staged.certifiedRecords.some(
        ({ recordHash }) => recordHash === actionRecord.recordHash,
      ),
    ).toBe(false);
    expect(
      staged.evidence.filter(
        ({ kind, subjectId }) =>
          kind === "durability" && subjectId === actionRecord.recordHash,
      ),
    ).toHaveLength(1);

    const hostileSigner = yield* requireAt(
      harness.identities,
      3,
      "hostile signer",
    );
    const wrongConversationVote = yield* hostileDurabilityMessage({
      harness,
      signer: hostileSigner,
      recordHash: actionRecord.recordHash,
      conversationId: unrelatedConversationId,
      membershipHash: harness.membership.hash,
    });
    const wrongMembershipVote = yield* hostileDurabilityMessage({
      harness,
      signer: hostileSigner,
      recordHash: actionRecord.recordHash,
      conversationId: harness.membership.descriptor.conversationId,
      membershipHash: unrelatedMembershipHash,
    });
    expect(
      yield* harness.deliver([wrongConversationVote, wrongMembershipVote], [0]),
    ).toEqual(["ignored", "ignored"]);

    const afterHostileVotes = yield* authorStore.recover().pipe(Effect.orDie);
    expect(
      afterHostileVotes.certifiedRecords.some(
        ({ recordHash }) => recordHash === actionRecord.recordHash,
      ),
    ).toBe(false);
    expect(
      afterHostileVotes.evidence.filter(
        ({ kind, subjectId }) =>
          kind === "durability" && subjectId === actionRecord.recordHash,
      ),
    ).toHaveLength(1);

    const remoteDurabilityVotes = durabilityMessages.filter(
      (message) => message.senderAgentId !== author.card.agentId,
    );
    expect(remoteDurabilityVotes).toHaveLength(3);
    const firstRemoteVote = yield* requireAt(
      remoteDurabilityVotes,
      0,
      "remote durability vote",
    );
    const secondRemoteVote = yield* requireAt(
      remoteDurabilityVotes,
      1,
      "remote durability vote",
    );
    expect(yield* harness.deliver([firstRemoteVote], [0])).toEqual([
      "accepted",
    ]);
    const afterFirstRemoteVote = yield* authorStore
      .recover()
      .pipe(Effect.orDie);
    expect(
      afterFirstRemoteVote.certifiedRecords.some(
        ({ recordHash }) => recordHash === actionRecord.recordHash,
      ),
    ).toBe(false);

    expect(yield* harness.deliver([secondRemoteVote], [0])).toEqual([
      "accepted",
    ]);
    yield* Fiber.join(sending).pipe(Effect.orDie);
    const certified = yield* authorStore.recover().pipe(Effect.orDie);
    const storedPost = certified.certifiedRecords.find(
      ({ recordHash }) => recordHash === actionRecord.recordHash,
    );
    if (storedPost === undefined) {
      return yield* Effect.dieMessage("POST did not complete durably");
    }
    expect(storedPost.actionEvidence).toHaveLength(3);
    expect(storedPost.durabilityEvidence).toHaveLength(3);
    const storedCore = yield* decodeCanonical(
      RecordCore,
      storedPost.canonicalRecordCore,
    ).pipe(Effect.orDie);
    expect(storedCore.action.kind).toBe(actionRecord.recordCore.action.kind);
    expect(storedCore.actionHash).toBe(actionRecord.recordCore.actionHash);
  });
}

function ordersCompetingProposalsBeforeActionVotes(input: {
  readonly firstAuthorIndex: number;
  readonly secondAuthorIndex: number;
}) {
  return Effect.gen(function* () {
    const harness = yield* makeProtocolHarness();
    yield* certifyGenesis(harness);
    const firstAuthor = yield* requireAt(
      harness.engines,
      input.firstAuthorIndex,
      "endpoint engine",
    );
    const secondAuthor = yield* requireAt(
      harness.engines,
      input.secondAuthorIndex,
      "endpoint engine",
    );
    const observingStore = yield* requireAt(
      harness.stores,
      2,
      "endpoint store",
    );

    const firstSending = yield* Effect.fork(
      firstAuthor.send(yield* sendInput(harness, "first candidate")),
    );
    const firstBatch = yield* takeReadyBatch(harness);
    const firstMessage = yield* requireAt(firstBatch, 1, "first proposal");
    const firstProposal = yield* decodeActionProposal(harness, firstMessage);
    const secondSending = yield* Effect.fork(
      secondAuthor.send(yield* sendInput(harness, "second candidate")),
    );
    const secondBatch = yield* takeReadyBatch(harness);
    const secondMessage = yield* requireAt(secondBatch, 1, "second proposal");
    const secondProposal = yield* decodeActionProposal(harness, secondMessage);
    if (
      firstProposal.action.kind !== "POST" ||
      secondProposal.action.kind !== "POST"
    ) {
      return yield* Effect.dieMessage(
        "same-predecessor fixture requires two POST proposals",
      );
    }
    expect(firstProposal.action.previousRecordHash).toBe(
      secondProposal.action.previousRecordHash,
    );
    expect(firstProposal).not.toHaveProperty("authorSignature");
    expect(secondProposal).not.toHaveProperty("authorSignature");
    expect(yield* takeQueued(harness)).toEqual([]);

    expect(yield* harness.deliver([firstMessage, secondMessage])).toEqual([
      "accepted",
      "accepted",
      "accepted",
      "accepted",
      "ignored",
      "ignored",
      "ignored",
      "ignored",
    ]);
    yield* harness.drain();
    const emitted = yield* takeQueued(harness);
    const actionSignatures = yield* messagesOfKind(
      harness,
      emitted,
      "action_signature",
    );
    expect(actionSignatures).toHaveLength(MEMBER_COUNT);
    expect(
      new Set(actionSignatures.map(({ senderAgentId }) => senderAgentId)),
    ).toEqual(new Set(harness.identities.map(({ card }) => card.agentId)));
    const firstActionHash = yield* hashAction(firstProposal.action).pipe(
      Effect.orDie,
    );
    const signatureHashes = yield* Effect.forEach(
      actionSignatures,
      (message) => decodeActionSignatureHash(harness, message),
      { concurrency: 1 },
    );
    expect(new Set(signatureHashes)).toEqual(new Set([firstActionHash]));

    const recovery = yield* observingStore.recover().pipe(Effect.orDie);
    const successorLocks = recovery.proposalLocks.filter(
      ({ previousRecordHash }) =>
        previousRecordHash === firstProposal.action.previousRecordHash,
    );
    expect(successorLocks).toHaveLength(1);
    expect(successorLocks[0]?.actionHash).toBe(firstActionHash);

    yield* Fiber.interrupt(firstSending);
    yield* Fiber.interrupt(secondSending);
  });
}

/**
 * A host repeats a send with identical input once the first has certified.
 * The first invocation opens the conversation with its GENESIS and the second
 * proposes a POST at that head, and each proposal carries its own PostId.
 * Fails when identical input reuses a PostId.
 */
function givesIdenticalHostInvocationsDistinctPostIds() {
  return Effect.gen(function* () {
    const harness = yield* makeProtocolHarness();
    const author = yield* requireAt(harness.engines, 0, "endpoint engine");
    const input = yield* sendInput(harness, "repeat intentionally");

    const firstSending = yield* Effect.fork(author.send(input));
    const firstBatch = yield* takeReadyBatch(harness);
    const firstProposal = yield* requireAt(
      firstBatch,
      0,
      "first repeated proposal",
    ).pipe(Effect.flatMap((message) => decodeActionProposal(harness, message)));
    yield* pump(harness, firstBatch);
    yield* Fiber.join(firstSending).pipe(Effect.orDie);
    yield* Effect.forkScoped(author.send(input));
    const secondProposal = yield* takeReadyBatch(harness).pipe(
      Effect.flatMap((batch) =>
        requireAt(batch, 1, "second repeated proposal"),
      ),
      Effect.flatMap((message) => decodeActionProposal(harness, message)),
    );

    expect(secondProposal.action.postIntent.postId).not.toBe(
      firstProposal.action.postIntent.postId,
    );
  });
}

function retainsInterruptedDurableSend() {
  return Effect.gen(function* () {
    const queueEntered = yield* Deferred.make<undefined>();
    const releaseQueue = yield* Deferred.make<undefined>();
    const harness = yield* makeProtocolHarness({
      wrapStore: (store) => ({
        ...store,
        enqueueOutbound: (input) =>
          Deferred.succeed(queueEntered, undefined).pipe(
            Effect.zipRight(Deferred.await(releaseQueue)),
            Effect.zipRight(store.enqueueOutbound(input)),
          ),
      }),
    });
    const author = yield* requireAt(harness.engines, 0, "endpoint engine");
    const sending = yield* Effect.fork(
      author.send(yield* sendInput(harness, "retained send")),
    );
    yield* Deferred.await(queueEntered);
    const interrupting = yield* Effect.fork(Fiber.interrupt(sending));
    yield* Effect.yieldNow();
    yield* Deferred.succeed(releaseQueue, undefined);
    yield* Fiber.join(interrupting);

    yield* author.drainOutbound.pipe(Effect.orDie);
    const proposal = yield* takeReadyBatch(harness).pipe(
      Effect.flatMap((messages) => requireAt(messages, 0, "retained proposal")),
      Effect.flatMap((message) => decodeActionProposal(harness, message)),
    );
    expect(proposal.action.postIntent.content).toEqual([
      { type: "text", text: "retained send" },
    ]);
  });
}

/** Whether an outer body decodes as a Client value without opening it. */
function readsAsPlaintext(
  message: typeof SignedMessage.Type,
): Effect.Effect<boolean> {
  return decodeCanonical(DirectPacket, message.body).pipe(
    Effect.orElse(() => decodeCanonical(SignedMessage, message.body)),
    Effect.match({ onFailure: () => false, onSuccess: () => true }),
  );
}

/**
 * A first post among `memberCount` members certifies at every member while
 * each member opens every outer body with its own key, and no body on the
 * wire reads as plaintext.
 */
function sealsEveryOuterBodyOfAPost(memberCount: number) {
  return Effect.gen(function* () {
    const harness = yield* makeProtocolHarness({ memberCount });
    const author = yield* requireAt(harness.engines, 0, "endpoint engine");
    const sending = yield* Effect.fork(
      author.send(yield* sendInput(harness, "sealed post")),
    );

    const delivered = yield* pump(harness, yield* takeReadyBatch(harness));
    yield* Fiber.join(sending).pipe(Effect.orDie);

    expect(yield* certifiedRecordCounts(harness)).toEqual(
      harness.identities.map(() => 1),
    );
    expect(delivered.length).toBeGreaterThan(memberCount);
    expect(
      yield* Effect.forEach(delivered, readsAsPlaintext, {
        concurrency: 1,
      }),
    ).toEqual(delivered.map(() => false));
  });
}

// @agent-code-guard/regression-only: These stateful traces exercise durable quorum and interruption boundaries across real endpoint engines.
function sendReturnsTheStoredCertifiedRecordHash() {
  return Effect.gen(function* () {
    const harness = yield* makeProtocolHarness();
    const recordHash = yield* certifyGenesis(harness);
    const authorStore = yield* requireAt(harness.stores, 0, "store");

    const recovery = yield* authorStore.recover().pipe(Effect.orDie);

    expect(
      recovery.postIntents.map((intent) => intent.completedRecordHash),
    ).toEqual([recordHash]);
  });
}

function pendingDeliveryCarriesTheCertifiedRecordHash() {
  return Effect.gen(function* () {
    const harness = yield* makeProtocolHarness();
    const recordHash = yield* certifyGenesis(harness);
    const member = yield* requireAt(harness.engines, 1, "endpoint engine");

    const pending = yield* member.readPendingMessages().pipe(Effect.orDie);

    expect(pending.map((message) => message.recordHash)).toEqual([recordHash]);
  });
}

/**
 * A sender whose retry finds its first copy evicted resends the same outer
 * message under the same MessageId, and Router appends it again. Here every
 * member receives the proposal a second time mid-exchange and the whole
 * exchange a second time after certification, and still holds one post.
 */
function reappendedOuterMessagesYieldOnePost() {
  return Effect.gen(function* () {
    const harness = yield* makeProtocolHarness();
    const genesisHash = yield* certifyGenesis(harness);
    const author = yield* requireAt(harness.engines, 0, "endpoint engine");
    const sending = yield* Effect.fork(
      author.send(yield* sendInput(harness, "appended twice")),
    );
    const proposalBatch = yield* takeReadyBatch(harness);
    yield* harness.deliver(proposalBatch);
    yield* harness.drain();
    const transcript = yield* pump(harness, [
      ...proposalBatch,
      ...(yield* takeQueued(harness)),
    ]);
    const sent = yield* Fiber.join(sending).pipe(Effect.orDie);

    yield* pump(harness, transcript);

    expect(yield* certifiedRecordCounts(harness)).toEqual([2, 2, 2, 2]);
    const pending = yield* Effect.forEach(
      harness.engines.slice(1),
      (engine) => engine.readPendingMessages().pipe(Effect.orDie),
      { concurrency: 1 },
    );
    expect(
      pending.map((messages) => messages.map((message) => message.recordHash)),
    ).toEqual([
      [genesisHash, sent.recordHash],
      [genesisHash, sent.recordHash],
      [genesisHash, sent.recordHash],
    ]);
  });
}

/** A lossless N4 POST spends the specified traffic budget without sending its completed record. */
function postTrafficMatchesTheSpec() {
  return Effect.gen(function* () {
    const harness = yield* makeProtocolHarness();
    const predecessor = yield* certifyGenesis(harness);
    const author = yield* requireAt(harness.engines, 0, "endpoint engine");
    const sending = yield* Effect.fork(
      author.send(yield* sendInput(harness, "counted post")),
    );
    const messages = yield* pump(harness, yield* takeReadyBatch(harness));
    yield* Fiber.join(sending).pipe(Effect.orDie);
    yield* harness.drain();
    expect(yield* takeQueued(harness)).toEqual([]);
    const kinds = yield* Effect.forEach(
      messages,
      (message) => protocolMessageKind(harness, message),
      { concurrency: 1 },
    );
    expect(
      kinds.slice().sort((left, right) => left.localeCompare(right)),
    ).toEqual([
      "action_certified_record",
      "action_certified_record",
      "action_certified_record",
      "action_certified_record",
      "action_proposal",
      "action_signature",
      "action_signature",
      "action_signature",
      "action_signature",
      "certified_record",
      "durability_vote",
      "durability_vote",
      "durability_vote",
      "durability_vote",
    ]);
    expect(kinds.indexOf("certified_record")).toBeLessThan(
      kinds.indexOf("action_proposal"),
    );
    expect(messages).toHaveLength(2 + 3 * MEMBER_COUNT);
    const headCopies = yield* messagesOfKind(
      harness,
      messages,
      "certified_record",
    );
    const headCopy = yield* requireAt(headCopies, 0, "predecessor record");
    expect(yield* openAsSender(harness, headCopy)).toMatchObject({
      kind: "direct",
      packet: {
        kind: "certified_record",
        actionCertifiedRecord: { recordHash: predecessor },
      },
    });
    expect(yield* certifiedRecordCounts(harness)).toEqual([2, 2, 2, 2]);
  });
}

describe("fixed-post endpoint protocol", () => {
  itOnTestClock(
    "spends 2 + 3n outer messages on an N4 POST, with only its predecessor certified record",
    postTrafficMatchesTheSpec,
    TEST_TIMEOUT_MS,
  );
  it.each([2, 4])(
    "seals every outer body of a %i-member post to its members, each of which opens it",
    sealsEveryOuterBodyOfAPost,
    TEST_TIMEOUT_MS,
  );
  itOnTestClock(
    "certifies from the action-certified copies a post whose signatures a member missed, sending its own copy first",
    certifiesFromActionCertifiedCopiesAfterMissingTheSignatures,
    TEST_TIMEOUT_MS,
  );
  it(
    "certifies a post past a durability vote a faulty member sealed away from one member",
    certifiesPastAVoteSealedAwayFromOneMember,
    TEST_TIMEOUT_MS,
  );
  it(
    "adopts an action certificate over its own lock at the same head",
    adoptsAnActionCertificateOverItsOwnLock,
    TEST_TIMEOUT_MS,
  );
  it(
    "adopts a certified record over its own lock at the same head",
    adoptsACertifiedRecordOverItsOwnLock,
    TEST_TIMEOUT_MS,
  );
  it(
    "signs no durability vote on restart for a record it accepted already certified",
    restartSignsNoVoteForARecordAcceptedWhole,
    TEST_TIMEOUT_MS,
  );
  it(
    "sends its own copy before its vote on restart for a record received whole that its store refused",
    restartSendsItsCopyBeforeVotingForARecordItsStoreRefused,
    TEST_TIMEOUT_MS,
  );
  it(
    "stages from a later copy, sending its own copy before its vote, a record received whole that its store refused",
    stagesFromALaterCopyARecordItsStoreRefusedWhole,
    TEST_TIMEOUT_MS,
  );
  it(
    "finishes an interrupted acceptance of a record received whole, so a later copy of it draws no durability vote",
    finishesAnInterruptedAcceptanceOfARecordReceivedWhole,
    TEST_TIMEOUT_MS,
  );
  it(
    "signs nothing for an adopted action when its record's acceptance stops",
    signsNothingForAnAdoptedActionWhenAcceptanceStops,
    TEST_TIMEOUT_MS,
  );
  it(
    "refuses a second action certificate over an action it staged",
    refusesASecondCertificateOverAStagedAction,
    TEST_TIMEOUT_MS,
  );
  it(
    "returns the hash of the send's locally stored certified record",
    sendReturnsTheStoredCertifiedRecordHash,
    TEST_TIMEOUT_MS,
  );
  it(
    "reads a pending delivery with the hash of its certified record",
    pendingDeliveryCarriesTheCertifiedRecordHash,
    TEST_TIMEOUT_MS,
  );
  it(
    "mints a distinct PostId for each identical host invocation",
    givesIdenticalHostInvocationsDistinctPostIds,
    TEST_TIMEOUT_MS,
  );
  it(
    "certifies an author-inclusive N4 POST only after an independent durability quorum",
    certifiesOrdinaryN4Post,
    TEST_TIMEOUT_MS,
  );
  it.each([
    {
      outcome: "fails to restart as persistence",
      binding: "another conversation",
      bind: (membership: VerifiedMembership): DurabilityBinding => ({
        conversationId: unrelatedConversationId,
        membershipHash: membership.hash,
      }),
      filedUnder: 3,
      restart: new EngineInitializationError({ reason: "persistence" }),
    },
    {
      outcome: "fails to restart as persistence",
      binding: "another membership",
      bind: (membership: VerifiedMembership): DurabilityBinding => ({
        conversationId: membership.descriptor.conversationId,
        membershipHash: unrelatedMembershipHash,
      }),
      filedUnder: 3,
      restart: new EngineInitializationError({ reason: "persistence" }),
    },
    {
      outcome: "fails to restart as persistence",
      binding:
        "its own conversation and membership, filed under another member",
      bind: (membership: VerifiedMembership): DurabilityBinding => ({
        conversationId: membership.descriptor.conversationId,
        membershipHash: membership.hash,
      }),
      filedUnder: 2,
      restart: new EngineInitializationError({ reason: "persistence" }),
    },
    {
      outcome: "restarts",
      binding: "its own conversation and membership",
      bind: (membership: VerifiedMembership): DurabilityBinding => ({
        conversationId: membership.descriptor.conversationId,
        membershipHash: membership.hash,
      }),
      filedUnder: 3,
      restart: "started",
    },
  ])(
    "$outcome over a persisted durability vote bound to $binding",
    ({ bind, filedUnder, restart }) =>
      Effect.gen(function* () {
        const restarted = yield* restartOverPersistedDurabilityVote(
          bind,
          filedUnder,
        );

        expect(restarted).toStrictEqual(restart);
      }),
    TEST_TIMEOUT_MS,
  );
  it(
    "creates no action vote before ordering concurrent authors",
    () =>
      ordersCompetingProposalsBeforeActionVotes({
        firstAuthorIndex: 0,
        secondAuthorIndex: 1,
      }),
    TEST_TIMEOUT_MS,
  );
  itOnTestClock(
    "creates no action vote before ordering concurrent sends by one author",
    () =>
      ordersCompetingProposalsBeforeActionVotes({
        firstAuthorIndex: 0,
        secondAuthorIndex: 0,
      }),
    TEST_TIMEOUT_MS,
  );
  it(
    "retains a durably bound send when its caller is interrupted",
    retainsInterruptedDurableSend,
    TEST_TIMEOUT_MS,
  );
  it(
    "holds one post when Router appends its outer messages twice",
    reappendedOuterMessagesYieldOnePost,
    TEST_TIMEOUT_MS,
  );
});

/** Both foundations exist before either peer observes the other's GENESIS. */
function concurrentFirstSends(firstVersion: string, secondVersion: string) {
  return Effect.gen(function* () {
    const harness = yield* makeProtocolHarness({
      memberCount: 2,
      emittedVersions: [firstVersion, secondVersion],
    });
    const first = yield* requireAt(harness.engines, 0, "first engine");
    const second = yield* requireAt(harness.engines, 1, "second engine");
    const input = yield* sendInput(harness, "concurrent first send");
    const firstSend = yield* Effect.fork(first.send(input));
    const firstBatch = yield* takeReadyBatch(harness);
    const secondSend = yield* Effect.fork(second.send(input));
    const secondBatch = yield* takeReadyBatch(harness);
    const left = yield* requireAt(firstBatch, 0, "first GENESIS").pipe(
      Effect.flatMap((message) => decodeActionProposal(harness, message)),
    );
    const right = yield* requireAt(secondBatch, 0, "second GENESIS").pipe(
      Effect.flatMap((message) => decodeActionProposal(harness, message)),
    );
    if (left.action.kind !== "GENESIS" || right.action.kind !== "GENESIS") {
      return yield* Effect.dieMessage("both first sends must propose GENESIS");
    }
    expect(left.action.membership).toEqual(right.action.membership);
    expect(left.action.anchor).toEqual(right.action.anchor);
    expect(yield* harness.deliver(firstBatch)).toEqual([
      "accepted",
      "accepted",
    ]);
    yield* harness.deliver(secondBatch);
    yield* harness.drain();
    yield* pump(harness, yield* takeQueued(harness));
    yield* Fiber.join(firstSend).pipe(Effect.orDie);
    yield* Fiber.join(secondSend).pipe(Effect.orDie);
    const recoveries = yield* Effect.forEach(
      harness.stores,
      (store) => store.recover().pipe(Effect.orDie),
      { concurrency: 1 },
    );
    expect(recoveries[0]?.certifiedRecords).toEqual(
      recoveries[1]?.certifiedRecords,
    );
    expect(yield* certifiedRecordCounts(harness)).toEqual([2, 2]);
  }).pipe(
    Effect.provideService(WireVersions, {
      emitted: WIRE_VERSION,
      live: [WIRE_VERSION, "2099.101.1"],
      history: [WIRE_VERSION, "2099.101.1"],
    }),
    Effect.provide(NodeFileSystem.layer),
  );
}

/* eslint-enable max-lines, max-lines-per-function, max-statements, sonarjs/max-lines-per-function -- Restore repository defaults. */

/**
 * Virtual time short of `ATTACH_BOUND`, so a send still waiting for the
 * worker to attach is pending.
 */
const WITHIN_ATTACH_BOUND = Duration.seconds(30);

/**
 * The send's Router-attachment bound, after which it fails, mirroring the
 * private `send.ts → ROUTER_ATTACH_TIMEOUT`.
 */
const ATTACH_BOUND = Duration.seconds(45);

function sendHeldUntilAttached(): Effect.Effect<void, never, Scope.Scope> {
  return Effect.gen(function* () {
    const attached = yield* Deferred.make<RouterTailAnchor>();
    const harness = yield* makeProtocolHarness({
      attachment: attachesWhenResolved(attached),
    });
    const author = yield* requireAt(harness.engines, 0, "endpoint engine");
    const sending = yield* Effect.fork(
      author.send(yield* sendInput(harness, "open group")),
    );
    yield* advanceClock(WITHIN_ATTACH_BOUND);
    expect(yield* Fiber.poll(sending)).toEqual(Option.none());
    expect(yield* Queue.size(harness.outbound)).toBe(0);

    yield* Deferred.succeed(attached, { routerInstanceId, pollCursor });
    yield* certifyGenesisOf(harness, sending);
  });
}

/**
 * A send whose worker never attaches queues nothing, so it fails with
 * `network-unavailable` rather than `delivery-pending`.
 */
function sendFailsAfterAttachBound(): Effect.Effect<void, never, Scope.Scope> {
  return Effect.gen(function* () {
    const harness = yield* makeProtocolHarness({ attachment: neverAttaches });
    const author = yield* requireAt(harness.engines, 0, "endpoint engine");
    const sending = yield* Effect.fork(
      author.send(yield* sendInput(harness, "never attached")),
    );

    yield* advanceClock(ATTACH_BOUND);

    expect(
      yield* Fiber.join(sending).pipe(Effect.flip, Effect.orDie),
    ).toStrictEqual(new SendError({ reason: "network-unavailable" }));
  });
}

/**
 * A worker reaches `active` only after a recovery that abandons the engine's
 * volatile folds under the engine gate. A wait holding that gate would stall
 * the attachment it waits for, so the abandon must complete while the send is
 * still parked.
 */
function attachmentWaitLeavesTheEngineGateFree(): Effect.Effect<
  void,
  never,
  Scope.Scope
> {
  return Effect.gen(function* () {
    const attached = yield* Deferred.make<RouterTailAnchor>();
    const harness = yield* makeProtocolHarness({
      attachment: attachesWhenResolved(attached),
    });
    const author = yield* requireAt(harness.engines, 0, "endpoint engine");
    const sending = yield* Effect.fork(
      author.send(yield* sendInput(harness, "open group")),
    );
    yield* advanceClock(WITHIN_ATTACH_BOUND);
    expect(yield* Fiber.poll(sending)).toEqual(Option.none());

    const abandoning = yield* author
      .abandonVolatileFolds("router_restarted")
      .pipe(Effect.timeout("2 seconds"), Effect.fork);
    yield* advanceClock(Duration.seconds(2));
    yield* Fiber.join(abandoning).pipe(Effect.orDie);
    yield* Fiber.interrupt(sending);
  });
}

describe("engine sends and Router-worker attachment", () => {
  itOnTestClock(
    "holds a send issued before the worker attaches and completes it on attachment",
    sendHeldUntilAttached,
    TEST_TIMEOUT_MS,
  );

  itOnTestClock(
    "fails a send as network-unavailable once the attachment bound elapses",
    sendFailsAfterAttachBound,
    TEST_TIMEOUT_MS,
  );

  itOnTestClock(
    "waits for attachment without holding the engine gate recovery needs",
    attachmentWaitLeavesTheEngineGateFree,
    TEST_TIMEOUT_MS,
  );
});

/**
 * Forks `runOutbound` the way a host supervises it: any cause other than
 * interruption completes `fatal`, so a case that expects the loop to
 * survive asserts `fatal` stays empty.
 */
function superviseOutbound(
  engine: EndpointEngine,
  fatal: Deferred.Deferred<never, EngineOutboundError>,
) {
  return engine.runOutbound.pipe(
    Effect.catchAllCause((cause) =>
      Cause.isInterruptedOnly(cause)
        ? Effect.failCause(cause)
        : Deferred.failCause(fatal, cause).pipe(Effect.zipRight(Effect.never)),
    ),
    Effect.interruptible,
    Effect.forkScoped,
  );
}

/** Transmits a transient failure fails before its worker forwards again. */
const FAILED_TRANSMITS = 10;

/**
 * Virtual time for a background drain to work through every failed transmit:
 * the backoff reaches its 5 s cap well before `FAILED_TRANSMITS` attempts.
 */
const OUTAGE_SPAN = Duration.minutes(1);

/**
 * Fails the first `FAILED_TRANSMITS` transmits with `failure`, then forwards.
 * @param failure Worker failure each early transmit reports.
 * @param attempts Counts every transmit.
 * @returns A transmit wrapper for the scripted worker.
 */
function failsThenForwards(
  failure: RouterWorkerSendError,
  attempts: Ref.Ref<number>,
): WrapSend {
  return (forward) => (messageId) =>
    Ref.getAndUpdate(attempts, (count) => count + 1).pipe(
      Effect.flatMap((count) =>
        count < FAILED_TRANSMITS ? Effect.fail(failure) : forward(messageId),
      ),
    );
}

/**
 * The distinct action hashes each post was proposed under, across envelopes.
 * @param harness Members whose keys open the envelopes.
 * @param messages Forwarded action-proposal envelopes.
 * @returns For each PostId, the set of proposed action hashes.
 */
function proposalHashesByPost(
  harness: Pick<ProtocolHarness, "identities">,
  messages: ReadonlyArray<typeof SignedMessage.Type>,
): Effect.Effect<Map<string, Set<string>>> {
  return Effect.reduce(
    messages,
    new Map<string, Set<string>>(),
    (byPost, message) =>
      decodeActionProposal(harness, message).pipe(
        Effect.flatMap((proposal) =>
          hashAction(proposal.action).pipe(
            Effect.orDie,
            Effect.map((hash) => {
              const postId = proposal.action.postIntent.postId;
              byPost.set(postId, (byPost.get(postId) ?? new Set()).add(hash));
              return byPost;
            }),
          ),
        ),
      ),
  );
}

/**
 * Asserts the background drain outlived every failed transmit, forwarded
 * each envelope once, and proposed the scenario's one post under exactly one
 * action hash.
 * @param harness Harness whose Router queue receives forwarded envelopes.
 * @param attempts Transmit count from `failsThenForwards`.
 * @param fatal The supervised outbound loop's failure signal.
 * @returns Completion after the assertions.
 */
function expectDrainedAlive(
  harness: ProtocolHarness,
  attempts: Ref.Ref<number>,
  fatal: Deferred.Deferred<never, EngineOutboundError>,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    expect(yield* Ref.get(attempts)).toBeGreaterThan(FAILED_TRANSMITS);
    const delivered = Array.from(yield* Queue.takeAll(harness.outbound));
    expect(delivered.length).toBeGreaterThan(0);
    expect(new Set(delivered.map(({ messageId }) => messageId)).size).toBe(
      delivered.length,
    );
    const hashesByPost = yield* proposalHashesByPost(
      harness,
      yield* messagesOfKind(harness, delivered, "action_proposal"),
    );
    expect(Array.from(hashesByPost.values(), (hashes) => hashes.size)).toEqual([
      1,
    ]);
    expect(yield* Deferred.poll(fatal)).toEqual(Option.none());
  });
}

/**
 * Router restart while a send drains: the worker was attached for the send's
 * probe, then its transmits observe a transient worker state for longer than
 * any bounded retry would allow before the background drain delivers.
 */
function transientTransmitFailureLeavesOutboundLoopAlive(
  failure: RouterWorkerSendError,
): Effect.Effect<void, never, Scope.Scope> {
  return Effect.gen(function* () {
    const attempts = yield* Ref.make(0);
    const harness = yield* makeProtocolHarness({
      authorSend: failsThenForwards(failure, attempts),
    });
    const author = yield* requireAt(harness.engines, 0, "endpoint engine");
    const fatal = yield* Deferred.make<never, EngineOutboundError>();
    yield* superviseOutbound(author, fatal);
    const sendResult = yield* author
      .send(yield* sendInput(harness, "router restarts mid-drain"))
      .pipe(Effect.flip, Effect.orDie);
    expect(sendResult).toStrictEqual(
      new SendError({ reason: "delivery-pending" }),
    );
    yield* advanceClock(OUTAGE_SPAN);
    yield* expectDrainedAlive(harness, attempts, fatal);
  });
}

/**
 * Engine cold start with a durable pending outbound row: the restarted
 * worker has not attached yet, as a real worker starts out recovering, while
 * the engine already holds the row for its outbound loop. The loop waits, and
 * once the worker attaches it outlasts every failed transmit and delivers the
 * row.
 * The restarted engine also re-proposes the unfinished post, so the one
 * proposal goes out twice in two envelopes with distinct message ids; peers
 * de-duplicate it by action hash, which the assertions pin as one per post.
 */
function coldStartWithPendingOutboundLeavesOutboundLoopAlive(): Effect.Effect<
  void,
  never,
  Scope.Scope
> {
  return Effect.gen(function* () {
    const harness = yield* makeProtocolHarness({
      authorSend: () => () => Effect.fail(new RouterWorkerUnavailableError()),
    });
    const author = yield* requireAt(harness.engines, 0, "endpoint engine");
    yield* author
      .send(yield* sendInput(harness, "left pending before restart"))
      .pipe(Effect.flip, Effect.orDie);
    const identity = yield* requireAt(harness.identities, 0, "identity");
    const store = yield* requireAt(harness.stores, 0, "endpoint store");
    const attached = yield* Deferred.make<RouterTailAnchor>();
    const attempts = yield* Ref.make(0);
    const restarted = yield* makeEndpointEngine({
      localAgentCard: identity.card,
      signingAuthority: identity.authority,
      registrySignerPublicKey: harness.registrySignerPublicKey,
      registry: harness.registry,
      store,
      reportStorageFault: () => Effect.void,
      routerWorker: scriptedRouterWorker(
        store,
        harness.outbound,
        attachesWhenResolved(attached),
        failsThenForwards(new RouterWorkerUnavailableError(), attempts),
      ),
    }).pipe(Effect.orDie);
    const fatal = yield* Deferred.make<never, EngineOutboundError>();
    yield* superviseOutbound(restarted, fatal);
    yield* advanceClock(OUTAGE_SPAN);
    expect(yield* Ref.get(attempts)).toBe(0);
    expect(yield* Deferred.poll(fatal)).toEqual(Option.none());

    yield* Deferred.succeed(attached, { routerInstanceId, pollCursor });
    yield* advanceClock(OUTAGE_SPAN);
    yield* expectDrainedAlive(harness, attempts, fatal);
  });
}

/**
 * Starts the first transmit and never finishes it, as a Router that drops
 * packets without a reset after the outbox row has begun; every later
 * transmit forwards.
 * @param transmits Counts every transmit.
 * @param store The author's store, known once the harness exists.
 * @returns A transmit wrapper for the scripted worker.
 */
function blackHolesFirstTransmit(
  transmits: Ref.Ref<number>,
  store: Deferred.Deferred<EndpointStore>,
): WrapSend {
  const beginThenHang = (messageId: string) =>
    Deferred.await(store).pipe(
      Effect.flatMap((author) => author.beginOutbound(messageId)),
      Effect.orDie,
      Effect.zipRight(Effect.never),
    );
  const transmitOnce =
    (forward: EngineRouterPort["send"], messageId: string) => (count: number) =>
      count === 0 ? beginThenHang(messageId) : forward(messageId);
  return (forward) => (messageId) =>
    Ref.getAndUpdate(transmits, (count) => count + 1).pipe(
      Effect.flatMap(transmitOnce(forward, messageId)),
    );
}

/**
 * The local send's drain bound, after which it fails as `delivery-pending`,
 * mirroring the private `index.ts → LOCAL_DRAIN_TIMEOUT`.
 */
const DRAIN_BOUND = Duration.seconds(10);

/**
 * A black-holed transmit holds the local send's drain: the send is still
 * pending one second short of `DRAIN_BOUND` and fails as `delivery-pending`
 * one second past it. The background drain then delivers the envelope the
 * interrupted transmit left begun, exactly once however often the queue
 * drains afterwards. No member signs the proposal, so the author also resends
 * it meanwhile, each time in a new envelope.
 */
function blackHoledTransmitBoundsTheSend(): Effect.Effect<
  void,
  never,
  Scope.Scope
> {
  return Effect.gen(function* () {
    const transmits = yield* Ref.make(0);
    const authorStore = yield* Deferred.make<EndpointStore>();
    const harness = yield* makeProtocolHarness({
      authorSend: blackHolesFirstTransmit(transmits, authorStore),
    });
    const store = yield* requireAt(harness.stores, 0, "endpoint store");
    yield* Deferred.succeed(authorStore, store);
    const author = yield* requireAt(harness.engines, 0, "endpoint engine");
    const fatal = yield* Deferred.make<never, EngineOutboundError>();
    const sending = yield* Effect.fork(
      author.send(yield* sendInput(harness, "black-holed transmit")),
    );
    yield* untilLive(Ref.get(transmits).pipe(Effect.map((count) => count > 0)));
    const [held] = (yield* store.recover().pipe(Effect.orDie)).outboundMessages;
    if (held === undefined) {
      return yield* Effect.dieMessage(
        "the black-holed envelope was not stored",
      );
    }
    yield* advanceClock(Duration.subtract(DRAIN_BOUND, Duration.seconds(1)));
    expect(yield* Fiber.poll(sending)).toEqual(Option.none());
    yield* advanceClock(Duration.seconds(2));
    expect(
      yield* Fiber.join(sending).pipe(Effect.flip, Effect.orDie),
    ).toStrictEqual(new SendError({ reason: "delivery-pending" }));
    yield* superviseOutbound(author, fatal);
    yield* advanceClock(Duration.seconds(1));
    yield* author.drainOutbound.pipe(Effect.orDie);
    const delivered = yield* Queue.takeAll(harness.outbound);
    expect(
      [...delivered].filter((message) => message.messageId === held.messageId),
    ).toHaveLength(1);
    expect(
      (yield* store.recover().pipe(Effect.orDie)).outboundMessages,
    ).toEqual([]);
    expect(yield* Deferred.poll(fatal)).toEqual(Option.none());
  });
}

/** Where a transmit forwards to, known once the harness exists. */
interface ForwardTarget {
  readonly store: EndpointStore;
  readonly outbound: Queue.Queue<typeof SignedMessage.Type>;
}

/**
 * A transmit held until the test releases it, one transmit at a time as the
 * real worker sends. A transmit that waits for a completed row finds it
 * inactive and forwards nothing.
 * @param transmits Counts every worker send attempt.
 * @param target Store and Router queue, once the harness exists.
 * @param release Completes when both drains have attempted the held row.
 * @returns A transmit wrapper for the scripted worker.
 */
function serializedHeldTransmit(
  transmits: Ref.Ref<number>,
  target: Deferred.Deferred<ForwardTarget>,
  release: Deferred.Deferred<undefined>,
) {
  const transmitUnder =
    (recoveryGate: Effect.Semaphore) => (messageId: string) =>
      Ref.update(transmits, (count) => count + 1).pipe(
        Effect.zipRight(Deferred.await(target)),
        Effect.flatMap(({ store, outbound }) =>
          recoveryGate.withPermits(1)(
            Deferred.await(release).pipe(
              Effect.zipRight(
                forwardStoredOutbound(store, outbound, messageId),
              ),
            ),
          ),
        ),
      );
  return Effect.makeSemaphore(1).pipe(
    Effect.map(
      (recoveryGate): WrapSend =>
        () =>
          transmitUnder(recoveryGate),
    ),
  );
}

/**
 * A local send's drain and the background drain run at once over the same
 * queue head. Both attempt it, and the outbox row still goes out once. The
 * first transmit holds the worker gate until the second attempts the same
 * row. Releasing it and awaiting a drain settles both attempts without
 * advancing the clock into an uncertified proposal's resend schedule.
 */
function concurrentDrainsSendEachOutboxOnce(): Effect.Effect<
  void,
  never,
  Scope.Scope
> {
  return Effect.gen(function* () {
    const transmits = yield* Ref.make(0);
    const target = yield* Deferred.make<ForwardTarget>();
    const release = yield* Deferred.make<undefined>();
    const harness = yield* makeProtocolHarness({
      authorSend: yield* serializedHeldTransmit(transmits, target, release),
    });
    const author = yield* requireAt(harness.engines, 0, "endpoint engine");
    const store = yield* requireAt(harness.stores, 0, "endpoint store");
    yield* Deferred.succeed(target, { store, outbound: harness.outbound });
    const fatal = yield* Deferred.make<never, EngineOutboundError>();
    yield* superviseOutbound(author, fatal);
    const sending = yield* Effect.fork(
      author.send(yield* sendInput(harness, "drained twice at once")),
    );
    yield* untilLive(
      Ref.get(transmits).pipe(Effect.map((count) => count >= 2)),
    );
    const [held] = (yield* store.recover().pipe(Effect.orDie)).outboundMessages;
    if (held === undefined) {
      return yield* Effect.dieMessage("the raced envelope was not stored");
    }
    yield* Deferred.succeed(release, undefined);
    yield* author.drainOutbound.pipe(Effect.orDie);
    yield* author.drainOutbound.pipe(Effect.orDie);
    const delivered = yield* Queue.takeAll(harness.outbound);
    expect([...delivered].map((message) => message.messageId)).toEqual([
      held.messageId,
    ]);
    expect(
      (yield* store.recover().pipe(Effect.orDie)).outboundMessages,
    ).toEqual([]);
    expect(yield* Deferred.poll(fatal)).toEqual(Option.none());
    yield* Fiber.interrupt(sending);
  });
}

const outageAnchor = { routerInstanceId, pollCursor };

function anchorWhile(
  attached: SubscriptionRef.SubscriptionRef<boolean>,
): WorkerAttachment {
  return {
    currentAnchor: SubscriptionRef.get(attached).pipe(
      Effect.flatMap((up) =>
        up
          ? Effect.succeed(outageAnchor)
          : Effect.fail(new RouterWorkerUnavailableError()),
      ),
    ),
    awaitAnchor: attached.changes.pipe(
      Stream.filter((up) => up),
      Stream.runHead,
      Effect.as(outageAnchor),
    ),
  };
}

function transmitWhile(
  attached: SubscriptionRef.SubscriptionRef<boolean>,
  armed: Ref.Ref<boolean>,
  forward: EngineRouterPort["send"],
  messageId: string,
) {
  return Ref.getAndSet(armed, false).pipe(
    Effect.flatMap((first) =>
      first ? SubscriptionRef.set(attached, false) : Effect.void,
    ),
    Effect.zipRight(SubscriptionRef.get(attached)),
    Effect.flatMap((up) =>
      up ? forward(messageId) : Effect.fail(new RouterWorkerUnavailableError()),
    ),
  );
}

/**
 * A worker attached at the send's probe that detaches on its first transmit,
 * as when the poll loop loses the Router mid-send, and reattaches when told.
 */
function detachesOnFirstTransmit(
  attached: SubscriptionRef.SubscriptionRef<boolean>,
) {
  return Ref.make(true).pipe(
    Effect.map(
      (armed): HarnessOptions => ({
        attachment: anchorWhile(attached),
        authorSend: (forward) => (messageId) =>
          transmitWhile(attached, armed, forward, messageId),
      }),
    ),
  );
}

/**
 * What a host sees when the Router drops during its send: the send fails
 * promptly with `delivery-pending`, whose text says the post is queued,
 * the outbound loop stays up, and the durably queued envelope goes out and
 * certifies once the worker re-anchors.
 */
function localSendDuringOutage(): Effect.Effect<void, never, Scope.Scope> {
  return Effect.gen(function* () {
    const attached = yield* SubscriptionRef.make(true);
    const worker = yield* detachesOnFirstTransmit(attached);
    const harness = yield* makeProtocolHarness(worker);
    const author = yield* requireAt(harness.engines, 0, "endpoint engine");
    const fatal = yield* Deferred.make<never, EngineOutboundError>();
    yield* superviseOutbound(author, fatal);

    const failure = yield* author
      .send(yield* sendInput(harness, "sent during outage"))
      .pipe(Effect.flip, Effect.orDie);
    expect(failure).toStrictEqual(
      new SendError({ reason: "delivery-pending" }),
    );
    yield* advanceClock(OUTAGE_SPAN);
    expect(yield* Queue.size(harness.outbound)).toBe(0);
    expect(yield* Deferred.poll(fatal)).toEqual(Option.none());

    yield* SubscriptionRef.set(attached, true);
    yield* advanceClock(Duration.seconds(10));
    yield* pump(harness, yield* takeReadyBatch(harness));
    expect(yield* certifiedRecordCounts(harness)).toEqual([1, 1, 1, 1]);
    expect(yield* Deferred.poll(fatal)).toEqual(Option.none());
  });
}

describe("a local send during a Router outage", () => {
  itOnTestClock(
    "fails at once saying the post is queued and delivers it after re-attachment",
    localSendDuringOutage,
    TEST_TIMEOUT_MS,
  );
  itOnTestClock(
    "sends each outbox row once while the local and background drains race",
    concurrentDrainsSendEachOutboxOnce,
    TEST_TIMEOUT_MS,
  );
  itOnTestClock(
    "bounds a black-holed transmit and delivers its envelope exactly once",
    blackHoledTransmitBoundsTheSend,
    TEST_TIMEOUT_MS,
  );
});

describe("outbound loop under a transient Router worker state", () => {
  itOnTestClock(
    "keeps the outbound loop alive when the worker reports unavailable mid-drain",
    () =>
      transientTransmitFailureLeavesOutboundLoopAlive(
        new RouterWorkerUnavailableError(),
      ),
    TEST_TIMEOUT_MS,
  );
  itOnTestClock(
    "keeps the outbound loop alive when a transmit observes a Router restart",
    () =>
      transientTransmitFailureLeavesOutboundLoopAlive(
        new RouterWorkerDiscontinuityError(),
      ),
    TEST_TIMEOUT_MS,
  );
  itOnTestClock(
    "keeps the outbound loop alive when the Router transport drops mid-drain",
    () =>
      transientTransmitFailureLeavesOutboundLoopAlive(
        new RouterWorkerTransportError(),
      ),
    TEST_TIMEOUT_MS,
  );
  itOnTestClock(
    "keeps a cold-started outbound loop alive with a pending outbound row",
    coldStartWithPendingOutboundLeavesOutboundLoopAlive,
    TEST_TIMEOUT_MS,
  );
});

/**
 * Wraps a store so that a dissemination enqueue writes its outbox row, then
 * completes `entered` and waits for `release`, as a store slow to return
 * would. Once `release` is done, enqueues pass straight through.
 * @param store The store to wrap.
 * @param entered Completed once an enqueue has written its row.
 * @param release Ends the wait.
 * @returns The wrapping store.
 */
function holdingDisseminationEnqueue(
  store: EndpointStore,
  entered: Deferred.Deferred<undefined>,
  release: Deferred.Deferred<undefined>,
): EndpointStore {
  return {
    ...store,
    enqueueDisseminationOutbound: (obligation, outbound) =>
      store
        .enqueueDisseminationOutbound(obligation, outbound)
        .pipe(
          Effect.tap(() =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.zipRight(Deferred.await(release)),
            ),
          ),
        ),
  };
}

/**
 * Member 1 sends a GENESIS post, every member signs its proposal, and member
 * 2 receives every action signature but member 4's.
 * @param harness Engines of the four members.
 * @returns Every member's action signature, and member 4's on its own.
 */
function signGenesisShortOfMember4(harness: ProtocolHarness) {
  return Effect.gen(function* () {
    const author = yield* requireAt(harness.engines, 0, "endpoint engine");
    const fourth = yield* requireAt(harness.identities, 3, "identity");
    yield* Effect.forkScoped(
      author.send(yield* sendInput(harness, "open group")),
    );
    yield* harness.deliver([yield* Queue.take(harness.outbound)]);
    yield* harness.drain();
    const signatures = yield* takeQueued(harness);
    yield* harness.deliver(
      signatures.filter(
        ({ senderAgentId }) => senderAgentId !== fourth.card.agentId,
      ),
      [1],
    );
    return {
      signatures,
      fourths: signatures.filter(
        ({ senderAgentId }) => senderAgentId === fourth.card.agentId,
      ),
    };
  });
}

/**
 * Members 1, 3 and 4 receive every action signature of the GENESIS post, so
 * each stages its record and votes for it.
 * @param harness Engines of the four members.
 * @param signatures Every member's action signature.
 * @returns Member 3's durability vote.
 */
function voteOfMember3(
  harness: ProtocolHarness,
  signatures: ReadonlyArray<typeof SignedMessage.Type>,
) {
  return Effect.gen(function* () {
    const voter = yield* requireAt(harness.identities, 2, "identity");
    yield* harness.deliver(signatures, [0, 2, 3]);
    yield* harness.drain([0, 2, 3]);
    return yield* sentOfKind(
      harness,
      yield* takeQueued(harness),
      voter,
      "durability_vote",
    );
  });
}

/**
 * Member 2 holds three of the four GENESIS action signatures, and member 4's
 * completes the action certificate, so member 2 stages the record and queues
 * its action-certified copy. Its acceptance of that signature is interrupted
 * while the store writes the copy's outbox row, the first dissemination row
 * any member writes. The row and the fold's record hash commit together, so
 * member 3's durability vote for the record still reaches the fold. Fails
 * when the copy is queued interruptibly, or when the fold takes the record
 * hash outside that step: the row is written, the fold never learns the
 * record, and the vote is ignored.
 * @returns Completion once member 2 has answered the vote.
 */
function takesAVoteAfterItsStagingWasInterrupted() {
  return Effect.gen(function* () {
    const entered = yield* Deferred.make<undefined>();
    const release = yield* Deferred.make<undefined>();
    const harness = yield* makeProtocolHarness({
      wrapStore: (store) =>
        holdingDisseminationEnqueue(store, entered, release),
    });
    const { signatures, fourths } = yield* signGenesisShortOfMember4(harness);
    const accepting = yield* Effect.fork(harness.deliver(fourths, [1]));
    yield* Deferred.await(entered);

    yield* Fiber.interruptAsFork(accepting, yield* Effect.fiberId);
    yield* Deferred.succeed(release, undefined);
    const accepted = yield* Fiber.await(accepting);
    const answered = yield* harness.deliver(
      yield* voteOfMember3(harness, signatures),
      [1],
    );

    expect(
      Exit.isInterrupted(accepted),
      "member 2's acceptance of member 4's signature was interrupted",
    ).toBe(true);
    expect(answered).toEqual(["accepted"]);
  });
}

/**
 * Wraps a store so that it refuses every plain outbox row as a persistence
 * failure.
 * @param store The store to wrap.
 * @returns The wrapping store.
 */
function refusingOutboxRows(store: EndpointStore): EndpointStore {
  return {
    ...store,
    enqueueOutbound: () =>
      Effect.fail(new EndpointStoreError({ reason: "persistence" })),
  };
}

/** The outbound failure that ends the loop on a storage fault. */
const outboundPersistence: EngineOutboundError["reason"] = "persistence";

/**
 * Every member's store refuses plain outbox rows, and the first one any
 * member needs is the author's GENESIS proposal. The author bound the post's
 * intent before that refusal, so the intent is proposed again later and the
 * send fails as `delivery-pending` and the author's engine reports one
 * storage fault. Fails when the refusal reports the post as not sent, escapes
 * the send as a defect, or is not reported to the host.
 * @returns The scenario, before its scope closes.
 */
function failsASendWhoseBoundProposalTheStoreRefuses(): Effect.Effect<
  void,
  never,
  Scope.Scope
> {
  return Effect.gen(function* () {
    const faults = yield* Ref.make(0);
    const harness = yield* makeProtocolHarness({
      wrapStore: (store) => refusingOutboxRows(store),
      reportStorageFault: Ref.update(faults, (count) => count + 1),
    });
    const author = yield* requireAt(harness.engines, 0, "endpoint engine");

    const failure = yield* author
      .send(yield* sendInput(harness, "refused proposal"))
      .pipe(Effect.flip, Effect.orDie);

    expect(failure).toStrictEqual(
      new SendError({ reason: "delivery-pending" }),
    );
    expect(yield* Ref.get(faults), "storage faults reported").toBe(1);
  });
}

/**
 * The author's store fails the intent bind itself with `reason`. A raw
 * persistence failure can follow the bind's commit, so whether the intent is
 * durable is unknown; a store refusal rolls the bind back, so nothing was
 * queued, and only the first is reported to the host as a storage fault.
 * Fails when either reports the other's outcome or fault count.
 * @param reason The store failure the bind meets.
 * @param expected The send's failure for it.
 * @param expectedFaults Storage faults the author's engine reports for it.
 * @param commitOutcome Evidence that the failed bind did not commit.
 * @returns The scenario, before its scope closes.
 */
function failsASendWhoseBindTheStoreFails(
  reason: EndpointStoreError["reason"],
  expected: SendError["reason"],
  expectedFaults: number,
  commitOutcome?: EndpointStoreError["commitOutcome"],
): Effect.Effect<void, never, Scope.Scope> {
  return Effect.gen(function* () {
    const faults = yield* Ref.make(0);
    const harness = yield* makeProtocolHarness({
      wrapStore: (store) => ({
        ...store,
        bindPostIntent: () =>
          Effect.fail(new EndpointStoreError({ reason, commitOutcome })),
      }),
      reportStorageFault: Ref.update(faults, (count) => count + 1),
    });
    const author = yield* requireAt(harness.engines, 0, "endpoint engine");

    const failure = yield* author
      .send(yield* sendInput(harness, "unbound intent"))
      .pipe(Effect.flip, Effect.orDie);

    expect(failure).toStrictEqual(new SendError({ reason: expected }));
    expect(yield* Ref.get(faults), "storage faults reported").toBe(
      expectedFaults,
    );
  });
}

/**
 * The author's worker fails every transmit with a persistence failure, which
 * no retry clears. The supervised outbound loop ends with an
 * `EngineOutboundError` naming persistence, so the host stops on a store
 * fault instead of retrying it, and the send, whose post stays queued for the
 * restarted daemon, fails as `delivery-pending`. Fails when a non-transient
 * worker failure is retried, which keeps the loop running, maps to another
 * outbound reason, or fails the send as not sent.
 * @returns The scenario, before its scope closes.
 */
function persistenceFailureEndsTheOutboundLoop(): Effect.Effect<
  void,
  never,
  Scope.Scope
> {
  return Effect.gen(function* () {
    const harness = yield* makeProtocolHarness({
      authorSend: () => () => Effect.fail(new RouterWorkerPersistenceError()),
    });
    const author = yield* requireAt(harness.engines, 0, "endpoint engine");
    const fatal = yield* Deferred.make<never, EngineOutboundError>();
    yield* superviseOutbound(author, fatal);

    const failure = yield* author
      .send(yield* sendInput(harness, "never transmitted"))
      .pipe(Effect.flip, Effect.orDie);
    const ended = yield* Deferred.await(fatal).pipe(Effect.flip);

    expect(failure).toStrictEqual(
      new SendError({ reason: "delivery-pending" }),
    );
    expect(ended.reason, "the ended loop's EngineOutboundError reason").toBe(
      outboundPersistence,
    );
  });
}

/**
 * The author's worker fails every transmit because its recovery failed, which
 * stops the outbound loop and with it the daemon. The send's post stays
 * durably queued, and the daemon's recovery resumes it when it restarts, so
 * the send fails as `delivery-pending`. Fails when a fatal worker failure says
 * the post was not sent.
 * @returns The scenario, before its scope closes.
 */
function failedRecoveryFailsASendAsDeliveryPending(): Effect.Effect<
  void,
  never,
  Scope.Scope
> {
  return Effect.gen(function* () {
    const harness = yield* makeProtocolHarness({
      authorSend: () => () => Effect.fail(new RouterWorkerRecoveryError()),
    });
    const author = yield* requireAt(harness.engines, 0, "endpoint engine");

    const failure = yield* author
      .send(yield* sendInput(harness, "recovery failed"))
      .pipe(Effect.flip, Effect.orDie);

    expect(failure).toStrictEqual(
      new SendError({ reason: "delivery-pending" }),
    );
  });
}

const bindFailureCases = [
  {
    reason: "persistence",
    commitOutcome: undefined,
    expected: "outcome-unknown",
    faults: 1,
  },
  {
    reason: "persistence",
    commitOutcome: "not-committed",
    expected: "persistence-failed",
    faults: 0,
  },
  {
    reason: "conflict",
    commitOutcome: undefined,
    expected: "persistence-failed",
    faults: 0,
  },
] as const;

describe("engine faults while staging and sending", () => {
  it(
    "keeps a staged record's copy and fold together when its acceptance is interrupted",
    takesAVoteAfterItsStagingWasInterrupted,
    TEST_TIMEOUT_MS,
  );
  it(
    "fails a send as delivery-pending when the store refuses its bound proposal",
    failsASendWhoseBoundProposalTheStoreRefuses,
    TEST_TIMEOUT_MS,
  );
  it.each(bindFailureCases)(
    "fails a send whose intent bind meets a $reason ($commitOutcome) store failure as $expected",
    ({ reason, expected, faults, commitOutcome }) =>
      failsASendWhoseBindTheStoreFails(reason, expected, faults, commitOutcome),
    TEST_TIMEOUT_MS,
  );
  itOnTestClock(
    "ends the outbound loop with a persistence failure the worker cannot retry",
    persistenceFailureEndsTheOutboundLoop,
    TEST_TIMEOUT_MS,
  );
  itOnTestClock(
    "fails a send as delivery-pending when the worker's recovery failed",
    failedRecoveryFailsASendAsDeliveryPending,
    TEST_TIMEOUT_MS,
  );
});

it.each([
  { firstVersion: WIRE_VERSION, secondVersion: "2099.101.1" },
  { firstVersion: "2099.101.1", secondVersion: WIRE_VERSION },
])(
  "converges concurrent first sends when $firstVersion authors the first ordered GENESIS",
  ({ firstVersion, secondVersion }) =>
    concurrentFirstSends(firstVersion, secondVersion),
  TEST_TIMEOUT_MS,
);
