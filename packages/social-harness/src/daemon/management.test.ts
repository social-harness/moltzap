/** @file Registration cancellation and retained conversation visibility through real SQLite. */

import { scopedLive as it } from "@effect/vitest";
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
import {
  issueTestCard,
  makeTestAuthority,
  type RegistryKeyPair,
} from "../__tests__/agent-card-fixtures.js";
import {
  appendCertifiedMessage,
  buildCertifiedFirstMessage,
  storeCertifiedFirstMessage,
} from "../__tests__/certified-history-fixtures.js";
import { mcpTestCredential } from "../__tests__/mcp-http-fixtures.js";
import { localGuidance } from "../__tests__/message-policy-fixtures.js";
import { routerInstanceId } from "../__tests__/router-worker-fixtures.js";
import {
  stateDirectory,
  testStore,
  withDaemonStore,
} from "../__tests__/store-schema-fixtures.js";
import { verifyStoredMembership } from "../communication/conversations/index.js";
import { InboundMessage } from "../communication/conversations/message.js";
import {
  deriveConversationId,
  hashMembershipDescriptor,
  MembershipDescriptor,
} from "../communication/records/index.js";
import { compareAgentIds } from "../communication/records/values.js";
import {
  decodeRuntimeValue,
  encodeRuntimeValue,
} from "../communication/store/index.js";
import { encodeCanonical } from "../encoding/canonical-json.js";
import {
  managementReadConversationRequestSchema,
  managementRegisterRequestSchema,
} from "../host-protocol/index.js";
import { AgentCard, type VerifiedAgentCard } from "../identity/cards.js";
import { AgentSigningAuthority, Ed25519PublicKey } from "../identity/keys.js";
import { Registry } from "../identity/registry/index.js";
import { WIRE_VERSION } from "../identity/wire-version.js";
import { makeDaemonManagementOperations } from "./management/index.js";

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
      stateDirectory: "/var/lib/social-harness",
      mcpPort: 4319,
      mcpCredentialFile: Redacted.make("/run/secrets/mcp-credential"),
      registryOrigin: new URL("https://registry.example"),
      registrySignerPublicKey,
      routerOrigin: new URL("https://router.example"),
      agentPrivateKeyFile: Redacted.make("/run/secrets/agent.pem"),
      admissionCredentialFile: Redacted.make("/run/secrets/admission"),
      hideGroups: false,
      hideCollectives: false,
    },
    signingAuthority: localAuthority,
    mcpCredential: mcpTestCredential,
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
    register: () => Effect.dieMessage("Unexpected registration"),
    lookup: (request) => Effect.succeed(lookup(request)),
  };
  return Layer.succeed(Registry, service);
}

const guidance = localGuidance(9);
const historyRequest = Schema.decodeUnknownSync(
  managementReadConversationRequestSchema,
)({ address: "agent:bob" });
const seedHistory = (fixture: IdentityFixture) =>
  Effect.gen(function* () {
    const membership = yield* makeMembershipRow(fixture.cards).pipe(
      Effect.flatMap((row) =>
        verifyStoredMembership(
          row,
          fixture.bootstrap.configuration.registrySignerPublicKey,
        ),
      ),
    );
    const local = {
      card: fixture.cards[0],
      authority: fixture.bootstrap.signingAuthority,
    };
    const remote = {
      card: fixture.cards[1],
      authority: fixture.remoteAuthority,
    };
    const record = yield* buildCertifiedFirstMessage(
      local,
      remote,
      membership,
      routerInstanceId(8),
    );
    return { local, remote, membership, record };
  });
const activeOperations = (fixture: IdentityFixture) =>
  makeDaemonManagementOperations({
    bootstrap: fixture.bootstrap,
    registration: activeRegistration(fixture.cards[0]),
  }).pipe(Effect.provide(makeRegistryLayer(fixture.cards)));

type HistoryFixture = Effect.Effect.Success<ReturnType<typeof seedHistory>>;
const savePermittedHistory = (
  fixture: IdentityFixture,
  history: HistoryFixture,
) =>
  Effect.gen(function* () {
    const store = testStore;
    yield* storeCertifiedFirstMessage(
      store,
      fixture.cards[0],
      history.membership,
      history.record,
    );
    const operations = yield* activeOperations(fixture);
    expect(
      (yield* operations.readConversation(historyRequest)).records,
    ).toEqual([]);
    const pending = yield* Effect.fromNullable(
      (yield* store.readPendingDeliveries())[0],
    );
    const message = yield* decodeRuntimeValue(
      InboundMessage,
      pending.canonicalMessage,
    );
    const item = { kind: "multicast" as const, message };
    yield* store.putInboxItem({
      deliveryToken: pending.deliveryToken,
      canonicalItem: yield* encodeRuntimeValue(item),
      canonicalGuidance: yield* encodeRuntimeValue(guidance),
    });
    yield* store.acknowledgeInboxItem(pending.deliveryToken);
    yield* appendCertifiedMessage(
      { store, ...history },
      history.record,
      "Alice's reply",
      true,
    );
    expect((yield* store.readInboxSummary()).pendingCount).toBe(0);
    return item;
  });
const retainsPermittedHistory = () =>
  Effect.gen(function* () {
    const fixture = yield* makeIdentityFixture;
    const history = yield* seedHistory(fixture);
    const directory = stateDirectory();
    const expected = yield* withDaemonStore(directory, () =>
      savePermittedHistory(fixture, history),
    );
    yield* withDaemonStore(directory, () =>
      Effect.gen(function* () {
        const operations = yield* activeOperations(fixture);
        const page = yield* operations.readConversation(historyRequest);
        expect(page.records[0]).toEqual({
          kind: "received",
          recordHash: history.record.actionCertifiedRecord.recordHash,
          item: expected,
          guidance,
        });
        expect(page.records[1]).toMatchObject({
          kind: "sent",
          author: { agentName: fixture.cards[0].agentName },
          content: [{ type: "text", text: "Alice's reply" }],
        });
        expect(yield* operations.searchConversations({})).toEqual({
          kind: "page",
          addresses: ["agent:bob"],
          hasMore: false,
        });
      }),
    );
  });
const refusesUnregisteredReads = () =>
  withDaemonStore(stateDirectory(), () =>
    Effect.gen(function* () {
      const fixture = yield* makeIdentityFixture;
      const operations = yield* makeDaemonManagementOperations({
        bootstrap: fixture.bootstrap,
        registration: {
          readRegistration: () => ({ kind: "unregistered" }),
          activateRegistered: () => Effect.void,
        },
      }).pipe(Effect.provide(makeRegistryLayer(fixture.cards)));
      expect(yield* operations.readStatus()).toEqual({ kind: "unregistered" });
      expect(
        yield* operations.readConversation(historyRequest).pipe(Effect.flip),
      ).toMatchObject({ reason: "not-registered" });
      expect(
        yield* operations.searchConversations({}).pipe(Effect.flip),
      ).toMatchObject({ reason: "not-registered" });
    }),
  );

// @agent-code-guard/regression-only: history replays the saved host view after acknowledgment and restart without disclosing unchecked peer text.
describe("daemon conversation history", () => {
  it(
    "retains permitted messages after acknowledgment and excludes unchecked peer content",
    retainsPermittedHistory,
  );
  it(
    "refuses conversation reads before registration",
    refusesUnregisteredReads,
  );
});

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
    lookup: () => Effect.dieMessage("Unexpected lookup"),
  };
  return Layer.succeed(Registry, service);
}

function registrationPort() {
  let registration: DaemonRegistrationState = { kind: "unregistered" };
  return {
    readRegistration: () => registration,
    activateRegistered: (agentCard: VerifiedAgentCard) =>
      Effect.sync(() => {
        registration = { kind: "active", agentCard };
      }),
  };
}

// @agent-code-guard/regression-only: cancellation cannot strand a successful Registry registration outside durable local identity.
const finishesCanceledRegistration = () =>
  withDaemonStore(stateDirectory(), (store) =>
    Effect.gen(function* () {
      const fixture = yield* makeIdentityFixture;
      const entered = yield* Deferred.make<undefined>();
      const release = yield* Deferred.make<undefined>();
      const operations = yield* makeDaemonManagementOperations({
        bootstrap: fixture.bootstrap,
        registration: registrationPort(),
      }).pipe(Effect.provide(heldRegistry(fixture, entered, release)));
      const request = Schema.decodeUnknownSync(managementRegisterRequestSchema)(
        {
          operationId: "opn_AAAAAAAAAAAAAAAAAAAAAA",
          principalId: fixture.cards[0].principalId,
          agentName: fixture.cards[0].agentName,
        },
      );
      const registering = yield* Effect.fork(operations.register(request));
      yield* Deferred.await(entered);
      const interruption = yield* Effect.fork(Fiber.interrupt(registering));
      yield* Effect.sleep(Duration.zero);
      yield* Deferred.succeed(release, undefined);
      expect(Exit.isInterrupted(yield* Fiber.join(interruption))).toBe(true);
      expect((yield* store.readIdentity())?.agentId).toBe(
        fixture.cards[0].agentId,
      );
      expect(yield* operations.readStatus()).toMatchObject({
        kind: "active",
        agent: { agentName: fixture.cards[0].agentName },
      });
    }),
  );

it(
  "finishes a registration canceled while the Registry is answering",
  finishesCanceledRegistration,
);
