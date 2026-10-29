/**
 * @file How Client projects messages for its firewall, builds a check's context
 * from captured evidence, and runs one check. Outgoing and incoming
 * admission share these; neither holds a protocol or delivery lock.
 */

import { Clock, Effect, Option, Schema } from "effect";
import { createHash, randomBytes } from "node:crypto";
import { InboundItem } from "../../communication/collectives/inbound.js";
import {
  type CollectiveValue,
  readCollectiveValue,
  withoutCollectivePart,
} from "../../communication/collectives/index.js";
import {
  questionText,
  renderCollectiveRequestBody,
  renderContent,
  renderOutcome,
} from "../../communication/collectives/render.js";
import { renderGroupAddress } from "../../communication/conversations/address.js";
import {
  exitOutcome,
  markRetries,
} from "../../communication/conversations/index.js";
import {
  type Content,
  MembershipDescriptor,
  type MessageIntent,
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
  type EndpointStore,
  EndpointStoreError,
  type FirewallCompletion,
  type FirewallEvidence,
  type FirewallHistoryEntry,
  type FirewallLocalEntry,
  MAXIMUM_RUNTIME_ITEM_BYTES,
} from "../../communication/store/index.js";
import {
  AgentCard,
  AgentView,
  type VerifiedAgentCard,
} from "../../identity/cards.js";
import {
  type Firewall,
  type FirewallCheck,
  type FirewallPolicyOperations,
  HistoryEntry,
  Message,
  MessageContext,
  projectFeedback,
} from "../evaluator/index.js";
import {
  type CheckedGuidance,
  ENDPOINT_SENDER,
  FirewallSendError,
} from "../outcome/index.js";
import {
  type FirewallConfiguration,
  type FirewallInstallation,
  withoutTraces,
} from "./audit-records.js";

// safer-arch-ignore file-implicit-boundary-module: Outgoing and incoming admission share this one projection and assessment pipeline; admission/index.ts exposes only the installation and its admission ports.

/** Private immutable installation with one inference limit shared by both directions. */
export interface InstalledFirewall {
  /** Read once at the check boundary so an in-flight attempt retains its installation. */
  readonly current: () => InstalledFirewall;
  readonly policy: FirewallPolicyOperations;
  readonly configuration: FirewallConfiguration;
  readonly configurationDigest: string;
  readonly metadata: FirewallInstallation;
  readonly firewall: Firewall;
  readonly permits: Effect.Semaphore;
}

/** Store and verified local attribution remain outside middleware's data-only interface. */
export interface FirewallEnvironment {
  readonly store: EndpointStore;
  readonly installed: InstalledFirewall;
  readonly localAgentCard: VerifiedAgentCard;
}

/** One check's audit completion, its composed result, and the guidance it admits with, if any. */
export interface CheckedMessage {
  readonly completion: FirewallCompletion;
  readonly result: FirewallCheck;
  readonly guidance?: CheckedGuidance;
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
export interface AssessmentInput {
  readonly direction: "incoming" | "outgoing";
  readonly evidence: FirewallEvidence;
  readonly canonicalCandidate: Uint8Array;
  readonly message?: Message;
  readonly cards: readonly AgentCard[];
  readonly terminal: boolean;
}

/** What an attempt's audit input records beside the installation. */
interface AttemptFacts {
  readonly context: MessageContext;
  readonly agents: readonly AgentView[];
  readonly message: Message | null;
  readonly terminal: boolean;
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
  evidence: Omit<FirewallEvidence, "snapshot">,
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
  return new MessageContext({
    agentId: localAgentId,
    principal: environment.localAgentCard.principalId,
    participants: [...cards.values()].map((card) => ({
      agentId: card.agentId,
      principal: card.principalId,
    })),
    history: history.map(({ entry }) => entry),
    earlierHistoryOmitted: evidence.earlierHistoryOmitted,
    now: yield* Clock.currentTimeMillis,
    facts: environment.installed.configuration.facts,
    gaps: evidenceGaps(evidence),
  });
});

/**
 * Run one check: capture its context, begin its audit attempt, run the
 * middleware chain, and project its guidance. Guidance mode admits whatever
 * the chain decides; enforcement admits only an allowed message. The chain
 * is marked as `firewall-check` work under its direction, since its stages
 * export only as each ends and its bound is configurable.
 */
export const assess = Effect.fn("assessMessage")(function* (
  liveEnvironment: FirewallEnvironment,
  input: AssessmentInput,
) {
  const environment = captureEnvironment(liveEnvironment);
  const context = yield* contextFrom(environment, input.evidence, input.cards);
  const checkId = mintCheckId();
  yield* environment.store.beginFirewallAttempt({
    checkId,
    direction: input.direction,
    snapshot: input.evidence.snapshot,
    canonicalCandidate: input.canonicalCandidate,
    canonicalInput: yield* attemptInput(environment, {
      context,
      agents: [environment.localAgentCard, ...input.cards].map((card) =>
        AgentView.make(card),
      ),
      message: input.message ?? null,
      terminal: input.terminal,
    }),
  });
  const assessed = yield* runAssessment(environment, input, context).pipe(
    markRetries("firewall-check", input.direction, (exit) =>
      exitOutcome(exit, "checked"),
    ),
  );
  const projection = yield* guidanceProjection(assessed, input, context, {
    checkId,
    localAgentCard: environment.localAgentCard,
  });
  const { mode } = environment.installed.configuration;
  const admit = mode === "guidance" || projection.result.judgment === "allow";
  return {
    result: projection.result,
    completion: {
      checkId,
      admit,
      canonicalResult: yield* encodeRuntimeValue(
        withoutTraces(projection.result),
      ),
      ...(input.terminal && mode === "guidance"
        ? ({ shadow: true } as const)
        : {}),
    },
    ...(admit && projection.guidance !== undefined
      ? { guidance: projection.guidance }
      : {}),
  } satisfies CheckedMessage;
});

/**
 * The exact input an attempt's audit record retains: the installation, the
 * context, the checked message and whether the attempt is terminal.
 * @param environment The environment whose installation the check runs.
 * @param attempt The context, the message or null for none, and terminality.
 * @returns The canonical bytes the attempt is begun with.
 */
export function attemptInput(
  environment: FirewallEnvironment,
  attempt: AttemptFacts,
): Effect.Effect<Uint8Array, EndpointStoreError> {
  return encodeRuntimeValue({
    configurationDigest: environment.installed.configurationDigest,
    installation: environment.installed.metadata,
    ...attempt,
  });
}

/**
 * The environment with the installation current when a check starts, which
 * the check keeps throughout though an owner edit replaces it meanwhile.
 * @param environment The daemon's environment, whose installation may be live.
 * @returns The environment with that installation fixed.
 */
export function captureEnvironment(
  environment: FirewallEnvironment,
): FirewallEnvironment {
  return {
    ...environment,
    installed: environment.installed.current(),
  };
}

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
 * The canonical address of a conversation from the local agent's side: the
 * other member's `agent:` address for a direct conversation, the complete
 * `group:` address otherwise. Local evidence is kept under it.
 * @param cards The conversation's members' cards.
 * @param localAgentId The local agent, whose side the address is from.
 * @returns The address hosts and local evidence name the conversation by.
 */
export function conversationAddress(
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

/**
 * A fresh opaque check reference. Hex survives host credential redaction and
 * keeps native check correlation.
 * @returns `chk_` and 64 lowercase hexadecimal characters.
 */
export function mintCheckId(): string {
  return `chk_${randomBytes(32).toString("hex")}`;
}

/**
 * The send failure a refusing check returns. Projection deliberately excludes
 * provider diagnostics and assessor-only evidence.
 * @param checked The refusing check.
 * @returns The refusal with its check reference and registered feedback.
 */
export function refusedSend(checked: CheckedMessage): FirewallSendError {
  return new FirewallSendError({
    checkId: checked.completion.checkId,
    refusal: refusalReason(checked.result.reason),
    feedback: checked.result.feedback,
  });
}

/**
 * The refusal a check's reason names. An allowing reason never holds
 * anything, so a hold that names it reads as missing evidence.
 * @param reason The check's composed reason.
 * @returns The closed refusal hosts read.
 */
export function refusalReason(
  reason: FirewallCheck["reason"],
): FirewallSendError["refusal"] {
  return reason === "eligible" ? "unresolved-evidence" : reason;
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
          id: value.id,
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
        id: value.id,
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
          id: value.id,
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

function evidenceGaps(evidence: Omit<FirewallEvidence, "snapshot">): string[] {
  return [
    ...(evidence.overflow
      ? ["Authorized earlier history exceeds the 2 MiB evidence byte bound."]
      : []),
    ...(evidence.pendingOutgoing
      ? ["An earlier outgoing intent has not reached certified completion."]
      : []),
  ];
}

/** A terminal attempt holds without asking the provider, after two stale captures. */
function runAssessment(
  environment: FirewallEnvironment,
  input: AssessmentInput,
  context: MessageContext,
) {
  if (input.terminal) {
    return Effect.succeed(unavailable("unresolved-evidence"));
  }
  if (input.message === undefined) {
    return Effect.succeed(unavailable("check-unavailable"));
  }
  const check =
    input.direction === "incoming"
      ? environment.installed.firewall.checkIncoming(input.message, context)
      : environment.installed.firewall.checkOutgoing(input.message, context);
  return check.pipe(
    Effect.catchTag("CheckInputError", () =>
      Effect.succeed(unavailable("check-unavailable")),
    ),
  );
}

/**
 * Projection failure holds enforcement while shadow admission omits unusable
 * advice. An outgoing check advises its sender only of the norm judgments
 * left unsettled; the settled outgoing expectations are what its
 * conformance assessed.
 */
function guidanceProjection(
  result: FirewallCheck,
  input: AssessmentInput,
  context: MessageContext,
  capture: { readonly checkId: string; readonly localAgentCard: AgentCard },
): Effect.Effect<
  { readonly result: FirewallCheck; readonly guidance?: CheckedGuidance },
  EndpointStoreError
> {
  return Effect.gen(function* () {
    const instructions =
      input.direction === "incoming"
        ? result.guidance
        : result.guidance.filter((entry) => "uncertain" in entry);
    if (instructions.length === 0) {
      return { result };
    }
    const selected = new Set(
      instructions.flatMap((entry) =>
        "uncertain" in entry ? [] : entry.subjects,
      ),
    );
    const history = yield* Effect.forEach(
      input.evidence.history,
      (entry) => decodeHistory(entry, capture.localAgentCard.agentId),
      { concurrency: 1 },
    );
    const subjects = guidanceSubjects(selected, input, context, [
      ...history.flatMap((entry) => entry.cards),
      ...input.cards,
      capture.localAgentCard,
    ]);
    const guidance: CheckedGuidance = {
      checkId: capture.checkId,
      instructions,
      subjects,
    };
    const bytes = yield* encodeRuntimeValue(guidance);
    if (
      subjects.length !== selected.size ||
      bytes.byteLength + input.canonicalCandidate.byteLength >
        MAXIMUM_RUNTIME_ITEM_BYTES
    ) {
      return {
        result: { ...unavailable("check-unavailable"), checks: result.checks },
      };
    }
    return { result, guidance };
  }).pipe(Effect.withSpan("guidanceProjection"));
}

/** Only already admitted history and the incoming candidate can explain a selected subject. */
function guidanceSubjects(
  selected: ReadonlySet<string>,
  input: AssessmentInput,
  context: MessageContext,
  cards: readonly AgentCard[],
): CheckedGuidance["subjects"] {
  const agents = new Map<string, AgentView>(
    cards.map((card) => [card.agentId, AgentView.make(card)]),
  );
  const available = context.history.filter(
    (entry) => entry.visibility === "runtime" && entry.admission === "admitted",
  );
  const candidate = input.message === undefined ? [] : [input.message];
  const subjects = new Map(
    [...available, ...candidate].map((entry) => [entry.id, entry]),
  );
  return [...subjects.values()]
    .filter((entry) => selected.has(entry.id))
    .flatMap((entry) => {
      const sender =
        entry.sender === ENDPOINT_SENDER
          ? ENDPOINT_SENDER
          : agents.get(entry.sender);
      const recipients = entry.recipients.flatMap((identity) => {
        const agent = agents.get(identity);
        return agent === undefined ? [] : [agent];
      });
      return sender === undefined ||
        recipients.length !== entry.recipients.length
        ? []
        : [{ id: entry.id, sender, recipients, text: entry.text }];
    });
}

/**
 * The hold a check returns when it cannot run.
 * @param reason Why the check holds.
 * @returns A hold with the registered feedback for that reason.
 */
function unavailable(
  reason: "check-unavailable" | "unresolved-evidence",
): FirewallCheck {
  return {
    judgment: "hold",
    reason,
    feedback: projectFeedback([], [], reason),
    guidance: [],
    checks: [],
  };
}
