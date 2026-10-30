/** @file Captured message assessment is independent of ordinary communication acceptance. */
import { Effect, Option, Schema } from "effect";
import type { MessageAddressInput } from "../../communication/records/values.js";
import type { Message } from "../evaluator/index.js";
import type { FirewallInboxEntry } from "../store/index.js";
import { readCollectiveValue } from "../../communication/collectives/index.js";
import {
  Content,
  deriveConversationId,
  MembershipDescriptor,
  MessageIntent,
} from "../../communication/records/index.js";
import {
  decodeRuntimeValue,
  EndpointStoreError,
} from "../../communication/store/index.js";
import {
  decodeCanonical,
  encodeCanonical,
} from "../../encoding/canonical-json.js";
import { compareAgentIds } from "../../encoding/identifier.js";
import { InboundItem } from "../../host-protocol/items.js";
import { questionText, renderContent } from "../../host-protocol/render.js";
import {
  AgentCard,
  AgentView,
  type VerifiedAgentCard,
} from "../../identity/cards.js";
import {
  assess,
  type CheckedMessage,
  type DecodedRecord,
  decodeMessage,
  decodeRecord,
  type FirewallEnvironment,
  hashedId,
  messageProjection,
  refusedSend,
  requestText,
} from "./firewall-checks.js";

/** Data-only canonical candidate; no message binding or protocol claim is available to policy. */
export interface OutgoingCandidate {
  readonly to: MessageAddressInput;
  readonly gather: boolean;
  readonly messages: ReadonlyArray<{
    readonly canonicalIntent: string;
    readonly canonicalMembership: string;
  }>;
}

/** Check captured bytes once and retain the resulting judgment before ordinary protocol acceptance. */
export const checkOutgoing = (
  environment: FirewallEnvironment,
  candidate: OutgoingCandidate,
) =>
  environment.installed.permits
    .withPermits(1)(
      Effect.gen(function* () {
        const { intent, cards, conversationId, canonicalCandidate } =
          yield* captureOutgoing(candidate);
        const evidence = yield* environment.store.readFirewallEvidence({
          conversationId,
          conversation: candidate.to,
          maximumRecords:
            environment.installed.configuration.maximumHistoryRecords,
        });
        const message = candidate.gather
          ? yield* gatherMessage(
              environment.localAgentCard,
              candidate.to,
              intent,
              cards,
            )
          : (yield* messageProjection(
              intent,
              cards,
              environment.localAgentCard.agentId,
            )).message;
        const checked = yield* assess(environment, {
          direction: "outgoing",
          evidence,
          canonicalCandidate,
          message,
          cards,
        });
        yield* environment.store.completeFirewallAttempt(
          checked.completion,
          "outgoing",
          canonicalCandidate,
        );
        if (!checked.completion.admit) {
          return yield* refusedSend(checked);
        }
        return checked.guidance;
      }),
    )
    .pipe(Effect.withSpan("checkOutgoing"));

function captureOutgoing(candidate: OutgoingCandidate) {
  return Effect.gen(function* () {
    const messages = yield* Effect.forEach(
      candidate.messages,
      decodeOutgoingMessage,
      { concurrency: 1 },
    );
    const [first] = messages;
    if (first === undefined) {
      return yield* new EndpointStoreError({ reason: "invalid-input" });
    }
    const cards = yield* outgoingCards(
      messages.flatMap(({ membership }) => membership.members),
    );
    const [one, two, ...rest] = cards;
    if (one === undefined || two === undefined) {
      return yield* new EndpointStoreError({ reason: "invalid-input" });
    }
    const conversationId = candidate.gather
      ? yield* deriveConversationId([
          one.agentId,
          two.agentId,
          ...rest.map((card) => card.agentId),
        ]).pipe(
          Effect.catchTag("ClientRepresentationError", () =>
            Effect.fail(new EndpointStoreError({ reason: "invalid-input" })),
          ),
        )
      : first.intent.conversationId;
    const canonicalCandidate = candidate.gather
      ? yield* encodeCanonical(Content, first.intent.content).pipe(
          Effect.catchTag("ClientRepresentationError", () =>
            Effect.fail(new EndpointStoreError({ reason: "invalid-input" })),
          ),
        )
      : new TextEncoder().encode(candidate.messages[0]?.canonicalIntent);
    return { intent: first.intent, cards, conversationId, canonicalCandidate };
  });
}

function decodeOutgoingMessage(message: OutgoingCandidate["messages"][number]) {
  return Effect.all({
    intent: decodeCanonical(
      MessageIntent,
      new TextEncoder().encode(message.canonicalIntent),
    ),
    membership: decodeCanonical(
      MembershipDescriptor,
      new TextEncoder().encode(message.canonicalMembership),
    ),
  }).pipe(
    Effect.catchTag("ClientRepresentationError", () =>
      Effect.fail(new EndpointStoreError({ reason: "invalid-input" })),
    ),
  );
}

function outgoingCards(
  members: ReadonlyArray<MembershipDescriptor["members"][number]>,
) {
  return Effect.forEach(
    members,
    (card) =>
      Schema.decodeUnknown(AgentCard)(card).pipe(
        Effect.catchTag("ParseError", () =>
          Effect.fail(new EndpointStoreError({ reason: "invalid-input" })),
        ),
      ),
    { concurrency: 1 },
  ).pipe(
    Effect.map((cards) =>
      [...new Map(cards.map((card) => [card.agentId, card])).values()].sort(
        (left, right) => compareAgentIds(left.agentId, right.agentId),
      ),
    ),
  );
}

/** The certified record alone supplies incoming author and audience attribution. */
export const checkIncoming = (
  environment: FirewallEnvironment,
  entry: FirewallInboxEntry,
): Effect.Effect<CheckedMessage, EndpointStoreError> =>
  environment.installed.permits
    .withPermits(1)(
      Effect.gen(function* () {
        const evidence = yield* environment.store.readFirewallEvidence({
          beforeDelivery: entry.deliveryToken,
          conversation: entry.conversation,
          maximumRecords:
            environment.installed.configuration.maximumHistoryRecords,
        });
        const record =
          evidence.candidate === undefined
            ? undefined
            : yield* decodeRecord(
                evidence.candidate,
                environment.localAgentCard.agentId,
              );
        const item = yield* decodeRuntimeValue(
          InboundItem,
          entry.canonicalItem,
        );
        const message =
          record === undefined
            ? undefined
            : yield* checkedIncomingProjection(item, record);
        return yield* assess(environment, {
          direction: "incoming",
          evidence,
          canonicalCandidate: entry.canonicalItem,
          ...(message === undefined ? {} : { message }),
          cards: record?.cards ?? [],
        });
      }),
    )
    .pipe(Effect.withSpan("checkIncoming"));

/** The whole fixed gather is assessed once, using the same question each prepared request carries. */
function gatherMessage(
  local: VerifiedAgentCard,
  to: MessageAddressInput,
  intent: typeof MessageIntent.Type,
  cards: readonly AgentCard[],
) {
  return Effect.gen(function* () {
    const part = yield* readCollectiveValue(intent.content).pipe(
      Effect.catchTag("CollectivePartInvalidError", () =>
        Effect.fail(new EndpointStoreError({ reason: "invalid-input" })),
      ),
    );
    if (
      Option.isNone(part) ||
      part.value.kind !== "operation" ||
      part.value.op !== "gather"
    ) {
      return yield* new EndpointStoreError({ reason: "invalid-input" });
    }
    const value = part.value;
    return yield* decodeMessage({
      id: hashedId(`${local.agentId}:${value.operationId}`),
      sender: local.agentId,
      recipients: cards
        .filter((card) => card.agentId !== local.agentId)
        .map((card) => card.agentId),
      text: yield* requestText({
        kind: "collectiveRequest",
        op: "gather",
        operationId: value.operationId,
        msgId: intent.msgId,
        from: AgentView.make(local),
        to,
        question: questionText(intent.content),
        requestedSchema: value.requestedSchema,
        deadlineAt: value.deadlineAt,
      }),
      operation: {
        kind: "request",
        op: "gather",
        operationId: value.operationId,
        deadlineAt: value.deadlineAt,
      },
    });
  });
}

/**
 * The checked message of an item derived from a certified record: the
 * record's own projection, after the item is confirmed to be that record's.
 */
function checkedIncomingProjection(
  item: InboundItem,
  candidate: DecodedRecord,
): Effect.Effect<Message, EndpointStoreError> {
  const same =
    item.kind === "multicast"
      ? sameMulticast(item, candidate)
      : item.kind === "collectiveRequest" && sameRequest(item, candidate);
  return same
    ? Effect.succeed(candidate.message)
    : Effect.fail(new EndpointStoreError({ reason: "corrupt" }));
}

function sameMulticast(
  item: Extract<InboundItem, { readonly kind: "multicast" }>,
  candidate: DecodedRecord,
): boolean {
  const plainMessage =
    candidate.supported && candidate.message.operation === undefined;
  return (
    plainMessage &&
    sameMessage(item.message, candidate) &&
    renderContent(item.message.content) === candidate.message.text &&
    sameAudience(item.message, candidate.cards)
  );
}

function sameRequest(
  item: Extract<InboundItem, { readonly kind: "collectiveRequest" }>,
  candidate: DecodedRecord,
): boolean {
  const operation = candidate.message.operation;
  const sameOperation =
    operation?.kind === "request" &&
    operation.operationId === item.operationId &&
    operation.op === item.op;
  return (
    sameOperation &&
    sameMessage({ msgId: item.msgId, sender: item.from }, candidate)
  );
}

function sameMessage(
  message: { readonly msgId: string; readonly sender: AgentView },
  candidate: DecodedRecord,
): boolean {
  return (
    message.msgId === candidate.intent.msgId &&
    candidate.cards.some(
      (card) =>
        card.agentId === candidate.intent.authorAgentId &&
        Schema.equivalence(AgentView)(AgentView.make(card), message.sender),
    )
  );
}

function sameAudience(
  message: Extract<InboundItem, { kind: "multicast" }>["message"],
  cards: readonly AgentCard[],
): boolean {
  if (message.kind === "direct") {
    return cards.length === 2;
  }
  const expected = cards.map((card) => AgentView.make(card));
  return (
    expected.length === message.members.length &&
    message.members.every((member) =>
      expected.some((card) => Schema.equivalence(AgentView)(card, member)),
    )
  );
}
