/** @file Canonical addressed management projection, closed failures, and the register tool's cancellation and Registry deadlines. */

import { FileSystem, HttpClient } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { scopedLive as it, scoped as itOnTestClock } from "@effect/vitest";
import {
  type Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Redacted,
  Schema,
} from "effect";
import { generateKeyPairSync } from "node:crypto";
import { describe, expect } from "vitest";
import type { RegistryLookupResult } from "../identity/registry/contract.js";
import type { DaemonBootstrap } from "./bootstrap.js";
import type { DaemonRegistrationState } from "./registration/index.js";
import { advanceClock } from "../__tests__/advance-clock.js";
import {
  digest,
  issueTestCard,
  makeTestAuthority,
  type RegistryKeyPair,
} from "../__tests__/agent-card-fixtures.js";
import {
  buildCertifiedGenesis,
  storeCertifiedGenesis,
  withGenesisAnchorSelecting,
  withMisattributedActionEvidence,
} from "../__tests__/certified-history-fixtures.js";
import { routerInstanceId } from "../__tests__/router-worker-fixtures.js";
import { unusedEndpointStore } from "../__tests__/unused-endpoint-store.js";
import { verifyStoredMembership } from "../communication/conversations/index.js";
import {
  deriveConversationId,
  hashMembershipDescriptor,
  MembershipDescriptor,
} from "../communication/records/index.js";
import { compareAgentIds } from "../communication/records/values.js";
import {
  type EndpointRecovery,
  type EndpointStore,
  EndpointStoreError,
  openEndpointStore,
} from "../communication/store/index.js";
import { encodeCanonical } from "../encoding/canonical-json.js";
import {
  managementReadConversationRequestSchema,
  managementRegisterRequestSchema,
  managementSearchAgentsRequestSchema,
} from "../harness/protocol/index.js";
import { AgentCard, type VerifiedAgentCard } from "../identity/cards.js";
import { AgentSigningAuthority, Ed25519PublicKey } from "../identity/keys.js";
import { Registry } from "../identity/registry/index.js";
import { LIVE_WIRE_VERSIONS, WIRE_VERSION } from "../identity/wire-version.js";
import {
  type DaemonManagementOperations,
  makeDaemonManagementOperations,
} from "./management/index.js";

interface IdentityFixture {
  readonly bootstrap: DaemonBootstrap;
  readonly cards: readonly [VerifiedAgentCard, VerifiedAgentCard];
  readonly remoteAuthority: AgentSigningAuthority;
  /** The Registry key pair the cards are issued under, for further members. */
  readonly registryKeys: RegistryKeyPair;
}

const makeIdentityFixture = Effect.gen(function* () {
  const registryKeys = generateKeyPairSync("ed25519");
  const registrySignerPublicKey = yield* Schema.decodeUnknown(Ed25519PublicKey)(
    registryKeys.publicKey.export({ format: "jwk" }),
  );
  const localAuthority = yield* makeTestAuthority();
  const remoteAuthority = yield* makeTestAuthority();
  const local = yield* issueTestCard({
    byte: 1,
    name: "alice",
    authority: localAuthority,
    registryKeys,
  });
  const remote = yield* issueTestCard({
    byte: 2,
    name: "bob",
    authority: remoteAuthority,
    registryKeys,
  });
  const bootstrap: DaemonBootstrap = Object.freeze({
    configuration: {
      stateDirectory: "/var/lib/sharnessd",
      mcpPort: 4319,
      registryOrigin: new URL("https://registry.example"),
      registrySignerPublicKey,
      routerOrigin: new URL("https://router.example"),
      agentPrivateKeyFile: Redacted.make("/run/secrets/agent.pem"),
      admissionCredentialFile: Redacted.make("/run/secrets/admission"),
    },
    signingAuthority: localAuthority,
    agentPublicKey: AgentSigningAuthority.publicKey(localAuthority),
    admissionCredential: Effect.succeed(Redacted.make("bootstrap-token=")),
  });
  return {
    bootstrap,
    cards: [local, remote],
    remoteAuthority,
    registryKeys,
  } satisfies IdentityFixture;
}).pipe(Effect.orDie);

/**
 * The stored membership row of a conversation among `members`, which the
 * descriptor lists in AgentId order.
 */
const makeMembershipRow = (members: readonly VerifiedAgentCard[]) =>
  Effect.gen(function* () {
    const cards = members.slice();
    cards.sort((left, right) => compareAgentIds(left.agentId, right.agentId));
    const [firstAgent, secondAgent, ...otherAgents] = cards;
    if (firstAgent === undefined || secondAgent === undefined) {
      return yield* Effect.dieMessage("a membership needs two members");
    }
    const conversationId = yield* deriveConversationId([
      firstAgent.agentId,
      secondAgent.agentId,
      ...otherAgents.map((card) => card.agentId),
    ]);
    const descriptor = yield* Schema.decodeUnknown(MembershipDescriptor)({
      sharnessVersion: WIRE_VERSION,
      kind: "membership_descriptor",
      conversationId,
      members: yield* Effect.forEach(
        cards,
        (card) => Schema.encode(AgentCard)(card),
        { concurrency: 1 },
      ),
    });
    const membershipHash = yield* hashMembershipDescriptor(descriptor);
    return {
      conversationId,
      membershipHash,
      canonicalMembership: yield* encodeCanonical(
        MembershipDescriptor,
        descriptor,
      ),
    };
  }).pipe(Effect.orDie);

/**
 * The recovery of the fixture's local agent holding one certified
 * conversation among `members`.
 */
const makeRecovery = (
  fixture: IdentityFixture,
  members: readonly VerifiedAgentCard[],
) =>
  Effect.gen(function* () {
    const membership = yield* makeMembershipRow(members);
    const canonicalAgentCard = yield* encodeCanonical(
      AgentCard,
      fixture.cards[0],
    );
    const recovery: EndpointRecovery = {
      identity: {
        agentId: fixture.cards[0].agentId,
        canonicalAgentCard,
      },
      postIntents: [],
      memberships: [
        {
          conversationId: membership.conversationId,
          membershipHash: membership.membershipHash,
          canonicalMembership: membership.canonicalMembership,
        },
      ],
      anchors: [],
      positions: [
        {
          conversationId: membership.conversationId,
          membershipHash: membership.membershipHash,
          currentAnchorHash: digest("anc_", 3),
          headRecordHash: digest("rch_", 4),
        },
      ],
      proposalLocks: [],
      stagedRecords: [],
      evidence: [],
      certifiedRecords: [],
      stagedReanchors: [],
      pendingDeliveries: [],
      disseminationObligations: [],
      outboundMessages: [],
    };
    return recovery;
  }).pipe(Effect.orDie);

function outsideManagementTest<Value>(): Effect.Effect<Value> {
  return Effect.dieMessage("outside management test");
}

interface StoreInput {
  readonly recovery: EndpointRecovery;
  readonly historyFailure?: EndpointStoreError;
}

function makeStore(input: StoreInput): EndpointStore {
  return {
    ...unusedEndpointStore("management test"),
    readConversation: () =>
      input.historyFailure === undefined
        ? Effect.succeed({ records: [], continuation: null })
        : Effect.fail(input.historyFailure),
    recover: () => Effect.succeed(input.recovery),
  };
}

/** The daemon's registration port, active with `card` and never activating. */
function activeRegistration(card: VerifiedAgentCard) {
  return {
    readRegistration: () => ({ kind: "active", agentCard: card }) as const,
    activateRegistered: () => Effect.void,
  };
}

function makeRegistryLayer(cards: readonly VerifiedAgentCard[]) {
  const lookup = (
    request: Parameters<Context.Tag.Service<typeof Registry>["lookup"]>[0],
  ): RegistryLookupResult => {
    const card = cards.find((candidate) =>
      "agentName" in request
        ? candidate.agentName === request.agentName
        : candidate.agentId === request.agentId,
    );
    return card === undefined
      ? { kind: "not_found" }
      : { kind: "found", agentCard: card };
  };
  const service: Context.Tag.Service<typeof Registry> = {
    register: () => outsideManagementTest(),
    lookup: (request) => Effect.succeed(lookup(request)),
  };
  return Layer.succeed(Registry, service);
}

/**
 * A real endpoint store holding one certified record bob authored in his
 * direct conversation with alice, with the management view of alice.
 */
const makeCertifiedHistory = Effect.gen(function* () {
  const fixture = yield* makeIdentityFixture;
  const membership = yield* makeMembershipRow(fixture.cards).pipe(
    Effect.flatMap((row) =>
      verifyStoredMembership(
        row,
        fixture.bootstrap.configuration.registrySignerPublicKey,
      ),
    ),
    Effect.orDie,
  );
  const record = yield* buildCertifiedGenesis(
    { card: fixture.cards[0], authority: fixture.bootstrap.signingAuthority },
    { card: fixture.cards[1], authority: fixture.remoteAuthority },
    membership,
    routerInstanceId(8),
  );
  const fileSystem = yield* FileSystem.FileSystem;
  const store = yield* openEndpointStore(
    yield* fileSystem.makeTempDirectoryScoped({
      prefix: "sharness-management-",
    }),
    { liveWireVersions: LIVE_WIRE_VERSIONS },
  ).pipe(Effect.orDie);
  yield* storeCertifiedGenesis(store, fixture.cards[0], membership, record);
  return { fixture, store, record };
}).pipe(Effect.provide(NodeFileSystem.layer));

/** Alice's first history page of her conversation with bob over `store`. */
const readBobHistory = (fixture: IdentityFixture, store: EndpointStore) =>
  makeDaemonManagementOperations({
    store,
    bootstrap: fixture.bootstrap,
    registration: activeRegistration(fixture.cards[0]),
  }).pipe(
    Effect.provide(makeRegistryLayer(fixture.cards)),
    Effect.flatMap((operations) =>
      operations.readConversation(
        Schema.decodeUnknownSync(managementReadConversationRequestSchema)({
          address: "agent:bob",
        }),
      ),
    ),
  );

/** The record hashes of alice's read of her conversation with bob over `store`. */
const readBobRecordHashes = (fixture: IdentityFixture, store: EndpointStore) =>
  readBobHistory(fixture, store).pipe(
    Effect.map((page) => page.records.map((record) => record.recordHash)),
    Effect.exit,
  );

/** A signer message's JWS representation, read as far as its one signature. */
const jwsSignature = Schema.Struct({
  signatures: Schema.Tuple(Schema.Struct({ signature: Schema.String })),
});

/**
 * The audit entry the owner tools return for one certificate signature:
 * `signer`'s AgentId and the signature its JWS `representation` carries.
 */
const signerEvidence = (
  signer: VerifiedAgentCard,
  representation: unknown,
) => ({
  signerAgentId: signer.agentId,
  signature:
    Schema.decodeUnknownSync(jwsSignature)(representation).signatures[0]
      .signature,
});

/**
 * `store` as it reads once its membership rows name `membershipHash`, so the
 * rows' columns no longer match the descriptors they hold.
 */
function withMembershipRowsNaming(
  store: EndpointStore,
  membershipHash: string,
): EndpointStore {
  return {
    ...store,
    recover: () =>
      store.recover().pipe(
        Effect.map((recovery) => ({
          ...recovery,
          memberships: recovery.memberships.map((row) => ({
            ...row,
            membershipHash,
          })),
        })),
      ),
  };
}

/**
 * The owner read returns the record with the anchor it commits to and, for
 * each certificate, every signer's AgentId with the signature its JWS
 * representation carries, in AgentId order.
 */
const returnsCertificateSignersForAudit = () =>
  Effect.gen(function* () {
    const { fixture, store, record } = yield* makeCertifiedHistory;
    const [alice, bob] = fixture.cards;
    const certified = record.actionCertifiedRecord;
    const signatures = certified.actionCertificate.signatures;
    const votes = record.durabilityCertificate.votes;

    const page = yield* readBobHistory(fixture, store);

    expect(
      compareAgentIds(alice.agentId, bob.agentId),
      "alice precedes bob in AgentId order",
    ).toBeLessThan(0);
    expect(page.records, "alice's history with bob").toEqual([
      {
        recordHash: certified.recordHash,
        recordCore: certified.recordCore,
        routerAnchor: certified.routerAnchor,
        actionSignatures: [
          signerEvidence(alice, signatures[0]),
          signerEvidence(bob, signatures[1]),
        ],
        durabilityVotes: [
          signerEvidence(alice, votes[0]),
          signerEvidence(bob, votes[1]),
        ],
      },
    ]);
  });

/**
 * A store whose membership row names a membership hash other than the one
 * its descriptor hashes to is corrupt, so the read reports
 * persistence-failed, while the unaltered store reads the record.
 */
const failsReadOverMembershipRowNamingAnotherHash = () =>
  Effect.gen(function* () {
    const { fixture, store, record } = yield* makeCertifiedHistory;
    const inconsistent = withMembershipRowsNaming(store, digest("mbr_", 9));

    const unaltered = yield* readBobRecordHashes(fixture, store);
    const corrupt = yield* readBobRecordHashes(fixture, inconsistent);

    expect(unaltered, "history read over the unaltered store").toEqual(
      Exit.succeed([record.actionCertifiedRecord.recordHash]),
    );
    expect(
      corrupt,
      "history read over the inconsistent membership row",
    ).toEqual(
      Exit.fail(expect.objectContaining({ reason: "persistence-failed" })),
    );
  });

/**
 * The owner tools read stored history with the row checks startup applies.
 * A store whose action evidence row is filed under a member other than its
 * signer is corrupt, so the read reports persistence-failed, while the
 * unaltered store reads the record.
 */
const failsReadOverMisattributedEvidence = () =>
  Effect.gen(function* () {
    const { fixture, store, record } = yield* makeCertifiedHistory;
    const misattributed = withMisattributedActionEvidence(
      store,
      fixture.cards[0].agentId,
      fixture.cards[1].agentId,
    );

    const unaltered = yield* readBobRecordHashes(fixture, store);
    const corrupt = yield* readBobRecordHashes(fixture, misattributed);

    expect(unaltered, "history read over the unaltered store").toEqual(
      Exit.succeed([record.actionCertifiedRecord.recordHash]),
    );
    expect(corrupt, "history read over the misattributed evidence").toEqual(
      Exit.fail(expect.objectContaining({ reason: "persistence-failed" })),
    );
  });

/**
 * A store whose genesis anchor row claims to select a record, which only a
 * completed re-anchor does, is corrupt, so the read reports
 * persistence-failed, while the unaltered store reads the record.
 */
const failsReadOverGenesisAnchorSelectingRecord = () =>
  Effect.gen(function* () {
    const { fixture, store, record } = yield* makeCertifiedHistory;
    const recordHash = record.actionCertifiedRecord.recordHash;
    const inconsistent = withGenesisAnchorSelecting(store, recordHash);

    const unaltered = yield* readBobRecordHashes(fixture, store);
    const corrupt = yield* readBobRecordHashes(fixture, inconsistent);

    expect(unaltered, "history read over the unaltered store").toEqual(
      Exit.succeed([recordHash]),
    );
    expect(corrupt, "history read over the inconsistent anchor row").toEqual(
      Exit.fail(expect.objectContaining({ reason: "persistence-failed" })),
    );
  });

const checksExactAgentLookups = () =>
  Effect.gen(function* () {
    const fixture = yield* makeIdentityFixture;
    const operations = yield* makeDaemonManagementOperations({
      store: unusedEndpointStore("management lookup test"),
      bootstrap: fixture.bootstrap,
      registration: activeRegistration(fixture.cards[0]),
    }).pipe(Effect.provide(makeRegistryLayer(fixture.cards)));
    const remote = fixture.cards[1];
    const found = {
      kind: "found",
      agentCard: yield* Schema.encode(AgentCard)(remote),
    };

    expect(
      yield* operations.searchAgents({ agentName: remote.agentName }),
    ).toEqual(found);
    expect(yield* operations.searchAgents({ agentId: remote.agentId })).toEqual(
      found,
    );
    expect(
      yield* operations.searchAgents(
        Schema.decodeUnknownSync(managementSearchAgentsRequestSchema)({
          agentName: "unknown-agent",
        }),
      ),
    ).toEqual({ kind: "not_found" });
  });

// @agent-code-guard/regression-only: these cases pin the addressed owner-management contract.
describe("addressed daemon management", () => {
  it(
    "returns encoded cards for exact names and ids and not_found for unknown names",
    checksExactAgentLookups,
  );

  it("pages canonical addresses without exposing conversation identity", () =>
    Effect.gen(function* () {
      const fixture = yield* makeIdentityFixture;
      const recovery = yield* makeRecovery(fixture, fixture.cards);
      const operations = yield* makeDaemonManagementOperations({
        store: makeStore({ recovery }),
        bootstrap: fixture.bootstrap,
        registration: activeRegistration(fixture.cards[0]),
      }).pipe(Effect.provide(makeRegistryLayer(fixture.cards)));

      expect(yield* operations.searchConversations({})).toEqual({
        kind: "page",
        addresses: ["agent:bob"],
        hasMore: false,
      });
    }));

  it("maps a missing certified history to history-gap", () =>
    Effect.gen(function* () {
      const fixture = yield* makeIdentityFixture;
      const recovery = yield* makeRecovery(fixture, fixture.cards);
      const operations = yield* makeDaemonManagementOperations({
        store: makeStore({
          recovery,
          historyFailure: new EndpointStoreError({ reason: "not-found" }),
        }),
        bootstrap: fixture.bootstrap,
        registration: activeRegistration(fixture.cards[0]),
      }).pipe(Effect.provide(makeRegistryLayer(fixture.cards)));
      const request = Schema.decodeUnknownSync(
        managementReadConversationRequestSchema,
      )({ address: "agent:bob" });

      const error = yield* operations
        .readConversation(request)
        .pipe(Effect.flip);

      expect(error).toMatchObject({ reason: "history-gap" });
    }));
});

/** The daemon's registration port before registration. */
const unregisteredPort = {
  readRegistration: (): DaemonRegistrationState => ({ kind: "unregistered" }),
  activateRegistered: () => Effect.dieMessage("outside management test"),
};

/** A Registry no call may reach. */
const unusedRegistryLayer = Layer.succeed(Registry, {
  register: () => outsideManagementTest(),
  lookup: () => outsideManagementTest(),
});

/** One owner read, named by its tool. */
interface OwnerRead {
  readonly tool: string;
  readonly read: (
    operations: DaemonManagementOperations,
  ) => Effect.Effect<unknown, Readonly<{ reason: string }>>;
}

/** The owner reads that need the local identity, each with one request. */
const ownerReads: readonly OwnerRead[] = [
  {
    tool: "search_conversations",
    read: (operations) => operations.searchConversations({}),
  },
  {
    tool: "read_conversation",
    read: (operations) =>
      operations.readConversation(
        Schema.decodeUnknownSync(managementReadConversationRequestSchema)({
          address: "agent:bob",
        }),
      ),
  },
  {
    tool: "search_agents",
    read: (operations) =>
      operations.searchAgents(
        Schema.decodeUnknownSync(managementSearchAgentsRequestSchema)({
          agentName: "bob",
        }),
      ),
  },
];

/**
 * Before registration an owner read that needs the local identity reports
 * not-registered and reads nothing: the store and the Registry die on every
 * call. Fails when the read reaches either before the registration check.
 */
const refusesAnOwnerReadBeforeRegistration = ({ read }: OwnerRead) =>
  Effect.gen(function* () {
    const fixture = yield* makeIdentityFixture;
    const operations = yield* makeDaemonManagementOperations({
      store: unusedEndpointStore("unregistered management test"),
      bootstrap: fixture.bootstrap,
      registration: unregisteredPort,
    }).pipe(Effect.provide(unusedRegistryLayer));

    const error = yield* read(operations).pipe(Effect.flip);

    expect(error).toMatchObject({ reason: "not-registered" });
  });

/**
 * A group conversation lists as its group address, with the members' names
 * in unsigned ASCII order: `agent-10` before `agent-2`, both before the
 * local `alice`, although their AgentIds order them alice, agent-2,
 * agent-10. Fails when the address follows the membership's AgentId order.
 */
const listsAGroupInAsciiNameOrder = () =>
  Effect.gen(function* () {
    const fixture = yield* makeIdentityFixture;
    const agent2 = yield* issueTestCard({
      byte: 3,
      name: "agent-2",
      authority: yield* makeTestAuthority(),
      registryKeys: fixture.registryKeys,
    });
    const agent10 = yield* issueTestCard({
      byte: 4,
      name: "agent-10",
      authority: yield* makeTestAuthority(),
      registryKeys: fixture.registryKeys,
    });
    const recovery = yield* makeRecovery(fixture, [
      fixture.cards[0],
      agent2,
      agent10,
    ]);
    const operations = yield* makeDaemonManagementOperations({
      store: makeStore({ recovery }),
      bootstrap: fixture.bootstrap,
      registration: activeRegistration(fixture.cards[0]),
    }).pipe(Effect.provide(unusedRegistryLayer));

    const page = yield* Effect.exit(operations.searchConversations({}));

    expect(page).toEqual(
      Exit.succeed({
        kind: "page",
        addresses: ["group:agent-10,agent-2,alice"],
        hasMore: false,
      }),
    );
  });

describe("owner reads by registration state", () => {
  it.each(ownerReads)(
    "refuses $tool as not-registered before registration without reading state",
    refusesAnOwnerReadBeforeRegistration,
  );
  it(
    "lists a group conversation with its names in unsigned ASCII order",
    listsAGroupInAsciiNameOrder,
  );
});

describe("owner history read over stored rows", () => {
  it(
    "returns each certificate's signers and signatures with the record's anchor",
    returnsCertificateSignersForAudit,
  );
  it(
    "fails a history read whose action evidence is filed under another signer",
    failsReadOverMisattributedEvidence,
  );
  it(
    "fails a history read whose genesis anchor row selects a record",
    failsReadOverGenesisAnchorSelectingRecord,
  );
  it(
    "fails a history read whose membership row names another membership hash",
    failsReadOverMembershipRowNamingAnotherHash,
  );
});

/** A durable store and registration port whose status follows activation. */
function makeRegisteringOperations(fixture: IdentityFixture) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const store = yield* openEndpointStore(
      yield* fileSystem.makeTempDirectoryScoped({
        prefix: "sharness-registration-",
      }),
      { liveWireVersions: LIVE_WIRE_VERSIONS },
    );
    let registration: DaemonRegistrationState = { kind: "unregistered" };
    const operations = yield* makeDaemonManagementOperations({
      store,
      bootstrap: fixture.bootstrap,
      registration: {
        readRegistration: () => registration,
        activateRegistered: (agentCard) =>
          Effect.sync(() => {
            registration = { kind: "active", agentCard };
          }),
      },
    });
    return { store, operations };
  }).pipe(Effect.provide(NodeFileSystem.layer));
}

/** The register tool request for the fixture's local card. */
function localRegisterRequest(fixture: IdentityFixture) {
  return Schema.decodeUnknownSync(managementRegisterRequestSchema)({
    operationId: "opn_AAAAAAAAAAAAAAAAAAAAAA",
    principalId: fixture.cards[0].principalId,
    agentName: fixture.cards[0].agentName,
  });
}

/**
 * The production Registry client with a 1 s request deadline over an HTTP
 * client that completes `requested` when a request arrives and never answers,
 * as a stalled Registry connection behaves.
 */
function silentRegistryLayer(
  fixture: IdentityFixture,
  requested: Deferred.Deferred<undefined>,
) {
  return Registry.layer({
    origin: fixture.bootstrap.configuration.registryOrigin,
    registrySignerPublicKey:
      fixture.bootstrap.configuration.registrySignerPublicKey,
    requestTimeout: Duration.seconds(1),
  }).pipe(
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make(() =>
          Deferred.succeed(requested, undefined).pipe(
            Effect.zipRight(Effect.never),
          ),
        ),
      ),
    ),
  );
}

/** Virtual time past the Registry deadline after which a call is hung. */
const REGISTRY_WATCHDOG = Duration.seconds(3);

/**
 * `operation`'s failure, on the TestClock, once virtual time has passed the
 * Registry deadline and `REGISTRY_WATCHDOG`. It waits in live time for the
 * request to reach the HTTP client, since signing settles on real promises,
 * or for the operation to end first, then moves the clock. An operation
 * still running then fails with `hung`. The operation runs detached, so a
 * masked call that never ends cannot hold the test fiber open.
 * @param input What to run and how to tell it is hung.
 * @param input.operation The Registry-backed operation.
 * @param input.requested Completes when the request reaches the HTTP client.
 * @param input.hung The failure the watchdog reports.
 * @returns The operation's failure, or `hung`.
 */
const failureAtTheRegistryDeadline = <A, E>(input: {
  readonly operation: Effect.Effect<A, E>;
  readonly requested: Deferred.Deferred<undefined>;
  readonly hung: string;
}) =>
  Effect.gen(function* () {
    const running = yield* Effect.forkDaemon(input.operation);
    const failure = yield* Fiber.join(running).pipe(
      Effect.flip,
      Effect.timeoutFail({
        duration: REGISTRY_WATCHDOG,
        onTimeout: () => input.hung,
      }),
      Effect.fork,
    );
    yield* Effect.raceFirst(
      Deferred.await(input.requested),
      Fiber.await(running).pipe(Effect.asVoid),
    );
    yield* advanceClock(Duration.sum(REGISTRY_WATCHDOG, Duration.seconds(1)));
    return yield* Fiber.join(failure);
  });

/**
 * The register tool runs uninterruptibly so a cancelled request still binds.
 * That region must not also hold the Registry client's deadline off: a
 * Registry that never answers ends the call at the deadline, not never, and
 * binds and activates nothing.
 */
const failsAtTheRegistryDeadline = () =>
  Effect.gen(function* () {
    const fixture = yield* makeIdentityFixture;
    const requested = yield* Deferred.make<undefined>();
    const { store, operations } = yield* makeRegisteringOperations(
      fixture,
    ).pipe(Effect.provide(silentRegistryLayer(fixture, requested)));

    const error = yield* failureAtTheRegistryDeadline({
      operation: operations.register(localRegisterRequest(fixture)),
      requested,
      hung: "register outlived the Registry deadline",
    });

    expect(
      yield* Deferred.isDone(requested),
      "the register reached the Registry's HTTP client",
    ).toBe(true);
    expect(error).toMatchObject({ reason: "dependency-unavailable" });
    expect((yield* store.recover()).identity).toBeUndefined();
    expect(yield* operations.readStatus()).toEqual({ kind: "unregistered" });
  });

/**
 * `search_agents` gives its Registry call the same deadline: a Registry that
 * never answers ends the search as dependency-unavailable at the deadline.
 * Fails when the search outlives the deadline or the timeout maps to another
 * reason.
 */
const failsSearchAtTheRegistryDeadline = () =>
  Effect.gen(function* () {
    const fixture = yield* makeIdentityFixture;
    const requested = yield* Deferred.make<undefined>();
    const operations = yield* makeDaemonManagementOperations({
      store: unusedEndpointStore("management search deadline test"),
      bootstrap: fixture.bootstrap,
      registration: activeRegistration(fixture.cards[0]),
    }).pipe(Effect.provide(silentRegistryLayer(fixture, requested)));

    const error = yield* failureAtTheRegistryDeadline({
      operation: operations.searchAgents(
        Schema.decodeUnknownSync(managementSearchAgentsRequestSchema)({
          agentName: "bob",
        }),
      ),
      requested,
      hung: "search_agents outlived the Registry deadline",
    });

    expect(error).toMatchObject({ reason: "dependency-unavailable" });
  });

/** A Registry whose register waits for `release` after signalling `entered`. */
function heldRegistry(
  fixture: IdentityFixture,
  entered: Deferred.Deferred<undefined>,
  release: Deferred.Deferred<undefined>,
) {
  const service: Context.Tag.Service<typeof Registry> = {
    register: () =>
      Deferred.succeed(entered, undefined).pipe(
        Effect.zipRight(Deferred.await(release)),
        Effect.as({ kind: "registered", agentCard: fixture.cards[0] } as const),
      ),
    lookup: () => outsideManagementTest(),
  };
  return Layer.succeed(Registry, service);
}

/**
 * Cancelling the MCP request interrupts the tool's operation. One that
 * arrives while the Registry call is in flight must still let the call
 * finish, bind the card and activate it, or the Registry would hold a
 * registration this daemon never recorded. The zero-length sleep lets the
 * interrupt reach the register fiber before the Registry call is released.
 */
const bindsWhenCancelledDuringTheRegistryCall = () =>
  Effect.gen(function* () {
    const fixture = yield* makeIdentityFixture;
    const entered = yield* Deferred.make<undefined>();
    const release = yield* Deferred.make<undefined>();
    const { store, operations } = yield* makeRegisteringOperations(
      fixture,
    ).pipe(Effect.provide(heldRegistry(fixture, entered, release)));
    const registration = yield* Effect.fork(
      operations.register(localRegisterRequest(fixture)),
    );
    yield* Deferred.await(entered);
    const interruption = yield* Effect.fork(Fiber.interrupt(registration));
    yield* Effect.sleep(Duration.zero);
    yield* Deferred.succeed(release, undefined);

    expect(
      Exit.isInterrupted(yield* Fiber.join(interruption)),
      "the cancelled register reports an interrupt",
    ).toBe(true);

    const canonicalAgentCard = yield* encodeCanonical(
      AgentCard,
      fixture.cards[0],
    );
    expect((yield* store.recover()).identity).toEqual({
      agentId: fixture.cards[0].agentId,
      canonicalAgentCard,
    });
    expect(yield* operations.readStatus()).toEqual({
      kind: "active",
      agentCard: yield* Schema.encode(AgentCard)(fixture.cards[0]),
    });
  });

// @agent-code-guard/regression-only: these cases pin the register tool's cancellation and Registry deadline contract.
describe("daemon registration through the register tool", () => {
  itOnTestClock(
    "fails a register at the Registry deadline when the Registry never answers",
    failsAtTheRegistryDeadline,
  );
  itOnTestClock(
    "fails search_agents at the Registry deadline when the Registry never answers",
    failsSearchAtTheRegistryDeadline,
  );
  it(
    "binds and activates a register cancelled during the Registry call",
    bindsWhenCancelledDuringTheRegistryCall,
  );
});
