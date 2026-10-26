/** @file Real storage and prepared send fixtures shared by firewall admission tests. */

import { Deferred, Effect, Queue, Schema, Scope } from "effect";
import { generateKeyPairSync } from "node:crypto";
import type { InboundItem } from "../communication/collectives/inbound.js";
import type {
  MessageMiddleware,
  MiddlewareResult,
} from "../firewall/evaluator/contract/index.js";
import type { HarnessMessageReadyEvent } from "../harness/protocol/operations.js";
import {
  makeCollectiveOperations,
  type ResultProvenance,
} from "../communication/collectives/index.js";
import { makeEndpointEngine } from "../communication/conversations/index.js";
import { InboundMessage } from "../communication/conversations/message.js";
import {
  AgentAddress,
  deriveConversationId,
  MembershipDescriptor,
  RecordHash,
  verifyMembershipDescriptor,
} from "../communication/records/index.js";
import { RouterInstanceId } from "../communication/router/api/contract.js";
import {
  decodeRuntimeValue,
  DeliveryToken,
  encodeRuntimeValue,
  type EndpointStore,
  EndpointStoreError,
  openEndpointStore,
} from "../communication/store/index.js";
import { encodeCanonical } from "../encoding/canonical-json.js";
import {
  collectiveAdmission,
  decodeFirewallAuditEntry,
  type FirewallOptions,
  type InstalledFirewall,
  installFirewall,
} from "../firewall/admission/index.js";
import { noHistoryExport } from "../harness/inbox/history-export.js";
import { makeHostDelivery } from "../harness/inbox/host-delivery.js";
import { AgentCard } from "../identity/cards.js";
import { Ed25519PublicKey } from "../identity/keys.js";
import { LIVE_WIRE_VERSIONS, WIRE_VERSION } from "../identity/wire-version.js";
import {
  digest,
  identifier,
  issueTestCard,
  makeTestAuthority,
} from "./agent-card-fixtures.js";
import {
  buildCertifiedGenesis,
  storeCertifiedGenesis,
} from "./certified-history-fixtures.js";
import { pollCursor } from "./router-worker-fixtures.js";
import { stateDirectory } from "./store-schema-fixtures.js";

/** A communication norm shares its guidance and repair text across traces. */
export const rule = {
  id: "communication",
  kind: "norm",
  guidance: "Answer the open scheduling question.",
  feedback: {
    nextAction: "revise",
    text: "Include all required participants.",
  },
} as const;
/** A complete policy permits admission without advice. */
export const pass: MiddlewareResult = {
  findings: [{ ruleId: rule.id, outcome: "pass" }],
  expectations: [],
};
/** A semantic rejection with no response obligation. */
export const block: MiddlewareResult = {
  findings: [{ ruleId: rule.id, outcome: "block" }],
  expectations: [],
};
/** A norm violation that returns the registered repair advice. */
export const revise: MiddlewareResult = {
  findings: [{ ruleId: rule.id, outcome: "revise" }],
  expectations: [],
};
/** An unresolved check tells the runtime to wait. */
export const waitAction = "wait";
/** The textual error projection retains the next action. */
export const renderedWaitAction = `Next action: ${waitAction}.`;
/** Budgets leave room for real storage and scheduling on loaded test hosts. */
export const settings = {
  timeoutMilliseconds: 10_000,
  middlewareTimeoutMilliseconds: 8_000,
  maximumInputBytes: 1_000_000,
  maximumResultBytes: 100_000,
};
/** Bob is the peer of the default direct conversation. */
export const destination = Schema.decodeUnknownSync(AgentAddress)("agent:bob");
const anchor = {
  routerInstanceId: Schema.decodeUnknownSync(RouterInstanceId)(
    identifier("rti_", 10),
  ),
  pollCursor: pollCursor(11),
};

const identities = Effect.gen(function* () {
  const registryKeys = generateKeyPairSync("ed25519");
  const local = yield* signingIdentity(1, "alice", registryKeys);
  const remote = yield* signingIdentity(2, "bob", registryKeys);
  const third = yield* signingIdentity(3, "carol", registryKeys);
  const signer = yield* Schema.decodeUnknown(Ed25519PublicKey)(
    registryKeys.publicKey.export({ format: "jwk" }),
  );
  const membership = yield* directMembership([local.card, remote.card], signer);
  const directory = stateDirectory();
  const store = yield* openEndpointStore(directory, {
    liveWireVersions: LIVE_WIRE_VERSIONS,
  });
  yield* store.bindIdentity({
    agentId: local.card.agentId,
    canonicalAgentCard: yield* encodeCanonical(AgentCard, local.card),
  });
  return {
    local,
    remote,
    third,
    membership,
    directory,
    store,
    registryKeys,
    signer,
  };
});

/**
 * Real storage and send preparation run with a suspended Router send. Before
 * each outbound write the engine asks `failWrite`: a write it fails fails the
 * bound post's activation, and the storage fault it reports is ignored.
 * @param failWrite Whether the next outbound write fails; none fails by default.
 * @returns The fixture's identities, storage, engine and Router barrier.
 */
export const engineFixture = (failWrite?: () => boolean) =>
  Effect.gen(function* () {
    const known = yield* identities;
    const { local, remote, third, store, signer } = known;
    const outbound = yield* Deferred.make<undefined>();
    const engine = yield* makeEndpointEngine({
      localAgentCard: local.card,
      signingAuthority: local.authority,
      registrySignerPublicKey: signer,
      registry: {
        lookup: (request) =>
          Effect.succeed({
            kind: "found",
            agentCard:
              "agentName" in request &&
              request.agentName === third.card.agentName
                ? third.card
                : remote.card,
          }),
      },
      store: {
        ...store,
        enqueueOutbound: (input) =>
          failWrite?.() === true
            ? Effect.fail(new EndpointStoreError({ reason: "persistence" }))
            : store.enqueueOutbound(input),
      },
      reportStorageFault: () =>
        failWrite === undefined
          ? Effect.dieMessage("unexpected store fault")
          : Effect.void,
      routerWorker: {
        currentAnchor: Effect.succeed(anchor),
        awaitAnchor: Effect.succeed(anchor),
        send: () =>
          Deferred.succeed(outbound, undefined).pipe(
            Effect.zipRight(Effect.never),
          ),
      },
    });
    return { ...known, engine, outbound };
  }).pipe(Effect.withSpan("fixture"));
/** The fixture whose engine signs every proposal. */
export const fixture = engineFixture();
/** The acquired identities and storage remain live for the test scope. */
export type Fixture = Effect.Effect.Success<typeof fixture>;

/** Read completed checks in insertion order through the production store read. */
export const auditChecks = (subject: Fixture) =>
  Effect.gen(function* () {
    const entries = yield* subject.store.readFirewallDecisions();
    return yield* Effect.forEach(
      [...entries].sort((left, right) => left.sequence - right.sequence),
      (entry) => decodeFirewallAuditEntry(entry),
      { concurrency: 1 },
    );
  }).pipe(Effect.withSpan("auditChecks"));

/** Fixed registration and settings are captured before delivery operations run. */
export const installation = (
  middleware: MessageMiddleware,
  overrides: Partial<FirewallOptions> = {},
) =>
  installFirewall({
    incoming: [middleware],
    outgoing: [middleware],
    settings,
    facts: [],
    codeDigest: "a".repeat(64),
    mode: "enforcement",
    ...overrides,
  });

/**
 * One collective layer with the firewall's admission ports and the delivery
 * built over it, as the daemon composes them. Requests the layer classifies
 * wait for admission; items it emits are queued privately and recorded.
 */
const firewallRuntime = (subject: Fixture, installed: InstalledFirewall) =>
  Effect.gen(function* () {
    const { local, store, engine } = subject;
    const environment = { installed, store, localAgentCard: local.card };
    const scope = yield* Scope.Scope;
    const emitted: InboundItem[] = [];
    const slot: {
      delivery?: Effect.Effect.Success<ReturnType<typeof makeHostDelivery>>;
    } = {};
    const emit = (item: InboundItem, provenance?: ResultProvenance) =>
      Effect.suspend(() => {
        emitted.push(item);
        return slot.delivery === undefined
          ? Effect.void
          : slot.delivery.queueLocalItem(item, provenance).pipe(Effect.orDie);
      });
    const collectives = makeCollectiveOperations({
      self: Schema.decodeUnknownSync(AgentAddress)("agent:alice"),
      scope,
      lookupMember: (member) => engine.resolveAddress(member),
      sendPost: (input) => engine.send(input),
      emit,
      admission: collectiveAdmission(environment, engine),
    });
    const delivery = yield* makeHostDelivery({
      store,
      historyExport: noHistoryExport,
      collectives: () => collectives,
      scope,
      firewall: installed,
      firewallEnvironment: () => environment,
    });
    slot.delivery = delivery;
    return { environment, delivery, collectives, emitted };
  }).pipe(Effect.withSpan("firewallRuntime"));

/**
 * The incoming fixture over an installed firewall, such as an editable one
 * whose checks read its active installation.
 */
export const incomingThrough = (
  subject: Fixture,
  installed: InstalledFirewall,
  seed = true,
) =>
  Effect.gen(function* () {
    yield* Effect.when(seedIncoming(subject), () => seed);
    const { environment, delivery, collectives, emitted } =
      yield* firewallRuntime(subject, installed);
    const published: HarnessMessageReadyEvent[] = [];
    const readPending = pendingMessages(subject.store);
    const runPass = delivery.runPass(() => ({
      readPending,
      classify: collectives.classify,
      engine: { acknowledgeMessage: subject.engine.acknowledgeMessage },
      handler: {
        publish: (event) => {
          published.push(event);
          return true;
        },
      },
    }));
    const completed = yield* startAdmission(delivery, runPass);
    const pending = yield* readPending;
    const candidate = pending[0];
    if (candidate === undefined) {
      return yield* Effect.dieMessage("missing certified fixture");
    }
    return {
      ...environment,
      delivery,
      collectives,
      emitted,
      published,
      runPass,
      completed,
      candidate,
    };
  }).pipe(Effect.withSpan("incomingThrough"));

/** A seeded incoming candidate runs through the admission worker and inbox. */
export const incomingFixture = (
  subject: Fixture,
  middleware: MessageMiddleware,
  overrides: Partial<FirewallOptions> = {},
  seed = true,
) =>
  installation(middleware, overrides).pipe(
    Effect.flatMap((installed) => incomingThrough(subject, installed, seed)),
  );

/** Runtime send operations use the real checked-send path before the Router barrier. */
export function outgoingFixture(
  subject: Fixture,
  middleware: MessageMiddleware,
  overrides: Partial<FirewallOptions> = {},
) {
  return installation(middleware, overrides).pipe(
    Effect.flatMap((installed) => outgoingThrough(subject, installed)),
    Effect.withSpan("outgoingFixture"),
  );
}

/** Runtime send operations over an installed firewall, such as an editable one. */
export function outgoingThrough(
  subject: Fixture,
  installed: InstalledFirewall,
) {
  return firewallRuntime(subject, installed).pipe(
    Effect.map((runtime) => runtime.delivery),
    Effect.withSpan("outgoingThrough"),
  );
}

/** Carol supplies an independent conversation using the same endpoint store. */
export function addConversation(subject: Fixture, authoredLocally = false) {
  return Effect.gen(function* () {
    const { authority, card } = subject.third;
    const membership = yield* directMembership(
      [subject.local.card, card],
      subject.signer,
    );
    const authors = authoredLocally
      ? { local: { card, authority }, remote: subject.local }
      : { local: subject.local, remote: { card, authority } };
    const record = yield* buildCertifiedGenesis(
      authors.local,
      authors.remote,
      membership,
      anchor.routerInstanceId,
    );
    yield* storeCertifiedGenesis(
      subject.store,
      subject.local.card,
      membership,
      record,
    );
    return { membership, record, remote: { card, authority } };
  }).pipe(Effect.withSpan("addConversation"));
}

/**
 * A policy that changes the evidence on every call, so each capture it
 * checks is stale by its commit.
 * @param subject The fixture whose store the policy writes to.
 * @returns The middleware and the number of calls it has seen.
 */
export function churnPolicy(subject: Fixture) {
  let calls = 0;
  return {
    count: () => calls,
    middleware: policy(() =>
      Effect.gen(function* () {
        calls += 1;
        yield* subject.store.putInboxItem({
          deliveryToken: Schema.decodeUnknownSync(DeliveryToken)(
            digest("dlv_", 120 + calls),
          ),
          canonicalItem: yield* encodeRuntimeValue({
            kind: "evidence changed",
          }),
        });
        return pass;
      }).pipe(Effect.orDie, Effect.withSpan("churnPolicy")),
    ),
  };
}

/** A complete registered norm delegates only its assessment to the test. */
export function policy(check: MessageMiddleware["check"]): MessageMiddleware {
  return { id: "communication", revision: "test-v1", rules: [rule], check };
}

/** A signed GENESIS seeds the default conversation without network traffic. */
export function seedIncoming(subject: Fixture, authoredLocally = false) {
  return Effect.gen(function* () {
    const { local, remote, membership, store } = subject;
    const record = yield* buildCertifiedGenesis(
      authoredLocally ? remote : local,
      authoredLocally ? local : remote,
      membership,
      anchor.routerInstanceId,
    );
    yield* storeCertifiedGenesis(store, local.card, membership, record);
    return record;
  }).pipe(Effect.withSpan("seedIncoming"));
}

function pendingMessages(store: EndpointStore) {
  return store.readPendingDeliveries().pipe(
    Effect.flatMap((entries) =>
      Effect.forEach(
        entries,
        (entry) =>
          Effect.gen(function* () {
            return {
              deliveryToken: entry.deliveryToken,
              recordHash: yield* Schema.decodeUnknown(RecordHash)(
                entry.recordHash,
              ),
              message: yield* decodeRuntimeValue(
                InboundMessage,
                entry.canonicalMessage,
              ),
            };
          }),
        { concurrency: 1 },
      ),
    ),
  );
}

/** One test agent's signing authority and the card the test Registry issued it. */
function signingIdentity(
  byte: number,
  name: string,
  registryKeys: Parameters<typeof issueTestCard>[0]["registryKeys"],
) {
  return Effect.gen(function* () {
    const authority = yield* makeTestAuthority();
    return {
      authority,
      card: yield* issueTestCard({ byte, name, authority, registryKeys }),
    };
  });
}

/** The verified membership of the direct conversation between two cards. */
function directMembership(
  cards: readonly [AgentCard, AgentCard],
  signer: Ed25519PublicKey,
) {
  return Effect.gen(function* () {
    const descriptor = yield* Schema.decodeUnknown(MembershipDescriptor)({
      sharnessVersion: WIRE_VERSION,
      kind: "membership_descriptor",
      conversationId: yield* deriveConversationId([
        cards[0].agentId,
        cards[1].agentId,
      ]),
      members: [
        yield* Schema.encode(AgentCard)(cards[0]),
        yield* Schema.encode(AgentCard)(cards[1]),
      ],
    });
    return yield* verifyMembershipDescriptor(descriptor, signer);
  });
}

/**
 * Run the admission worker for the test scope, publishing through `runPass`
 * after each committed admission.
 * @returns A queue that receives one value per completed admission.
 */
function startAdmission(
  delivery: Effect.Effect.Success<ReturnType<typeof makeHostDelivery>>,
  runPass: Effect.Effect<void, unknown>,
) {
  return Effect.gen(function* () {
    const completed = yield* Queue.unbounded<undefined>();
    yield* delivery
      .runAdmission(
        runPass.pipe(
          Effect.orDie,
          Effect.zipRight(Queue.offer(completed, undefined)),
          Effect.asVoid,
        ),
      )
      .pipe(Effect.forkScoped);
    return completed;
  });
}
