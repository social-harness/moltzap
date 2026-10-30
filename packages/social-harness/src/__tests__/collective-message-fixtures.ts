/** @file Scripted message ports retain their bindings and classifier inputs in real SQL. */

import { Effect, Schema } from "effect";
import { SqlClient } from "@effect/sql";
import {
  openTestDatabase,
  type TestDatabase,
} from "./communication-test-database.js";
import { testStore, storedConversation } from "./store-schema-fixtures.js";
import { encodeRuntimeValue } from "../communication/store/index.js";
import type { CertifiedMessage } from "../communication/collectives/ports.js";
import { generateKeyPairSync } from "node:crypto";
import type { CollectivePorts } from "../communication/collectives/ports.js";
import { canonicalMessageAddress } from "../communication/conversations/address.js";
import { SendError } from "../communication/conversations/errors.js";
import {
  type BindHold,
  type EngineSendInput,
  type PreparedSend,
  preparedSendData,
} from "../communication/conversations/index.js";
import {
  deriveConversationId,
  hashMembershipDescriptor,
  MembershipDescriptor,
  MessageAddressInput,
  MessageIntent,
} from "../communication/records/index.js";
import { compareAgentIds } from "../communication/records/values.js";
import { type CollectiveMessageBinding } from "../communication/store/index.js";
import { encodeCanonical } from "../encoding/canonical-json.js";
import { AgentCard, type VerifiedAgentCard } from "../identity/cards.js";
import { WIRE_VERSION } from "../identity/wire-version.js";
import {
  digest,
  issueTestCard,
  makeTestAuthority,
} from "./agent-card-fixtures.js";

interface StubEngine {
  readonly database: TestDatabase;
  readonly cards: readonly VerifiedAgentCard[];
  readonly local: VerifiedAgentCard;
  nextMessage: number;
}

/** Recording tests use canonical signed membership and fixed message identities. */
export function collectivePersistencePorts(
  sendMessage: CollectivePorts["sendMessage"],
  self = "agent:alice",
  firstMessageByte = 101,
  sql?: SqlClient.SqlClient,
) {
  return Effect.gen(function* () {
    const engine = yield* stubEngine(self, firstMessageByte, sql);
    const send: CollectivePorts["sendMessage"] = (input) =>
      engine.database
        .run(retainStubOperation(input.collective))
        .pipe(Effect.zipRight(sendMessage(input)));
    return {
      store: testStore,
      sql: engine.database.sql,
      run: engine.database.run,
      certifyInput: (message: CertifiedMessage) =>
        retainCertifiedInput(engine.database, message, engine.local.agentId),
      prepareMessage: (input: EngineSendInput) =>
        prepareStubMessage(engine, input),
      acceptMessage: <E>(prepared: PreparedSend, hold: BindHold<E>) =>
        acceptStubMessage(engine, send, prepared, hold),
      sendMessage: send,
      observeMessage: () => Effect.never,
      reportStorageFault: () => Effect.void,
    };
  }).pipe(Effect.withSpan("collectivePersistencePorts"));
}

function stubEngine(
  self: string,
  firstMessageByte: number,
  sql?: SqlClient.SqlClient,
) {
  return Effect.gen(function* () {
    const registryKeys = generateKeyPairSync("ed25519");
    const cards = yield* Effect.forEach(
      ["alice", "bob", "carol", "dave"],
      (name, index) =>
        makeTestAuthority().pipe(
          Effect.flatMap((authority) =>
            issueTestCard({ byte: index + 1, name, authority, registryKeys }),
          ),
        ),
      { concurrency: 1 },
    );
    const localName = self.startsWith("agent:") ? self.slice(6) : self;
    const local = cards.find((card) => card.agentName === localName);
    if (local === undefined) {
      return yield* Effect.dieMessage("unknown test member");
    }
    const database =
      sql === undefined
        ? yield* openTestDatabase()
        : {
            sql,
            store: testStore,
            run: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
              effect.pipe(Effect.provideService(SqlClient.SqlClient, sql)),
          };
    yield* database.run(
      testStore.bindIdentity({
        agentId: local.agentId,
        canonicalAgentCard: yield* encodeCanonical(AgentCard, local).pipe(
          Effect.orDie,
        ),
      }),
    );
    return {
      database,
      cards,
      local,
      nextMessage: firstMessageByte,
    } satisfies StubEngine;
  });
}

function retainStubOperation(collective?: CollectiveMessageBinding) {
  return collective?.operation === undefined
    ? Effect.void
    : testStore.putCollectiveOperation(collective.operation).pipe(Effect.orDie);
}

function prepareStubMessage(engine: StubEngine, input: EngineSendInput) {
  return Effect.gen(function* () {
    const descriptor = yield* stubMembership(engine, input);
    const membershipHash = yield* hashMembershipDescriptor(descriptor).pipe(
      Effect.orDie,
    );
    const intent = yield* Schema.decodeUnknown(MessageIntent)({
      sharnessVersion: WIRE_VERSION,
      kind: "message_intent",
      conversationId: descriptor.conversationId,
      membershipHash,
      authorAgentId: engine.local.agentId,
      msgId: digest("msg_", engine.nextMessage++),
      content: input.content,
    }).pipe(Effect.orDie);
    return {
      canonicalMembership: new TextDecoder().decode(
        yield* encodeCanonical(MembershipDescriptor, descriptor).pipe(
          Effect.orDie,
        ),
      ),
      canonicalIntent: new TextDecoder().decode(
        yield* encodeCanonical(MessageIntent, intent).pipe(Effect.orDie),
      ),
      ...(input.collective === undefined
        ? {}
        : { collective: input.collective }),
    };
  });
}

function stubMembership(engine: StubEngine, input: EngineSendInput) {
  return Effect.gen(function* () {
    const canonical = yield* canonicalMessageAddress(
      input.to,
      engine.local.agentName,
    );
    const names =
      canonical.kind === "direct"
        ? [engine.local.agentName, canonical.remoteName]
        : canonical.memberNames;
    const ordered = names
      .flatMap((name) => engine.cards.filter((card) => card.agentName === name))
      .sort((left, right) => compareAgentIds(left.agentId, right.agentId));
    if (ordered.length !== names.length) {
      return yield* new SendError({ reason: "unknown-agent" });
    }
    const [first, second, ...rest] = ordered;
    if (first === undefined || second === undefined) {
      return yield* new SendError({ reason: "membership-invalid" });
    }
    const conversationId = yield* deriveConversationId([
      first.agentId,
      second.agentId,
      ...rest.map((card) => card.agentId),
    ]).pipe(Effect.orDie);
    return yield* Schema.decodeUnknown(MembershipDescriptor)({
      sharnessVersion: WIRE_VERSION,
      kind: "membership_descriptor",
      conversationId,
      members: yield* Effect.forEach(
        ordered,
        (card) => Schema.encode(AgentCard)(card).pipe(Effect.orDie),
        { concurrency: 1 },
      ),
    }).pipe(Effect.orDie);
  });
}

function acceptStubMessage<E>(
  engine: StubEngine,
  send: CollectivePorts["sendMessage"],
  prepared: PreparedSend,
  hold: BindHold<E>,
) {
  return Effect.gen(function* () {
    const { descriptor, intent } = yield* preparedSendData(prepared);
    const decoded = yield* Effect.forEach(
      descriptor.members,
      (card) => Schema.decodeUnknown(AgentCard)(card).pipe(Effect.orDie),
      { concurrency: 1 },
    );
    const to =
      decoded.length === 2
        ? `agent:${decoded.find((card) => card.agentId !== engine.local.agentId)?.agentName ?? "unknown"}`
        : `group:${decoded.map((card) => card.agentName).join(",")}`;
    const canonical = yield* canonicalMessageAddress(
      Schema.decodeUnknownSync(MessageAddressInput)(to),
      engine.local.agentName,
    );
    const release = yield* hold;
    const foundation = {
      conversationId: intent.conversationId,
      membershipHash: intent.membershipHash,
      canonicalMembership: new TextEncoder().encode(
        prepared.canonicalMembership,
      ),
      anchorHash: `anchor:${intent.conversationId}`,
      canonicalAnchor: new TextEncoder().encode("recording message foundation"),
    };
    yield* testStore
      .bindMessageIntent({
        kind: "new-conversation",
        foundation,
        intent: {
          conversationId: intent.conversationId,
          membershipHash: intent.membershipHash,
          authorAgentId: intent.authorAgentId,
          msgId: intent.msgId,
          canonicalIntent: new TextEncoder().encode(prepared.canonicalIntent),
        },
        ...(prepared.collective === undefined
          ? {}
          : { collective: prepared.collective }),
      })
      .pipe(
        Effect.onError(() => release),
        Effect.mapError(() => new SendError({ reason: "persistence-failed" })),
      );
    return {
      certified: send({
        to: canonical.address,
        content: intent.content,
        ...(prepared.collective === undefined
          ? {}
          : { collective: prepared.collective }),
      }).pipe(Effect.map((result) => ({ ...result, msgId: intent.msgId }))),
    };
  }).pipe(Effect.provideService(SqlClient.SqlClient, engine.database.sql));
}

/** Classifier tests enter through retained certified delivery, whose verification belongs to communication. */
export function retainCertifiedInput(
  database: TestDatabase,
  input: CertifiedMessage,
  recipientAgentId: string,
) {
  return database.run(
    Effect.gen(function* () {
      const fixture = storedConversation(input.recordHash);
      const canonicalMessage = yield* encodeRuntimeValue(input.message);
      const record = {
        ...fixture.record,
        recordHash: input.recordHash,
        authorAgentId: input.message.sender.agentId,
        msgId: input.message.msgId,
        canonicalRecordCore: canonicalMessage,
        durabilityEvidence: fixture.record.durabilityEvidence.map((row) => ({
          ...row,
          subjectId: input.recordHash,
        })),
      };
      yield* testStore.putConversationFoundation(fixture.foundation);
      yield* testStore.applyCertifiedRecord(record, {
        recipientAgentId,
        canonicalMessage,
      });
    }).pipe(Effect.orDie),
  );
}
