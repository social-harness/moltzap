/** @file Runs collective sends and classifies certified messages for one active identity. */

import {
  Clock,
  Effect,
  Array as EffectArray,
  Exit,
  Fiber,
  Option,
  Schema,
} from "effect";
import type { AgentAddress, MessageAddressInput } from "../records/index.js";
import type { InboundItem } from "./inbound.js";
import type {
  CertifiedMessage,
  CollectivePorts,
  CollectiveSendError,
  MessageClassifier,
} from "./ports.js";
import type { PreparedCollective } from "./prepared.js";
import {
  decodeCanonical,
  encodeCanonical,
} from "../../encoding/canonical-json.js";
import { AgentCard, AgentView } from "../../identity/cards.js";
import { canonicalMessageAddress } from "../conversations/address.js";
import { SendError } from "../conversations/errors.js";
import { preparedSendData, resolutionFailure } from "../conversations/index.js";
import { InboundMessage } from "../conversations/message.js";
import { agentAddressOf } from "../records/values.js";
import { encodeRuntimeValue, EndpointStoreError } from "../store/index.js";
import { applyClose, receiveClose, recordPeerAnswer } from "./all-gather.js";
import {
  armRetainedGather,
  completeGather,
  forgetGather,
  markRefused,
  openGather,
  recordCountedAnswer,
  recordRefusal,
  releaseUnboundGather,
  updateGather,
} from "./completion.js";
import {
  type CollectiveEmitError,
  CollectiveError,
  type CollectiveFailure,
  type CollectiveId,
  type CollectiveOperation,
  type CollectiveSendOutcome,
  describeIssues,
  SendInput,
} from "./contracts.js";
import {
  durableEmit,
  durableSend,
  refreshRetained,
  refreshRetainedSend,
} from "./persistence.js";
import { type ReceivedRequest, receivedRequest } from "./received-request.js";
import { recoverCollectives } from "./recovery.js";
import {
  fanOutRequests,
  gatherAddress,
  messageRefusal,
  operationTimes,
  requestsSoFar,
  requestWait,
  withinRequestWait,
} from "./request-sends.js";
import {
  acceptResponse,
  prepareResponse,
  restoreResponse,
} from "./responses.js";
import {
  type CollectiveState,
  encodeLocalCollective,
  type PreparedGather,
} from "./state.js";
import {
  type CollectiveValue,
  encodeCollectiveContent,
  FormModeSchema,
  mintCollectiveId,
  readCollectiveValue,
  type ResponseValue,
  withoutCollectivePart,
} from "./wire/index.js";

/** The daemon's collective layer for one active identity. */
export interface CollectiveOperations {
  /** Validate an operation and capture its exact destinations, content and message identities. */
  readonly prepare: (
    input: SendInput,
  ) => Effect.Effect<PreparedCollective, CollectiveSendError>;
  /** Take protocol custody of the captured operation while its request and deadline remain live. */
  readonly accept: (
    prepared: PreparedCollective,
  ) => Effect.Effect<CollectiveSendOutcome, CollectiveSendError>;
  /** Certified traffic is classified without exposing host-local presentation state. */
  readonly classify: MessageClassifier;
}

type MessageContent = InboundMessage["content"];

/** Request fanout returns only messages certified during this invocation. */
type RequestSendOutcome = Pick<CollectiveSendOutcome, "msgIds">;

type CollectingOperation = Extract<
  CollectiveOperation,
  { readonly deadline: number }
>;

type CollectingValue = Extract<
  CollectiveValue,
  { readonly kind: "operation"; readonly op: "gather" | "all_gather" }
>;

const contentInvalid = () => new SendError({ reason: "content-invalid" });

const collectiveFailure = (
  operationId: CollectiveId,
  failure: CollectiveFailure,
) => new CollectiveError({ operationId, failure });

/**
 * Build the collective layer for one active identity.
 * @param ports The daemon's message sending, item queue, scope and identity.
 * @returns Send and classification after retained operation state is reconstructed.
 */
export const makeCollectiveOperations = (
  ports: CollectivePorts,
): Effect.Effect<CollectiveOperations, EndpointStoreError> =>
  Effect.gen(function* () {
    const state: CollectiveState = {
      ports,
      transitions: yield* Effect.makeSemaphore(1),
      gathers: new Map(),
      requests: new Map(),
      announced: new Set(),
      retained: new Map(),
      counted: new Map(),
      recovering: true,
    };
    yield* recoverCollectives(state, {
      open: (prepared) => openGather(state, prepared, true),
      classify: (message) => classify(state, message),
      restoreResponse: (message) => restoreResponse(state, message),
      close: (asked, close) => applyClose(state, asked, close),
      complete: (operationId) => completeGather(state, operationId),
      refuse: (operationId, refusal) =>
        recordRefusal(state, operationId, refusal),
    });
    return {
      prepare: (input) => prepareOperation(state, input),
      accept: (prepared) => acceptOperation(state, prepared),
      classify: (message) => classify(state, message),
    } satisfies CollectiveOperations;
  }).pipe(Effect.withSpan("makeCollectiveOperations"));

function prepareOperation(
  state: CollectiveState,
  input: SendInput,
): Effect.Effect<PreparedCollective, CollectiveSendError> {
  return encodeCanonical(SendInput, input).pipe(
    Effect.flatMap((bytes) => decodeCanonical(SendInput, bytes)),
    Effect.mapError(contentInvalid),
    Effect.flatMap((captured) => prepareCapturedOperation(state, captured)),
  );
}

function prepareCapturedOperation(
  state: CollectiveState,
  input: SendInput,
): Effect.Effect<PreparedCollective, CollectiveSendError> {
  if ("collectiveResponse" in input) {
    return prepareResponse(state, input.to, input.collectiveResponse).pipe(
      Effect.map((response) => ({ kind: "response", response })),
    );
  }
  if (
    input.collective?.op === "gather" ||
    input.collective?.op === "all_gather"
  ) {
    return prepareGather(state, input.to, input.text, input.collective).pipe(
      Effect.map((gather) => ({ kind: "collective", gather })),
    );
  }
  return Effect.gen(function* () {
    const content = yield* encodeCollectiveContent(
      { kind: "operation", op: "multicast" },
      input.text,
    ).pipe(Effect.mapError(contentInvalid));
    const { address } = yield* canonicalMessageAddress(
      input.to,
      state.ports.self.agentName,
    );
    const message = yield* state.ports
      .prepareMessage({ to: address, content })
      .pipe(
        Effect.catchTag("RecipientResolutionError", (error) =>
          Effect.fail(resolutionFailure(error)),
        ),
      );
    return {
      kind: "multicast",
      to: address,
      message,
    } satisfies PreparedCollective;
  });
}

function acceptOperation(
  state: CollectiveState,
  prepared: PreparedCollective,
): Effect.Effect<CollectiveSendOutcome, CollectiveSendError> {
  switch (prepared.kind) {
    case "response":
      return acceptResponse(state, prepared.response);
    case "multicast":
      return state.ports
        .acceptMessage(prepared.message, Effect.succeed(Effect.void))
        .pipe(
          Effect.flatMap(({ certified }) => certified),
          Effect.map(({ msgId }) => ({
            kind: "multicast",
            msgId,
            msgIds: [msgId],
            address: prepared.to,
          })),
        );
    case "collective":
      return (
        prepared.gather.open.op === "gather"
          ? gatherRequests(state, prepared.gather)
          : sendGroupRequest(state, prepared.gather)
      ).pipe(
        Effect.map((sent) => ({
          ...sent,
          kind: "collective",
          operationId: prepared.gather.operationId,
        })),
      );
    default:
      return prepared satisfies never;
  }
}

/** All request identities and memberships are fixed before local assessment. */
function prepareGather(
  state: CollectiveState,
  requestedTo: MessageAddressInput,
  question: string,
  input: CollectingOperation,
): Effect.Effect<PreparedGather, SendError | CollectiveError> {
  return Effect.gen(function* () {
    const { self } = state.ports;
    const { op, deadline, requestedSchema: schema } = input;
    const operationId = yield* mintCollectiveId(self.agentId);
    const { to, members: addresses } = yield* gatherAddress(
      requestedTo,
      agentAddressOf(self),
      op,
    );
    const requestedSchema = yield* formModeSchema(operationId, schema);
    const times = yield* operationTimes(deadline);
    const content = yield* requestContent(
      operationId,
      { op, deadlineAt: times.deadlineAt, requestedSchema },
      question,
    );
    const requests = yield* prepareRequests(state, {
      operationId,
      op,
      to,
      addresses,
      content,
    });
    const ordered = yield* preparedMembers(state, requests, addresses);
    const [head, ...tail] = ordered;
    if (head === undefined) {
      return yield* contentInvalid();
    }
    return yield* retainPreparedGather(
      operationId,
      {
        op,
        to,
        question,
        members: [head, ...tail] as const,
        requestedSchema,
        content,
        ...times,
        requests: retainedRequests(requests),
      },
      requests,
    );
  });
}

function requestContent(
  operationId: CollectiveId,
  input: {
    readonly op: "gather" | "all_gather";
    readonly deadlineAt: number;
    readonly requestedSchema: FormModeSchema;
  },
  question: string,
) {
  return encodeCollectiveContent(
    { kind: "operation", operationId, ...input },
    question,
  ).pipe(Effect.mapError(contentInvalid));
}

function retainedRequests(requests: PreparedGather["requests"]) {
  return requests.map(({ to, message }) => ({
    to,
    message: {
      canonicalIntent: message.canonicalIntent,
      canonicalMembership: message.canonicalMembership,
    },
  }));
}

function retainPreparedGather(
  operationId: CollectiveId,
  descriptor: Parameters<typeof encodeLocalCollective>[1],
  requests: PreparedGather["requests"],
) {
  return Effect.gen(function* () {
    return {
      operationId,
      content: descriptor.content,
      deadlineAt: descriptor.deadlineAt,
      waitUntil: descriptor.waitUntil,
      requests,
      durable: yield* encodeLocalCollective(operationId, descriptor).pipe(
        Effect.mapError(contentInvalid),
      ),
      open: { ...descriptor, outcomes: new Map(), answerHashes: new Map() },
    } satisfies PreparedGather;
  });
}

interface RequestPreparation {
  readonly operationId: CollectiveId;
  readonly op: "gather" | "all_gather";
  readonly to: MessageAddressInput;
  readonly addresses: readonly AgentAddress[];
  readonly content: MessageContent;
}

function prepareRequests(state: CollectiveState, input: RequestPreparation) {
  const { operationId, op, to, addresses, content } = input;
  const destinations = op === "gather" ? addresses : [to];
  return Effect.validateAll(
    destinations,
    (destination) =>
      state.ports
        .prepareMessage({
          to: destination,
          content,
          collective: { operationId, role: "request", destination },
        })
        .pipe(
          Effect.map((message) => ({ to: destination, message })),
          Effect.mapError((error) =>
            error._tag === "RecipientResolutionError"
              ? error.failures.map(({ member, cause }) =>
                  messageRefusal(member, cause),
                )
              : addresses
                  .filter(
                    (address) => op === "all_gather" || address === destination,
                  )
                  .map((member) => messageRefusal(member, error)),
          ),
        ),
    { concurrency: 8 },
  ).pipe(
    Effect.catchAll((failures) => {
      const [first, ...rest] = failures.flat();
      return first === undefined
        ? Effect.dieMessage("failed preparation has no recipient")
        : Effect.fail(
            collectiveFailure(operationId, {
              kind: "members-unreachable",
              members: [first, ...rest],
            }),
          );
    }),
  );
}

function preparedMembers(
  state: CollectiveState,
  requests: PreparedGather["requests"],
  addresses: readonly AgentAddress[],
) {
  return Effect.gen(function* () {
    const memberships = yield* Effect.forEach(
      requests,
      ({ message }) =>
        preparedSendData(message).pipe(
          Effect.map(({ descriptor }) => descriptor.members),
        ),
      { concurrency: 1 },
    );
    const cards = yield* Effect.forEach(
      memberships.flat(),
      (card) =>
        Schema.decodeUnknown(AgentCard)(card).pipe(
          Effect.mapError(contentInvalid),
        ),
      { concurrency: 1 },
    );
    const distinct = new Map(
      cards
        .filter((card) => card.agentId !== state.ports.self.agentId)
        .map((card) => [card.agentId, AgentView.make(card)]),
    );
    return addresses.flatMap((address) =>
      [...distinct.values()].filter(
        (member) => agentAddressOf(member) === address,
      ),
    );
  });
}

/**
 * Check a collecting operation's schema against the MCP form-mode grammar.
 * The failure's detail is one line per issue, each led by its path within
 * the schema, such as `properties.slots: items.type: ...`, because the
 * requester's model repairs the form from this text alone.
 */
function formModeSchema(
  operationId: CollectiveId,
  requestedSchema: CollectingOperation["requestedSchema"],
): Effect.Effect<FormModeSchema, CollectiveError> {
  return Schema.decodeUnknown(FormModeSchema)(requestedSchema).pipe(
    Effect.mapError((error) =>
      collectiveFailure(operationId, {
        kind: "schema-invalid",
        detail: describeIssues(error),
      }),
    ),
  );
}

/** Durable request custody owns fanout and deadline work after the invoking caller stops waiting. */
function gatherRequests(
  state: CollectiveState,
  prepared: PreparedGather,
): Effect.Effect<RequestSendOutcome, CollectiveSendError> {
  return Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      if ((yield* Clock.currentTimeMillis) >= prepared.deadlineAt) {
        return yield* collectiveFailure(prepared.operationId, {
          kind: "deadline-passed",
        });
      }
      yield* durableSend(
        state,
        state.ports.store.putCollectiveOperation(prepared.durable),
      );
      yield* refreshRetainedSend(state, prepared.operationId);
      yield* openGather(state, prepared, false);
      yield* armRetainedGather(state, prepared.operationId);
      const sender = yield* sendRequests(state, prepared).pipe(
        Effect.interruptible,
        Effect.forkIn(state.ports.scope),
      );
      return yield* restore(Fiber.join(sender));
    }),
  );
}

/**
 * Send one request message per member, waiting at most the send wait. A pending
 * send keeps running and settles its member when it completes: certified
 * asks it, refused makes it `no-answer`, as does pending at the deadline.
 * The send fails only when every message was refused and the gather has not
 * completed, so an operation ends in exactly one refusal or one result.
 * When the result that settling the gather emits cannot be kept, the send
 * keeps its own outcome, the request messages that exist.
 */
function sendRequests(
  state: CollectiveState,
  prepared: PreparedGather,
): Effect.Effect<RequestSendOutcome, CollectiveError | SendError> {
  return Effect.gen(function* () {
    const { operationId, open } = prepared;
    const sends = yield* fanOutRequests(
      prepared,
      state.ports.acceptMessage,
      state.ports.scope,
      (refusal) => recordRefusal(state, operationId, refusal),
    );
    yield* Fiber.awaitAll(sends).pipe(
      Effect.timeoutOption(yield* requestWait(prepared.waitUntil)),
    );
    const { messages, refused } = yield* requestsSoFar(sends);
    const [refusal, ...refusals] = refused.filter(
      (item) =>
        item.reason !== "delivery-pending" && item.reason !== "outcome-unknown",
    );
    if (
      refusal !== undefined &&
      refusals.length + 1 === open.members.length &&
      (yield* forgetGather(state, operationId))
    ) {
      return yield* collectiveFailure(operationId, {
        kind: "members-unreachable",
        members: [refusal, ...refusals],
      });
    }
    yield* Effect.ignore(
      updateGather(state, operationId, (settled) => {
        settled.requestsSettled = true;
      }),
    );
    return { msgIds: messages.map((message) => message.msgId) };
  });
}

/**
 * Bind one group request and preserve its lifetime when the invocation stops
 * waiting. A hold opens matching state before binding; terminal work starts
 * only after the same intent owns a durable collective descriptor.
 */
function sendGroupRequest(
  state: CollectiveState,
  prepared: PreparedGather,
): Effect.Effect<RequestSendOutcome, CollectiveSendError> {
  const { operationId } = prepared;
  return acceptGroupRequest(state, prepared).pipe(
    Effect.onExit((exit) =>
      Exit.isSuccess(exit) || state.gathers.has(operationId)
        ? Effect.void
        : markRefused(state, operationId),
    ),
    Effect.catchTag(
      "SendError",
      (error): Effect.Effect<never, SendError | CollectiveError> =>
        error.reason === "delivery-pending" ||
        error.reason === "outcome-unknown"
          ? Effect.fail(error)
          : abandonGroupRequest(state, prepared, error),
    ),
    Effect.tap(() => refreshRetainedSend(state, prepared.operationId)),
    Effect.flatMap(({ certified }) =>
      withinRequestWait(prepared.waitUntil, certified).pipe(
        Effect.map((message) => ({
          msgIds: [message.msgId],
        })),
        Effect.catchTag("SendError", (error) =>
          groupRequestFailure(state, prepared, error),
        ),
      ),
    ),
    Effect.onExit(() => armRetainedGather(state, operationId)),
  );
}

function acceptGroupRequest(state: CollectiveState, prepared: PreparedGather) {
  const { operationId } = prepared;
  const hold = openGather(state, prepared, true).pipe(
    Effect.as(releaseUnboundGather(state, operationId)),
  );
  const message = prepared.requests[0]?.message;
  if (message === undefined) {
    return Effect.fail(contentInvalid());
  }
  return state.ports.acceptMessage(
    {
      ...message,
      collective: {
        operationId,
        role: "request",
        destination: prepared.open.to,
        operation: prepared.durable,
      },
    },
    hold,
  );
}

function classify(
  state: CollectiveState,
  certified: CertifiedMessage,
): Effect.Effect<Option.Option<InboundItem>, CollectiveEmitError> {
  const { message } = certified;
  return readCollectiveValue(message.content).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.succeed(
            Option.some<InboundItem>({ kind: "multicast", message }),
          ),
        onSome: (value) => collectiveItem(state, certified, value),
      }),
    ),
    Effect.catchTag("CollectivePartInvalidError", (error) =>
      Effect.logWarning(
        `consumed message ${message.msgId} from ${agentAddressOf(message.sender)}: its collective part is ${error.reason}`,
      ).pipe(Effect.as(Option.none())),
    ),
  );
}

function collectiveItem(
  state: CollectiveState,
  message: CertifiedMessage,
  value: CollectiveValue,
): Effect.Effect<Option.Option<InboundItem>, CollectiveEmitError> {
  switch (value.kind) {
    case "operation":
      return operationItem(state, message, value);
    case "response":
      return recordAnswer(state, message, value).pipe(Effect.as(Option.none()));
    case "close":
      return receiveClose(state, message.message, value).pipe(
        Effect.as(Option.none()),
      );
    default: {
      const exhaustive: never = value;
      return exhaustive;
    }
  }
}

function operationItem(
  state: CollectiveState,
  message: CertifiedMessage,
  value: Extract<CollectiveValue, { readonly kind: "operation" }>,
): Effect.Effect<Option.Option<InboundItem>, CollectiveEmitError> {
  switch (value.op) {
    case "multicast":
      return Effect.succeed(
        multicastItem(
          message.message,
          withoutCollectivePart(message.message.content),
        ),
      );
    case "gather":
    case "all_gather":
      return requestItem(state, message, value);
    default: {
      const exhaustive: never = value;
      return exhaustive;
    }
  }
}

function multicastItem(
  message: InboundMessage,
  content: ReadonlyArray<MessageContent[number]>,
): Option.Option<InboundItem> {
  return EffectArray.isNonEmptyReadonlyArray(content)
    ? Option.some({ kind: "multicast", message: { ...message, content } })
    : Option.none();
}

/**
 * Record a received gather or all_gather request and present it as an item.
 * A request `receivedRequest` opens nothing for is consumed. So is a second
 * request message reusing an operationId this endpoint holds: the answer goes to the
 * conversation of the first, so presenting the second would show the host a
 * different audience. An all_gather request past its deadline is kept
 * without being presented, so a member that catches up late still applies
 * the close and receives the result.
 */
function requestItem(
  state: CollectiveState,
  message: CertifiedMessage,
  value: CollectingValue,
): Effect.Effect<Option.Option<InboundItem>, CollectiveEmitError> {
  if (
    state.recovering &&
    !retainedRequestMatches(state, message, value.operationId)
  ) {
    return Effect.succeed(Option.none());
  }
  return Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const received = receivedRequest(message, value, now);
    if (
      Option.isNone(received) ||
      conflictsWithRequest(state, message, value.operationId)
    ) {
      return Option.none();
    }
    const held = state.requests.get(value.operationId);
    if (!state.retained.has(value.operationId)) {
      yield* retainRequest(state, message, value.operationId);
    }
    if (held === undefined) {
      state.requests.set(value.operationId, received.value);
    }
    return now < value.deadlineAt
      ? Option.some<InboundItem>({
          kind: "collectiveRequest",
          op: value.op,
          operationId: value.operationId,
          msgId: message.message.msgId,
          from: message.message.sender,
          to: received.value.to,
          question: received.value.question,
          requestedSchema: value.requestedSchema,
          deadlineAt: value.deadlineAt,
        })
      : Option.none();
  });
}

/** Recovery restores accepted request identities without admitting consumed or fresh records. */
function retainedRequestMatches(
  state: CollectiveState,
  message: CertifiedMessage,
  operationId: CollectiveId,
): boolean {
  const retained = state.retained.get(operationId);
  return (
    retained?.origin.kind === "remote" &&
    retained.origin.recordHash === message.recordHash
  );
}

function conflictsWithRequest(
  state: CollectiveState,
  message: CertifiedMessage,
  operationId: CollectiveId,
): boolean {
  const retained = state.retained.get(operationId);
  if (
    state.gathers.has(operationId) ||
    retained?.origin.kind === "local" ||
    retained?.phase === "completed"
  ) {
    return true;
  }
  const held = state.requests.get(operationId);
  return held !== undefined && !sameRequestMessage(held, message);
}

function sameRequestMessage(
  held: ReceivedRequest,
  message: CertifiedMessage,
): boolean {
  return (
    held.msgId === message.message.msgId &&
    held.recordHash === message.recordHash &&
    held.from.agentId === message.message.sender.agentId
  );
}

function retainRequest(
  state: CollectiveState,
  message: CertifiedMessage,
  operationId: CollectiveId,
) {
  return durableEmit(
    state,
    Effect.gen(function* () {
      const canonicalRequest = yield* encodeCanonical(
        InboundMessage,
        message.message,
      ).pipe(
        Effect.catchTag("ClientRepresentationError", () =>
          Effect.fail(new EndpointStoreError({ reason: "invalid-input" })),
        ),
      );
      yield* state.ports.store.putCollectiveOperation({
        operationId,
        origin: {
          kind: "remote",
          recordHash: message.recordHash,
        },
        canonicalRequest,
        canonicalDescriptor: yield* encodeRuntimeValue({}),
      });
      yield* refreshRetained(state, operationId);
    }),
  );
}

/**
 * Record an answer. At the requester, only a member's message in the
 * operation's own conversation counts, and only its first; an answer to a
 * completed or unknown operation changes nothing, and the last outstanding
 * answer completes the operation. At an all_gather member, every member's
 * answer in the group conversation is kept by record hash until the close.
 */
function recordAnswer(
  state: CollectiveState,
  message: CertifiedMessage,
  value: ResponseValue,
): Effect.Effect<void, CollectiveEmitError> {
  return Effect.suspend(() => {
    const open = state.gathers.get(value.operationId);
    if (open !== undefined) {
      return recordCountedAnswer(state, open, message, value);
    }
    const request = state.requests.get(value.operationId);
    if (request?.kind === "all_gather") {
      recordPeerAnswer(request, message, value);
    }
    return Effect.void;
  });
}

/**
 * Only a confirmed pre-bind refusal abandons a group request.
 */
function groupRequestFailure(
  state: CollectiveState,
  prepared: PreparedGather,
  error: SendError,
): Effect.Effect<never, SendError | CollectiveError> {
  if (
    error.reason === "delivery-pending" ||
    error.reason === "outcome-unknown"
  ) {
    return Effect.fail(error);
  }
  return durableSend(
    state,
    state.ports.store.readCollectiveMessages({
      operationId: prepared.operationId,
      role: "request",
    }),
  ).pipe(
    Effect.flatMap(
      (messages): Effect.Effect<never, SendError | CollectiveError> =>
        messages.length > 0
          ? Effect.fail(error)
          : abandonGroupRequest(state, prepared, error),
    ),
  );
}

/**
 * Abandon an all_gather whose group message failed: drop it, and refuse naming
 * every member with the message's reason and detail.
 */
function abandonGroupRequest(
  state: CollectiveState,
  prepared: PreparedGather,
  error: SendError,
): Effect.Effect<never, CollectiveError | SendError> {
  return forgetGather(state, prepared.operationId).pipe(
    Effect.zipRight(
      Effect.fail(
        collectiveFailure(prepared.operationId, {
          kind: "members-unreachable",
          members: EffectArray.map(prepared.open.members, (member) =>
            messageRefusal(agentAddressOf(member), error),
          ),
        }),
      ),
    ),
  );
}

/** Certified references accompany canonical results for upper-layer projection. */
export { ResultProvenance } from "./ports.js";
/** Prepared operation identities are private daemon integration data. */
export type { PreparedCollective } from "./prepared.js";
/** The failure an emit port returns when the service cannot keep an item. */
export { CollectiveEmitError } from "./contracts.js";
/** The items those operations emit. */
export type { InboundItem } from "./inbound.js";

/** Certified multicast projection preserves every non-protocol content part. */
export {
  type CollectiveValue,
  readCollectiveValue,
  withoutCollectivePart,
} from "./wire/index.js";
