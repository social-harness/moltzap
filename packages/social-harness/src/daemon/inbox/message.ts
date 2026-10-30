/** @file Verified message and history projections supply the exact text a host can observe. */

import { Clock, Effect, Option, Schema } from "effect";
import { createHash } from "node:crypto";
import type { Firewall, PreparedFirewallCheck } from "../../firewall/index.js";
import type {
  FirewallEvidence,
  FirewallHistoryEntry,
  FirewallInboxEntry,
  FirewallLocalEntry,
  FirewallStore,
} from "../../firewall/store/index.js";
import {
  type CollectiveValue,
  readCollectiveValue,
  withoutCollectivePart,
} from "../../communication/collectives/index.js";
import { renderGroupAddress } from "../../communication/conversations/address.js";
import {
  Content,
  deriveConversationId,
  MembershipDescriptor,
  MessageIntent,
  RecordCore,
} from "../../communication/records/index.js";
import {
  type AgentAddress,
  agentAddressOf,
  type MessageAddressInput,
} from "../../communication/records/values.js";
import {
  decodeRuntimeValue,
  encodeRuntimeValue,
  EndpointStoreError,
} from "../../communication/store/index.js";
import {
  decodeCanonical,
  encodeCanonical,
} from "../../encoding/canonical-json.js";
import { compareAgentIds } from "../../encoding/identifier.js";
import { HistoryEntry, Message, MessageContext } from "../../firewall/check.js";
import { InboundItem } from "../../host-protocol/items.js";
import {
  questionText,
  renderCollectiveRequestBody,
  renderContent,
  renderOutcome,
} from "../../host-protocol/render.js";
import {
  AgentCard,
  AgentView,
  type VerifiedAgentCard,
} from "../../identity/cards.js";

/** The daemon supplies verified attribution and its existing durable evidence capability. */
export interface FirewallEnvironment {
  readonly store: FirewallStore;
  readonly firewall: Firewall;
  readonly localAgentCard: VerifiedAgentCard;
}

/** A message as the firewall reads it, and whether the runtime can be shown it. */
interface MessageProjection {
  readonly message: Message;
  readonly supported: boolean;
}

/** A certified record decoded with its members' cards, its author's address and its projection. */
export interface DecodedRecord extends MessageProjection {
  readonly intent: MessageIntent;
  readonly cards: readonly AgentCard[];
  readonly author: AgentAddress;
}

/** One check's candidate, the evidence it is assessed against, and its attribution. */
export interface MessageCheckInput {
  readonly direction: "incoming" | "outgoing";
  readonly evidence: FirewallEvidence;
  readonly canonicalCandidate: Uint8Array;
  readonly message?: Message;
  readonly cards: readonly AgentCard[];
}

/**
 * Project one message by its collective part: a multicast as its text, a request
 * as exactly the question a member's model reads before the answer
 * instructions, and an answer as its line of a result. A close, or a message
 * whose part does not decode, is projected as its raw content and is never
 * runtime-visible.
 */
export const messageProjection = Effect.fn("firewallMessageProjection")(
  function* (
    intent: MessageIntent,
    cards: readonly AgentCard[],
    localAgentId: string,
  ) {
    const projected = yield* readCollectiveValue(intent.content).pipe(
      Effect.flatMap((part) =>
        projectPart(
          { intent, cards, localAgentId },
          Option.getOrUndefined(part),
        ),
      ),
      Effect.catchTag("CollectivePartInvalidError", () =>
        Effect.succeed<ProjectedText>({
          text: renderContent(intent.content),
          supported: false,
        }),
      ),
    );
    return {
      message: yield* decodeMessage({
        id: messageId(intent),
        sender: intent.authorAgentId,
        recipients: cards
          .map((card) => card.agentId)
          .filter((id) => id !== intent.authorAgentId),
        text: projected.text,
        ...(projected.operation === undefined
          ? {}
          : { operation: projected.operation }),
      }),
      supported: projected.supported,
    } satisfies MessageProjection;
  },
);

/** Decode one certified record with its members' cards, and project it. */
export const decodeRecord = Effect.fn("decodeFirewallRecord")(function* (
  entry: FirewallHistoryEntry,
  localAgentId: string,
) {
  const record = yield* decodeRuntimeValue(
    RecordCore,
    entry.canonicalRecordCore,
  );
  const membership = yield* decodeRuntimeValue(
    MembershipDescriptor,
    entry.canonicalMembership,
  );
  const cards = yield* Effect.forEach(
    membership.members,
    (card) => Schema.decodeUnknown(AgentCard)(card),
    { concurrency: 1 },
  ).pipe(
    Effect.catchTag("ParseError", () =>
      Effect.fail(new EndpointStoreError({ reason: "corrupt" })),
    ),
  );
  const intent = record.action.messageIntent;
  const authorCard = cards.find(
    (card) => card.agentId === intent.authorAgentId,
  );
  if (authorCard === undefined) {
    return yield* new EndpointStoreError({ reason: "corrupt" });
  }
  const projection = yield* messageProjection(intent, cards, localAgentId);
  return {
    ...projection,
    intent,
    cards,
    author: agentAddressOf(authorCard),
  } satisfies DecodedRecord;
});

/** Certified local sends are admitted evidence without granting host visibility to owner history. */
export const contextFrom = Effect.fn("firewallContext")(function* (
  environment: FirewallEnvironment,
  evidence: FirewallEvidence,
  candidateCards: readonly AgentCard[],
) {
  const localAgentId = environment.localAgentCard.agentId;
  const history = yield* Effect.forEach(
    evidence.history,
    (entry) => decodeHistory(entry, localAgentId),
    { concurrency: 1 },
  );
  const cards = new Map<string, AgentCard>();
  for (const card of [
    environment.localAgentCard,
    ...candidateCards,
    ...history.flatMap((entry) => entry.cards),
  ]) {
    cards.set(card.agentId, card);
  }
  const context = new MessageContext({
    agentId: localAgentId,
    principal: environment.localAgentCard.principalId,
    participants: [...cards.values()].map((card) => ({
      agentId: card.agentId,
      principal: card.principalId,
    })),
    history: history.map(({ entry }) => entry),
    earlierHistoryOmitted: evidence.earlierHistoryOmitted,
    now: yield* Clock.currentTimeMillis,
    facts: environment.firewall.configuration.facts,
    gaps: evidenceGaps(evidence),
  });
  return { context, cards: [...cards.values()] };
});

/**
 * A request's question exactly as a model reads it: the item's form after the
 * canonical round trip the inbox gives every stored item, so the schema's
 * keys are in the order the runtime renders.
 * @param item The request as an inbound item.
 * @returns The question's lines, before the answer instructions.
 */
export function requestText(
  item: Extract<InboundItem, { readonly kind: "collectiveRequest" }>,
): Effect.Effect<string, EndpointStoreError> {
  return encodeRuntimeValue(item).pipe(
    Effect.flatMap((bytes) => decodeRuntimeValue(InboundItem, bytes)),
    Effect.flatMap((stored) =>
      stored.kind === "collectiveRequest"
        ? Effect.succeed(renderCollectiveRequestBody(stored))
        : Effect.fail(new EndpointStoreError({ reason: "corrupt" })),
    ),
  );
}

/**
 * Validate a checked message, failing as corrupt when Client's own
 * projection does not decode.
 * @param value The message's fields.
 * @returns The validated message.
 */
export function decodeMessage(
  value: unknown,
): Effect.Effect<Message, EndpointStoreError> {
  return Schema.decodeUnknown(Message)(value).pipe(
    Effect.catchTag("ParseError", () =>
      Effect.fail(new EndpointStoreError({ reason: "corrupt" })),
    ),
  );
}

/**
 * A message's own fields, without its class, so a projection can replace
 * some of them.
 * @param message The checked message.
 * @returns Its id, attribution, text and any operation.
 */
export function messageFields(message: Message) {
  return {
    id: message.id,
    sender: message.sender,
    recipients: message.recipients,
    text: message.text,
    ...(message.operation === undefined
      ? {}
      : { operation: message.operation }),
  };
}

/**
 * A stable message id derived from an identity no two messages share.
 * @param identity The author-scoped identity the id stands for.
 * @returns The id a check and its guidance refer to.
 */
export function hashedId(identity: string): string {
  return `msg_${createHash("sha256").update(identity).digest("hex")}`;
}

/** A projected message's text and operation, before attribution. */
interface ProjectedText {
  readonly text: string;
  readonly operation?: Message["operation"];
  readonly supported: boolean;
}

/** The message a projection reads, and the local side it is read from. */
interface ProjectedMessage {
  readonly intent: MessageIntent;
  readonly cards: readonly AgentCard[];
  readonly localAgentId: string;
}

/**
 * Project a message's collective part; a message with none is plain text. An
 * answer's operation follows from its conversation: a gather's answers
 * travel in direct conversations, and an all_gather's in its group, which
 * always has at least three members.
 */
function projectPart(
  message: ProjectedMessage,
  value?: CollectiveValue,
): Effect.Effect<ProjectedText, EndpointStoreError> {
  const { intent, cards } = message;
  if (value === undefined) {
    return Effect.succeed({ text: textOf(intent.content), supported: true });
  }
  switch (value.kind) {
    case "operation":
      return value.op === "multicast"
        ? Effect.succeed({
            text: textOf(withoutCollectivePart(intent.content)),
            supported: true,
          })
        : projectRequest(message, value);
    case "response":
      return Effect.succeed({
        text: renderOutcome(
          value.action === "accept"
            ? { kind: "answered", content: value.content }
            : { kind: "declined" },
        ),
        operation: {
          kind: "answer",
          op: cards.length === 2 ? "gather" : "all_gather",
          operationId: value.operationId,
        },
        supported: true,
      });
    case "close":
      return Effect.succeed({
        text: renderContent(intent.content),
        supported: false,
      });
    default: {
      const exhaustive: never = value;
      return exhaustive;
    }
  }
}

/**
 * The text of content parts as a model reads it, or empty for none.
 * @param content The parts that remain once the collective part is removed.
 * @returns The rendered text.
 */
function textOf(content: ReadonlyArray<Content[number]>): string {
  const [first, ...rest] = content;
  return first === undefined ? "" : renderContent([first, ...rest]);
}

/** A request message's question, as the members it asks read it. */
function projectRequest(
  message: ProjectedMessage,
  value: Extract<
    CollectiveValue,
    { readonly kind: "operation"; readonly op: "gather" | "all_gather" }
  >,
): Effect.Effect<ProjectedText, EndpointStoreError> {
  const { intent, cards, localAgentId } = message;
  const author = cards.find((card) => card.agentId === intent.authorAgentId);
  if (author === undefined) {
    return Effect.fail(new EndpointStoreError({ reason: "corrupt" }));
  }
  return Effect.all([
    Effect.succeed(AgentView.make(author)),
    conversationAddress(cards, localAgentId),
  ]).pipe(
    Effect.flatMap(([from, to]) =>
      requestText({
        kind: "collectiveRequest",
        op: value.op,
        operationId: value.operationId,
        msgId: intent.msgId,
        from,
        to,
        question: questionText(intent.content),
        requestedSchema: value.requestedSchema,
        deadlineAt: value.deadlineAt,
      }),
    ),
    Effect.map(
      (text): ProjectedText => ({
        text,
        operation: {
          kind: "request",
          op: value.op,
          operationId: value.operationId,
          deadlineAt: value.deadlineAt,
        },
        supported: true,
      }),
    ),
  );
}

function messageId(intent: MessageIntent): string {
  return hashedId(`${intent.authorAgentId}:${intent.msgId}`);
}

/** One history entry and the cards its attribution needs. */
interface DecodedHistory {
  readonly entry: typeof HistoryEntry.Type;
  readonly cards: readonly AgentCard[];
}

/**
 * Decode one history entry. A record is runtime-visible when the runtime was
 * shown it: a message or request through the inbox, an answer through an
 * admitted result. A local evidence entry is the projection the runtime was
 * shown.
 */
function decodeHistory(
  entry: FirewallHistoryEntry | FirewallLocalEntry,
  localAgentId: string,
): Effect.Effect<DecodedHistory, EndpointStoreError> {
  return Effect.gen(function* () {
    if ("canonicalEntry" in entry) {
      return {
        entry: yield* decodeRuntimeValue(HistoryEntry, entry.canonicalEntry),
        cards: [],
      } satisfies DecodedHistory;
    }
    const decoded = yield* decodeRecord(entry, localAgentId);
    const shown =
      decoded.message.operation?.kind === "answer"
        ? entry.answer === "admitted"
        : entry.visible;
    const visible = shown && decoded.supported;
    return {
      entry: {
        ...messageFields(decoded.message),
        visibility: visible ? "runtime" : "assessor",
        admission:
          visible || decoded.message.sender === localAgentId
            ? "admitted"
            : "withheld",
      },
      cards: decoded.cards,
    } satisfies DecodedHistory;
  }).pipe(Effect.withSpan("decodeFirewallHistory"));
}

function evidenceGaps(evidence: FirewallEvidence): string[] {
  return [
    ...(evidence.overflow
      ? ["Authorized earlier history exceeds the 2 MiB evidence byte bound."]
      : []),
    ...(evidence.pendingOutgoing
      ? ["An earlier outgoing intent has not reached certified completion."]
      : []),
  ];
}

/**
 * The canonical address of a conversation from the local agent's side: the
 * other member's `agent:` address for a direct conversation, the complete
 * `group:` address otherwise. Local evidence is kept under it.
 * @param cards The conversation's members' cards.
 * @param localAgentId The local agent, whose side the address is from.
 * @returns The address hosts and local evidence name the conversation by.
 */
function conversationAddress(
  cards: readonly AgentCard[],
  localAgentId: string,
): Effect.Effect<MessageAddressInput, EndpointStoreError> {
  if (cards.length === 2) {
    const other = cards.find((card) => card.agentId !== localAgentId);
    return other === undefined
      ? Effect.fail(new EndpointStoreError({ reason: "corrupt" }))
      : Effect.succeed(agentAddressOf(other));
  }
  return renderGroupAddress(cards.map((card) => card.agentName)).pipe(
    Effect.map(({ address }): MessageAddressInput => address),
    Effect.catchTag("ParseError", () =>
      Effect.fail(new EndpointStoreError({ reason: "corrupt" })),
    ),
  );
}
/** One input joins exact candidate bytes with the permitted verified conversation view. */
export const prepareMessageCheck = Effect.fn("prepareMessageCheck")(function* (
  environment: FirewallEnvironment,
  input: MessageCheckInput,
): Effect.fn.Return<PreparedFirewallCheck, EndpointStoreError> {
  const { context, cards } = yield* contextFrom(
    environment,
    input.evidence,
    input.cards,
  );
  return {
    direction: input.direction,
    canonicalCandidate: input.canonicalCandidate,
    ...(input.message === undefined ? {} : { message: input.message }),
    context,
    agents: cards.map((card) => AgentView.make(card)),
  };
});

/** Data-only canonical candidate; no message binding or protocol claim is available to policy. */
export interface OutgoingCandidate {
  readonly to: MessageAddressInput;
  readonly gather: boolean;
  readonly messages: ReadonlyArray<{
    readonly canonicalIntent: string;
    readonly canonicalMembership: string;
  }>;
}

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
/** Prepared outgoing bytes and their exact recipients select one permitted evidence window. */
export const prepareOutgoingCheck = Effect.fn("prepareOutgoingCheck")(
  function* (
    environment: FirewallEnvironment,
    candidate: OutgoingCandidate,
  ): Effect.fn.Return<PreparedFirewallCheck, EndpointStoreError> {
    const { intent, cards, conversationId, canonicalCandidate } =
      yield* captureOutgoing(candidate);
    const evidence = yield* environment.store.readFirewallEvidence({
      conversationId,
      conversation: candidate.to,
      maximumRecords: environment.firewall.configuration.maximumHistoryRecords,
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
    return yield* prepareMessageCheck(environment, {
      direction: "outgoing",
      evidence,
      canonicalCandidate,
      message,
      cards,
    });
  },
);

/** A retained incoming item must match the certified record used as its candidate. */
export const prepareIncomingCheck = Effect.fn("prepareIncomingCheck")(
  function* (
    environment: FirewallEnvironment,
    entry: FirewallInboxEntry,
  ): Effect.fn.Return<PreparedFirewallCheck, EndpointStoreError> {
    const evidence = yield* environment.store.readFirewallEvidence({
      beforeDelivery: entry.deliveryToken,
      conversation: entry.conversation,
      maximumRecords: environment.firewall.configuration.maximumHistoryRecords,
    });
    const record =
      evidence.candidate === undefined
        ? undefined
        : yield* decodeRecord(
            evidence.candidate,
            environment.localAgentCard.agentId,
          );
    const item = yield* decodeRuntimeValue(InboundItem, entry.canonicalItem);
    const message =
      record === undefined
        ? undefined
        : yield* checkedIncomingProjection(item, record);
    return yield* prepareMessageCheck(environment, {
      direction: "incoming",
      evidence,
      canonicalCandidate: entry.canonicalItem,
      ...(message === undefined ? {} : { message }),
      cards: record?.cards ?? [],
    });
  },
);
