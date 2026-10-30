/** @file Collective algorithm tests stub persistence; SQLite restart tests exercise durability. */

import { Effect, Schema } from "effect";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import type { CollectivePorts } from "../communication/collectives/ports.js";
import { CollectiveId } from "../communication/collectives/contracts.js";
import { collectiveRequesterOf } from "../communication/collectives/wire/index.js";
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
import {
  type CollectiveMessageBinding,
  type CollectiveOperationInput,
  DeliveryToken,
  EndpointStoreError,
  type StoredCollectiveOperation,
} from "../communication/store/index.js";
import { encodeCanonical } from "../encoding/canonical-json.js";
import { AgentCard, type VerifiedAgentCard } from "../identity/cards.js";
import { WIRE_VERSION } from "../identity/wire-version.js";
import {
  digest,
  issueTestCard,
  makeTestAuthority,
} from "./agent-card-fixtures.js";

interface StubEngine {
  readonly store: CollectivePorts["store"];
  readonly cards: readonly VerifiedAgentCard[];
  readonly local: VerifiedAgentCard;
  nextMessage: number;
}

/** Recording tests use canonical signed membership and fixed message identities. */
export function collectivePersistencePorts(
  sendMessage: CollectivePorts["sendMessage"],
  self = "agent:alice",
) {
  return Effect.gen(function* () {
    const engine = yield* stubEngine(self);
    const send: CollectivePorts["sendMessage"] = (input) =>
      retainStubOperation(engine, input.collective).pipe(
        Effect.zipRight(sendMessage(input)),
      );
    return {
      store: engine.store,
      prepareMessage: (input: EngineSendInput) =>
        prepareStubMessage(engine, input),
      acceptMessage: <E>(prepared: PreparedSend, hold: BindHold<E>) =>
        acceptStubMessage(engine, send, prepared, hold),
      sendMessage: send,
      observeMessage: () => Effect.never,
      reportStorageFault: () => Effect.void,
    } satisfies Omit<CollectivePorts, "emit" | "scope" | "self">;
  }).pipe(Effect.withSpan("collectivePersistencePorts"));
}

/** A recording store for classifier-only fixtures whose messages bypass the real certification engine. */
export function collectiveStorageStub(): CollectivePorts["store"] {
  const operations = new Map<string, StoredCollectiveOperation>();
  return {
    putCollectiveOperation: (input) => recordOperation(operations, input),
    readCollectiveOperation: (operationId) =>
      Effect.sync(() => operations.get(operationId)),
    readCollectiveOperations: () => Effect.sync(() => [...operations.values()]),
    readCollectiveMessages: () => Effect.succeed([]),
    recordCollectiveAnswer: (answer) => Effect.succeed(answer.recordHash),
    readCollectiveAnswers: () => Effect.succeed([]),
    recordCollectiveRefusal: () => Effect.void,
    readCollectiveRefusals: () => Effect.succeed([]),
    finalizeCollectiveOperation: (operationId, selection) =>
      finalizeOperation(operations, operationId, selection),
    retireCollectiveOperation: (operationId, canonicalSelection) =>
      Effect.sync(() => {
        const operation = operations.get(operationId);
        if (operation !== undefined) {
          operations.set(operationId, {
            ...operation,
            canonicalSelection,
            phase: "completed",
          });
        }
      }),
    readRetainedDeliveries: () => Effect.succeed([]),
  };
}

function stubEngine(self: string) {
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
    return {
      store: collectiveStorageStub(),
      cards,
      local,
      nextMessage: 0,
    } satisfies StubEngine;
  });
}

function retainStubOperation(
  engine: StubEngine,
  collective?: CollectiveMessageBinding,
) {
  return collective?.operation === undefined
    ? Effect.void
    : engine.store
        .putCollectiveOperation(collective.operation)
        .pipe(Effect.orDie);
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
      msgId: digest("msg_", 101 + engine.nextMessage++),
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
    yield* hold;
    yield* retainStubOperation(engine, prepared.collective);
    return {
      certified: send({
        to: canonical.address,
        content: intent.content,
        ...(prepared.collective === undefined
          ? {}
          : { collective: prepared.collective }),
      }).pipe(Effect.map((result) => ({ ...result, msgId: intent.msgId }))),
    };
  });
}

function recordOperation(
  operations: Map<string, StoredCollectiveOperation>,
  input: CollectiveOperationInput,
) {
  return Effect.sync(() => {
    if (operations.has(input.operationId)) {
      return "existing" as const;
    }
    operations.set(input.operationId, {
      ...input,
      creatorAgentId: collectiveRequesterOf(
        Schema.decodeUnknownSync(CollectiveId)(input.operationId),
      ),
      origin:
        input.origin.kind === "local"
          ? input.origin
          : { ...input.origin, conversationId: "fixture-conversation" },
      phase: "collecting",
      deliveryToken: Schema.decodeUnknownSync(DeliveryToken)(
        `dlv_${randomBytes(32).toString("base64url")}`,
      ),
    });
    return "inserted" as const;
  });
}

function finalizeOperation(
  operations: Map<string, StoredCollectiveOperation>,
  operationId: string,
  canonicalSelection: Uint8Array,
) {
  return Effect.suspend(() => {
    const operation = operations.get(operationId);
    if (operation === undefined) {
      return Effect.fail(new EndpointStoreError({ reason: "not-found" }));
    }
    operations.set(operationId, {
      ...operation,
      canonicalSelection,
      phase: "finalizing",
    });
    return Effect.succeed("inserted" as const);
  });
}
