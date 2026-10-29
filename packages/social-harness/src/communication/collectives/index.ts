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
import type { InboundItem } from "./inbound.js";
import { encodeCanonical } from "../../encoding/canonical-json.js";
import { canonicalMessageAddress } from "../conversations/address.js";
import { SendError } from "../conversations/errors.js";
import { InboundMessage } from "../conversations/message.js";
import { agentNameOf, type MessageAddressInput } from "../records/index.js";
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
  type SendInput,
} from "./contracts.js";
import {
  durableEmit,
  durableSend,
  refreshRetained,
  refreshRetainedSend,
} from "./persistence.js";
import {
  type AdmittedGather,
  type AuthoredMessageError,
  bindAuthoredMessage,
  type CertifiedMessage,
  type CollectiveOperations,
  type CollectivePorts,
  type CollectiveSendError,
  type MessageSender,
} from "./ports.js";
import { type ReceivedRequest, receivedRequest } from "./received-request.js";
import { recoverCollectives } from "./recovery.js";
import {
  fanOutRequests,
  gatherAddress,
  operationTimes,
  messageRefusal,
  requestsSoFar,
  requestWait,
  resolveMembers,
  withinRequestWait,
} from "./request-sends.js";
import { respond, restoreResponse } from "./responses.js";
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

type MessageContent = InboundMessage["content"];

/** Request fanout returns only messages certified during this invocation. */
type RequestSendOutcome = Pick<CollectiveSendOutcome, "msgIds" | "guidance">;

type CollectingOperation = Extract<
  CollectiveOperation,
  { readonly deadline: number }
>;

type CollectingValue = Extract<
  CollectiveValue,
  { readonly kind: "operation"; readonly op: "gather" | "all_gather" }
>;

const contentInvalid = () => new SendError({ reason: "content-invalid" });

const collectiveFailure = (id: CollectiveId, failure: CollectiveFailure) =>
  new CollectiveError({ id, failure });

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
      complete: (id) => completeGather(state, id),
      refuse: (id, refusal) => recordRefusal(state, id, refusal),
    });
    return {
      send: (input) =>
        "collectiveResponse" in input
          ? respond(state, input.to, input.collectiveResponse)
          : sendOperation(state, input),
      classify: (message) => classify(state, message),
      settleRequest: (id, presented) =>
        Effect.sync(() => {
          const request = state.requests.get(id);
          if (request?.state === "unadmitted") {
            request.state = presented ? "open" : "withheld";
          }
        }),
    } satisfies CollectiveOperations;
  }).pipe(Effect.withSpan("makeCollectiveOperations"));

function sendOperation(
  state: CollectiveState,
  input: Extract<SendInput, { readonly text: string }>,
): Effect.Effect<CollectiveSendOutcome, CollectiveSendError> {
  const operation = input.collective ?? {};
  switch (operation.op) {
    case undefined:
    case "multicast":
      return multicast(state, input.to, input.text);
    case "gather":
    case "all_gather":
      return gather(state, input.to, input.text, operation);
    default: {
      const exhaustive: never = operation;
      return exhaustive;
    }
  }
}

function multicast(
  state: CollectiveState,
  to: MessageAddressInput,
  text: string,
): Effect.Effect<CollectiveSendOutcome, AuthoredMessageError<never>> {
  return Effect.gen(function* () {
    const content = yield* encodeCollectiveContent(
      { kind: "operation", op: "multicast" },
      text,
    ).pipe(Effect.mapError(contentInvalid));
    const self = agentNameOf(state.ports.self);
    const { address } = yield* canonicalMessageAddress(to, self);
    const { certified, guidance } = yield* bindAuthoredMessage(
      state.ports,
      { to, content },
      Effect.succeed(Effect.void),
    );
    const { msgId } = yield* certified;
    return {
      kind: "multicast",
      msgIds: [msgId],
      msgId,
      address,
      ...(guidance === undefined ? {} : { guidance }),
    };
  });
}

/**
 * Start a gather or all_gather. A gather is checked once by an installed
 * firewall before anything else; its deadline timer then starts, it opens so
 * answers can be recorded while its requests are still being sent, and its
 * request messages go out through the sender the check admitted. An
 * all_gather's one group message is checked as the agent's message. Matching state
 * opens before binding; its timer starts only after durable ownership. A firewall refusal is the
 * send's own failure, never routed inbound.
 */
function gather(
  state: CollectiveState,
  requestedTo: MessageAddressInput,
  question: string,
  operation: CollectingOperation,
): Effect.Effect<CollectiveSendOutcome, CollectiveSendError> {
  return Effect.gen(function* () {
    const prepared = yield* prepareGather(
      state,
      requestedTo,
      question,
      operation,
    );
    const sent = yield* prepared.open.op === "gather"
      ? gatherRequests(state, prepared)
      : sendGroupRequest(state, prepared);
    return { ...sent, kind: "collective", operationId: prepared.id };
  });
}

/**
 * Validate a gather or all_gather before any message: mint its id, check its
 * schema against the form-mode grammar, name and resolve its members, fix
 * its absolute deadline, and build the request content within the content
 * limit.
 */
function prepareGather(
  state: CollectiveState,
  requestedTo: MessageAddressInput,
  question: string,
  input: CollectingOperation,
): Effect.Effect<PreparedGather, SendError | CollectiveError> {
  return Effect.gen(function* () {
    const { id, nonce } = yield* mintCollectiveId(state.ports.self);
    const { to, members: addresses } = yield* gatherAddress(
      requestedTo,
      state.ports.self,
      input.op,
    );
    const requestedSchema = yield* formModeSchema(id, input.requestedSchema);
    const members = yield* resolveMembers(
      addresses,
      state.ports.lookupMember,
    ).pipe(Effect.mapError((failure) => collectiveFailure(id, failure)));
    const times = yield* operationTimes(input.deadline);
    const content = yield* encodeCollectiveContent(
      {
        kind: "operation",
        op: input.op,
        id,
        nonce,
        deadlineAt: times.deadlineAt,
        requestedSchema,
      },
      question,
    ).pipe(Effect.mapError(contentInvalid));
    const descriptor = {
      op: input.op,
      to,
      question,
      members,
      requestedSchema,
      content,
      ...times,
    };
    return {
      id,
      content,
      ...times,
      durable: yield* encodeLocalCollective(id, descriptor).pipe(
        Effect.mapError(contentInvalid),
      ),
      open: { ...descriptor, outcomes: new Map(), answerHashes: new Map() },
    };
  });
}

/**
 * Check a collecting operation's schema against the MCP form-mode grammar.
 * The failure's detail is one line per issue, each led by its path within
 * the schema, such as `properties.slots: items.type: ...`, because the
 * requester's model repairs the form from this text alone.
 */
function formModeSchema(
  id: CollectiveId,
  requestedSchema: CollectingOperation["requestedSchema"],
): Effect.Effect<FormModeSchema, CollectiveError> {
  return Schema.decodeUnknown(FormModeSchema)(requestedSchema).pipe(
    Effect.mapError((error) =>
      collectiveFailure(id, {
        kind: "schema-invalid",
        detail: describeIssues(error),
      }),
    ),
  );
}

/**
 * Admit a gather, open it, and send its request messages through the sender
 * the check admitted. The admitting check's advice stays with the outcome,
 * and with a refusal that follows admission. Admission and fanout keep one
 * scoped owner even if the invoking caller stops waiting.
 */
function gatherRequests(
  state: CollectiveState,
  prepared: PreparedGather,
): Effect.Effect<RequestSendOutcome, CollectiveSendError> {
  return admitGather(state, prepared).pipe(
    Effect.flatMap(({ sendRequest, guidance }) =>
      openGather(state, prepared, false).pipe(
        Effect.catchTag("CollectiveError", (error) =>
          forgetGather(state, prepared.id).pipe(
            Effect.zipRight(Effect.fail(error)),
          ),
        ),
        Effect.tap(() => armRetainedGather(state, prepared.id)),
        Effect.zipRight(sendRequests(state, prepared, sendRequest)),
        Effect.map((sent) => ({
          ...sent,
          ...(guidance === undefined ? {} : { guidance }),
        })),
      ),
    ),
    Effect.interruptible,
    Effect.forkIn(state.ports.scope),
    Effect.flatMap(Fiber.join),
  );
}

/**
 * The sender a gather's request messages go through, with the advice of the
 * firewall's check that admitted the gather, or the plain message sender without
 * a firewall.
 */
function admitGather(
  state: CollectiveState,
  prepared: PreparedGather,
): Effect.Effect<AdmittedGather, AuthoredMessageError<never>> {
  const { admission } = state.ports;
  const admitted: Effect.Effect<
    AdmittedGather,
    AuthoredMessageError<never> | EndpointStoreError
  > =
    admission === undefined
      ? durableSend(
          state,
          state.ports.store.putCollectiveOperation(prepared.durable),
        ).pipe(Effect.as({ sendRequest: state.ports.sendMessage }))
      : admission.admitGather({
          to: prepared.open.to,
          content: prepared.content,
          operation: prepared.durable,
        });
  return admitted.pipe(
    Effect.catchTag("EndpointStoreError", (error) =>
      durableSend(state, Effect.fail(error)),
    ),
    Effect.tap(() => refreshRetainedSend(state, prepared.id)),
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
  sendRequest: MessageSender,
): Effect.Effect<RequestSendOutcome, CollectiveError | SendError> {
  return Effect.gen(function* () {
    const { id, open } = prepared;
    const sends = yield* fanOutRequests(
      prepared,
      sendRequest,
      state.ports.scope,
      (refusal) => recordRefusal(state, id, refusal),
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
      (yield* forgetGather(state, id))
    ) {
      return yield* collectiveFailure(id, {
        kind: "members-unreachable",
        members: [refusal, ...refusals],
      });
    }
    yield* Effect.ignore(
      updateGather(state, id, (settled) => {
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
  const { id, open } = prepared;
  const hold = openGather(state, prepared, true).pipe(
    Effect.as(releaseUnboundGather(state, id)),
  );
  return bindAuthoredMessage(
    state.ports,
    {
      to: open.to,
      content: prepared.content,
      collective: {
        operationId: id,
        role: "request",
        destination: open.to,
        operation: prepared.durable,
      },
    },
    hold,
  ).pipe(
    Effect.onExit((exit) =>
      Exit.isSuccess(exit) || state.gathers.has(id)
        ? Effect.void
        : markRefused(state, id),
    ),
    Effect.catchTag(
      "SendError",
      (error): Effect.Effect<never, SendError | CollectiveError> =>
        error.reason === "delivery-pending" ||
        error.reason === "outcome-unknown"
          ? Effect.fail(error)
          : abandonGroupRequest(state, prepared, error),
    ),
    Effect.tap(() => refreshRetainedSend(state, prepared.id)),
    Effect.flatMap(({ certified, guidance }) =>
      withinRequestWait(prepared.waitUntil, certified).pipe(
        Effect.map((message) => ({
          msgIds: [message.msgId],
          ...(guidance === undefined ? {} : { guidance }),
        })),
        Effect.catchTag("SendError", (error) =>
          groupRequestFailure(state, prepared, error),
        ),
      ),
    ),
    Effect.onExit(() => armRetainedGather(state, id)),
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
 * request message reusing an id this endpoint holds: the answer goes to the
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
  if (state.recovering && !retainedRequestMatches(state, message, value.id)) {
    return Effect.succeed(Option.none());
  }
  return Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const received = receivedRequest(
      message,
      value,
      now,
      state.ports.admission === undefined ? "open" : "unadmitted",
    );
    if (
      Option.isNone(received) ||
      conflictsWithRequest(state, message, value.id)
    ) {
      return Option.none();
    }
    const held = state.requests.get(value.id);
    if (!state.retained.has(value.id)) {
      yield* retainRequest(state, message, value.id);
    }
    if (held === undefined) {
      state.requests.set(value.id, received.value);
    }
    return now < value.deadlineAt
      ? Option.some<InboundItem>({
          kind: "collectiveRequest",
          op: value.op,
          id: value.id,
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
  id: CollectiveId,
): boolean {
  const retained = state.retained.get(id);
  return (
    retained?.origin.kind === "remote" &&
    retained.origin.recordHash === message.recordHash
  );
}

function conflictsWithRequest(
  state: CollectiveState,
  message: CertifiedMessage,
  id: CollectiveId,
): boolean {
  const retained = state.retained.get(id);
  if (
    state.gathers.has(id) ||
    retained?.origin.kind === "local" ||
    retained?.phase === "completed"
  ) {
    return true;
  }
  const held = state.requests.get(id);
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
  id: CollectiveId,
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
        operationId: id,
        origin: {
          kind: "remote",
          recordHash: message.recordHash,
          requiresAdmission: state.ports.admission !== undefined,
        },
        canonicalRequest,
        canonicalDescriptor: yield* encodeRuntimeValue({}),
      });
      yield* refreshRetained(state, id);
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
    const open = state.gathers.get(value.id);
    if (open !== undefined) {
      return recordCountedAnswer(state, open, message, value);
    }
    const request = state.requests.get(value.id);
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
      operationId: prepared.id,
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
  return forgetGather(state, prepared.id).pipe(
    Effect.zipRight(
      Effect.fail(
        collectiveFailure(prepared.id, {
          kind: "members-unreachable",
          members: EffectArray.map(prepared.open.members, (member) =>
            messageRefusal(agentAddressOf(member), error),
          ),
        }),
      ),
    ),
  );
}

/** The ports the layer runs on, what a firewall adds, and the operations it offers. */
export {
  type AdmittedGather,
  type CollectiveAdmission,
  type CollectiveOperations,
  type GatherCandidate,
  ResultProvenance,
} from "./ports.js";
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
