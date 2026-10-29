/**
 * @file Collective operations over certified posts, one instance per active
 * identity. The daemon classifies each remote post into a host item or consumes
 * it as protocol traffic. A post without a collective part is a multicast.
 *
 * Durable descriptors and post claims restore operation and answer context
 * before the endpoint accepts another send.
 * An all_gather keeps peer answers from the model until the requester certifies
 * a close; each endpoint builds its result from exactly the listed records.
 */

import { agentAddressOf } from "../records/values.js";
import {
  Clock,
  Effect,
  Array as EffectArray,
  Exit,
  Fiber,
  Option,
  Schema,
} from "effect";
import type { CollectiveResultItem, InboundItem } from "./inbound.js";
import { encodeCanonical } from "../../encoding/canonical-json.js";
import { canonicalMessageAddress } from "../conversations/address.js";
import { SendError } from "../conversations/errors.js";
import { InboundMessage } from "../conversations/message.js";
import { agentNameOf, type MessageAddressInput } from "../records/index.js";
import { encodeRuntimeValue, EndpointStoreError } from "../store/index.js";
import {
  applyClose,
  closeAllGather,
  countedProvenance,
  receiveClose,
  recordPeerAnswer,
} from "./all-gather.js";
import {
  type CollectiveClosure,
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
  emitTerminal,
  refreshRetained,
  refreshRetainedSend,
} from "./persistence.js";
import {
  type AdmittedGather,
  type AuthoredPostError,
  bindAuthoredPost,
  type CertifiedPost,
  type CollectiveOperations,
  type CollectivePorts,
  type CollectiveSendError,
  type PostSender,
} from "./ports.js";
import { type ReceivedRequest, receivedRequest } from "./received-request.js";
import { recoverCollectives } from "./recovery.js";
import {
  fanOutRequests,
  gatherAddress,
  operationTimes,
  postRefusal,
  resolveMembers,
  type RequestRefusal,
  requestsSoFar,
  requestWait,
  sleepUntil,
  withinRequestWait,
} from "./request-sends.js";
import { respond, restoreResponse } from "./responses.js";
import { memberOutcomes } from "./shared-answers.js";
import {
  type CollectiveState,
  encodeLocalCollective,
  type GatherRequest,
  type OpenGather,
  type PreparedGather,
  readCollectiveSelection,
} from "./state.js";
import { outcomeOfResponse } from "./validation.js";
import {
  type CollectiveValue,
  encodeCollectiveContent,
  FormModeSchema,
  mintCollectiveId,
  readCollectiveValue,
  type ResponseValue,
  withoutCollectivePart,
} from "./wire/index.js";

type PostContent = InboundMessage["content"];

/** Request fanout returns only posts certified during this invocation. */
type RequestSendOutcome = Pick<CollectiveSendOutcome, "postIds" | "guidance">;

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
 * @param ports The daemon's post sending, item queue, scope and identity.
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
      classify: (post) => classify(state, post),
      restoreResponse: (post) => restoreResponse(state, post),
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

type ClosedOutcome = "completed" | "failed" | "refused";

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
): Effect.Effect<CollectiveSendOutcome, AuthoredPostError<never>> {
  return Effect.gen(function* () {
    const content = yield* encodeCollectiveContent(
      { kind: "operation", op: "multicast" },
      text,
    ).pipe(Effect.mapError(contentInvalid));
    const self = agentNameOf(state.ports.self);
    const { address } = yield* canonicalMessageAddress(to, self);
    const { certified, guidance } = yield* bindAuthoredPost(
      state.ports,
      { to, content },
      Effect.succeed(Effect.void),
    );
    const { postId } = yield* certified;
    return {
      kind: "multicast",
      postIds: [postId],
      postId,
      address,
      ...(guidance === undefined ? {} : { guidance }),
    };
  });
}

/**
 * Start a gather or all_gather. A gather is checked once by an installed
 * firewall before anything else; its deadline timer then starts, it opens so
 * answers can be recorded while its requests are still being sent, and its
 * request posts go out through the sender the check admitted. An
 * all_gather's one group post is checked as the agent's post. Matching state
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
 * Validate a gather or all_gather before any post: mint its id, check its
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
    const { deadlineAt, waitUntil } = yield* operationTimes(input.deadline);
    const content = yield* encodeCollectiveContent(
      {
        kind: "operation",
        op: input.op,
        id,
        nonce,
        deadlineAt,
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
      deadlineAt,
      waitUntil,
    };
    const open: GatherRequest = {
      ...descriptor,
      outcomes: new Map(),
      answerHashes: new Map(),
    };
    const durable = yield* encodeLocalCollective(id, descriptor).pipe(
      Effect.mapError(contentInvalid),
    );
    return { id, open, content, deadlineAt, waitUntil, durable };
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
 * Admit a gather, open it, and send its request posts through the sender
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
 * The sender a gather's request posts go through, with the advice of the
 * firewall's check that admitted the gather, or the plain post sender without
 * a firewall.
 */
function admitGather(
  state: CollectiveState,
  prepared: PreparedGather,
): Effect.Effect<AdmittedGather, AuthoredPostError<never>> {
  const { admission } = state.ports;
  const admitted: Effect.Effect<
    AdmittedGather,
    AuthoredPostError<never> | EndpointStoreError
  > =
    admission === undefined
      ? durableSend(
          state,
          state.ports.store.putCollectiveOperation(prepared.durable),
        ).pipe(Effect.as({ sendRequest: state.ports.sendPost }))
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
 * Send one request post per member, waiting at most the send wait. A pending
 * send keeps running and settles its member when it completes: certified
 * asks it, refused makes it `no-answer`, as does pending at the deadline.
 * The send fails only when every post was refused and the gather has not
 * completed, so an operation ends in exactly one refusal or one result.
 * When the result that settling the gather emits cannot be kept, the send
 * keeps its own outcome, the request posts that exist.
 */
function sendRequests(
  state: CollectiveState,
  prepared: PreparedGather,
  sendRequest: PostSender,
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
    const { posts, refused } = yield* requestsSoFar(sends);
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
    return { postIds: posts.map((post) => post.postId) };
  });
}

/** A confirmed refusal and its no-answer outcome settle the member in one retained transition. */
function recordRefusal(
  state: CollectiveState,
  id: CollectiveId,
  refusal: RequestRefusal,
): Effect.Effect<void> {
  if (
    refusal.reason === "delivery-pending" ||
    refusal.reason === "outcome-unknown"
  ) {
    return Effect.void;
  }
  return state.transitions
    .withPermits(1)(
      Effect.uninterruptible(
        Effect.gen(function* () {
          const open = state.gathers.get(id);
          if (open === undefined) {
            return;
          }
          yield* durableEmit(
            state,
            encodeRuntimeValue(refusal).pipe(
              Effect.flatMap((canonicalRefusal) =>
                state.ports.store.recordCollectiveRefusal({
                  operationId: id,
                  destination: refusal.member,
                  canonicalRefusal,
                }),
              ),
            ),
          );
          if (!open.outcomes.has(refusal.member)) {
            open.outcomes.set(refusal.member, { kind: "no-answer" });
          }
        }),
      ),
    )
    .pipe(Effect.zipRight(completeAnsweredGather(state, id)), Effect.ignore);
}

/**
 * Apply a change to an open gather, then complete it once its send has
 * returned and every member has an outcome. Until the send returns, only the
 * send decides whether the gather is refused, so no path can emit both a
 * refusal and a result.
 */
function updateGather(
  state: CollectiveState,
  id: CollectiveId,
  change: (open: OpenGather) => void,
): Effect.Effect<void, CollectiveEmitError> {
  return state.transitions
    .withPermits(1)(
      Effect.sync(() => {
        const open = state.gathers.get(id);
        if (open !== undefined) {
          change(open);
        }
      }),
    )
    .pipe(Effect.zipRight(completeAnsweredGather(state, id)));
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
  return bindAuthoredPost(
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
        Effect.map((post) => ({
          postIds: [post.postId],
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

/**
 * Open request matching while a bind hold is live. The deadline is checked
 * before opening; only durable admission arms a timer that may finalize it.
 */
function openGather(
  state: CollectiveState,
  prepared: PreparedGather,
  requestsSettled: boolean,
): Effect.Effect<void, CollectiveError> {
  return Effect.gen(function* () {
    if (
      !state.recovering &&
      (yield* Clock.currentTimeMillis) >= prepared.deadlineAt
    ) {
      return yield* new CollectiveError({
        id: prepared.id,
        failure: { kind: "deadline-passed" },
      });
    }
    const firstOpening = yield* Effect.sync(() => {
      state.gathers.set(prepared.id, {
        ...prepared.open,
        deadlineAt: prepared.deadlineAt,
        requestsSettled,
      });
      const first = !state.announced.has(prepared.id);
      state.announced.add(prepared.id);
      return first;
    });
    if (!firstOpening) {
      return;
    }
    yield* Effect.withSpan(Effect.void, "collective.opened", {
      captureStackTrace: false,
      attributes: {
        operationId: prepared.id,
        op: prepared.open.op,
        deadlineAt: prepared.deadlineAt,
      },
    });
  });
}

/**
 * Drop an operation and stop its deadline timer, leaving its spans open: a
 * stale bind gives its hold up this way and takes it again.
 */
function releaseUnboundGather(
  state: CollectiveState,
  id: CollectiveId,
): Effect.Effect<void> {
  return durableEmit(state, refreshRetained(state, id)).pipe(
    Effect.flatMap(() =>
      state.retained.has(id)
        ? armRetainedGather(state, id)
        : releaseGather(state, id),
    ),
    Effect.ignore,
  );
}

/**
 * A retained operation can finalize at its absolute deadline without touching a pre-bind hold.
 */
function armRetainedGather(
  state: CollectiveState,
  id: CollectiveId,
): Effect.Effect<void> {
  return durableEmit(state, refreshRetained(state, id)).pipe(
    Effect.flatMap(() =>
      state.transitions.withPermits(1)(
        Effect.gen(function* () {
          const open = state.gathers.get(id);
          if (
            open === undefined ||
            open.timer !== undefined ||
            state.retained.get(id)?.phase !== "collecting"
          ) {
            return;
          }
          const timer = yield* sleepUntil(open.deadlineAt).pipe(
            Effect.zipRight(Effect.ignore(completeGather(state, id))),
            Effect.interruptible,
            Effect.forkIn(state.ports.scope),
          );
          open.timer = timer;
        }),
      ),
    ),
    Effect.ignore,
  );
}

function classify(
  state: CollectiveState,
  post: CertifiedPost,
): Effect.Effect<Option.Option<InboundItem>, CollectiveEmitError> {
  const { message } = post;
  return readCollectiveValue(message.content).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.succeed(
            Option.some<InboundItem>({ kind: "multicast", message }),
          ),
        onSome: (value) => collectiveItem(state, post, value),
      }),
    ),
    Effect.catchTag("CollectivePartInvalidError", (error) =>
      Effect.logWarning(
        `consumed post ${message.postId} from ${agentAddressOf(message.sender)}: its collective part is ${error.reason}`,
      ).pipe(Effect.as(Option.none())),
    ),
  );
}

function collectiveItem(
  state: CollectiveState,
  post: CertifiedPost,
  value: CollectiveValue,
): Effect.Effect<Option.Option<InboundItem>, CollectiveEmitError> {
  switch (value.kind) {
    case "operation":
      return operationItem(state, post, value);
    case "response":
      return recordAnswer(state, post, value).pipe(Effect.as(Option.none()));
    case "close":
      return receiveClose(state, post.message, value).pipe(
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
  post: CertifiedPost,
  value: Extract<CollectiveValue, { readonly kind: "operation" }>,
): Effect.Effect<Option.Option<InboundItem>, CollectiveEmitError> {
  switch (value.op) {
    case "multicast":
      return Effect.succeed(
        multicastItem(
          post.message,
          withoutCollectivePart(post.message.content),
        ),
      );
    case "gather":
    case "all_gather":
      return requestItem(state, post, value);
    default: {
      const exhaustive: never = value;
      return exhaustive;
    }
  }
}

function multicastItem(
  message: InboundMessage,
  content: ReadonlyArray<PostContent[number]>,
): Option.Option<InboundItem> {
  return EffectArray.isNonEmptyReadonlyArray(content)
    ? Option.some({ kind: "multicast", message: { ...message, content } })
    : Option.none();
}

/**
 * Record a received gather or all_gather request and present it as an item.
 * A request `receivedRequest` opens nothing for is consumed. So is a second
 * request post reusing an id this endpoint holds: the answer goes to the
 * conversation of the first, so presenting the second would show the host a
 * different audience. An all_gather request past its deadline is kept
 * without being presented, so a member that catches up late still applies
 * the close and receives the result.
 */
function requestItem(
  state: CollectiveState,
  post: CertifiedPost,
  value: CollectingValue,
): Effect.Effect<Option.Option<InboundItem>, CollectiveEmitError> {
  if (state.recovering && !retainedRequestMatches(state, post, value.id)) {
    return Effect.succeed(Option.none());
  }
  return Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const received = receivedRequest(
      post,
      value,
      now,
      state.ports.admission === undefined ? "open" : "unadmitted",
    );
    if (
      Option.isNone(received) ||
      conflictsWithRequest(state, post, value.id)
    ) {
      return Option.none();
    }
    const held = state.requests.get(value.id);
    if (!state.retained.has(value.id)) {
      yield* retainRequest(state, post, value.id);
    }
    if (held === undefined) {
      state.requests.set(value.id, received.value);
    }
    return now < value.deadlineAt
      ? Option.some<InboundItem>({
          kind: "collectiveRequest",
          op: value.op,
          id: value.id,
          postId: post.message.postId,
          from: post.message.sender,
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
  post: CertifiedPost,
  id: CollectiveId,
): boolean {
  const retained = state.retained.get(id);
  return (
    retained?.origin.kind === "remote" &&
    retained.origin.recordHash === post.recordHash
  );
}

function conflictsWithRequest(
  state: CollectiveState,
  post: CertifiedPost,
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
  return held !== undefined && !sameRequestPost(held, post);
}

function sameRequestPost(held: ReceivedRequest, post: CertifiedPost): boolean {
  return (
    held.postId === post.message.postId &&
    held.recordHash === post.recordHash &&
    held.from.agentId === post.message.sender.agentId
  );
}

function retainRequest(
  state: CollectiveState,
  post: CertifiedPost,
  id: CollectiveId,
) {
  return durableEmit(
    state,
    Effect.gen(function* () {
      const canonicalRequest = yield* encodeCanonical(
        InboundMessage,
        post.message,
      ).pipe(
        Effect.catchTag("ClientRepresentationError", () =>
          Effect.fail(new EndpointStoreError({ reason: "invalid-input" })),
        ),
      );
      yield* state.ports.store.putCollectiveOperation({
        operationId: id,
        origin: {
          kind: "remote",
          recordHash: post.recordHash,
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
 * Record an answer. At the requester, only a member's post in the
 * operation's own conversation counts, and only its first; an answer to a
 * completed or unknown operation changes nothing, and the last outstanding
 * answer completes the operation. At an all_gather member, every member's
 * answer in the group conversation is kept by record hash until the close.
 */
function recordAnswer(
  state: CollectiveState,
  post: CertifiedPost,
  value: ResponseValue,
): Effect.Effect<void, CollectiveEmitError> {
  return Effect.suspend(() => {
    const open = state.gathers.get(value.id);
    if (open !== undefined) {
      return recordCountedAnswer(state, open, post, value);
    }
    const request = state.requests.get(value.id);
    if (request?.kind === "all_gather") {
      recordPeerAnswer(request, post, value);
    }
    return Effect.void;
  });
}

function recordCountedAnswer(
  state: CollectiveState,
  open: OpenGather,
  post: CertifiedPost,
  value: ResponseValue,
): Effect.Effect<void, CollectiveEmitError> {
  return state.transitions
    .withPermits(1)(
      Effect.uninterruptible(
        Effect.gen(function* () {
          const { message } = post;
          if (
            state.gathers.get(value.id) !== open ||
            !answeredInConversation(open, message) ||
            !open.members.some(
              (member) => member.agentId === message.sender.agentId,
            ) ||
            open.outcomes.has(agentAddressOf(message.sender))
          ) {
            return;
          }
          if (!(yield* retainCountedAnswer(state, open, post, value.id))) {
            return;
          }
          const outcome = yield* outcomeOfResponse(open.requestedSchema, value);
          open.outcomes.set(agentAddressOf(message.sender), outcome);
          open.answerHashes.set(
            agentAddressOf(message.sender),
            post.recordHash,
          );
        }),
      ),
    )
    .pipe(Effect.zipRight(completeAnsweredGather(state, value.id)));
}

function completeAnsweredGather(
  state: CollectiveState,
  id: CollectiveId,
): Effect.Effect<void, CollectiveEmitError> {
  return Effect.suspend(() => {
    const open = state.gathers.get(id);
    if (open === undefined) {
      return Effect.void;
    }
    if (
      state.recovering ||
      !open.requestsSettled ||
      open.outcomes.size !== open.members.length
    ) {
      return Effect.void;
    }
    return completeGather(state, id).pipe(
      Effect.zipRight(
        open.timer === undefined ? Effect.void : Fiber.interrupt(open.timer),
      ),
    );
  });
}

/**
 * Complete an operation this endpoint started. A gather emits its result
 * now; an all_gather first posts its close, off the calling fiber because
 * completion can run inside a publication pass that certification waits on.
 * An operation completes once; a later call does nothing. The deadline timer
 * calls it too, so it leaves the timer to its caller. Completion takes over
 * the operation's `collective.closed` span, so an abandonment racing it
 * cannot close the operation while its close post is still in flight.
 */
function completeGather(
  state: CollectiveState,
  id: CollectiveId,
): Effect.Effect<void, CollectiveEmitError> {
  return Effect.uninterruptibleMask((restore) =>
    state.transitions
      .withPermits(1)(takeGatherCompletion(state, id))
      .pipe(
        Effect.flatMap((completion) =>
          completion === undefined
            ? Effect.void
            : finishGather(state, id, completion).pipe(
                Effect.interruptible,
                Effect.forkIn(state.ports.scope),
                Effect.flatMap((fiber) =>
                  completion.open.op === "gather"
                    ? restore(Fiber.join(fiber))
                    : Effect.void,
                ),
              ),
        ),
      ),
  );
}

function takeGatherCompletion(state: CollectiveState, id: CollectiveId) {
  return Effect.gen(function* () {
    const open = state.gathers.get(id);
    if (open === undefined) {
      return;
    }
    const closure = yield* freezeResult(state, id, open);
    state.gathers.delete(id);
    const announced = state.announced.delete(id);
    return { open, announced, closure };
  });
}

function finishGather(
  state: CollectiveState,
  id: CollectiveId,
  {
    open,
    announced,
    closure,
  }: {
    readonly open: OpenGather;
    readonly announced: boolean;
    readonly closure: CollectiveClosure;
  },
): Effect.Effect<void, CollectiveEmitError> {
  const close = (outcome: ClosedOutcome) =>
    announced ? closedSpan(id, outcome) : Effect.void;
  const result: CollectiveResultItem = {
    kind: "collectiveResult",
    op: open.op,
    id,
    ...closure,
    to: open.to,
    question: open.question,
    outcomes: memberOutcomes(open.members, open.outcomes),
  };
  switch (open.op) {
    case "gather":
      return emitTerminal(state, result, countedProvenance(open)).pipe(
        Effect.onExit((exit) =>
          close(Exit.isSuccess(exit) ? "completed" : "failed"),
        ),
      );
    case "all_gather":
      return closeAllGather(state, open, result, close);
    default: {
      const exhaustive: never = open.op;
      return exhaustive;
    }
  }
}

function retainCountedAnswer(
  state: CollectiveState,
  open: OpenGather,
  post: CertifiedPost,
  id: CollectiveId,
) {
  return Effect.gen(function* () {
    if (state.recovering) {
      return (
        state.counted.get(id)?.get(agentAddressOf(post.message.sender)) ===
        post.recordHash
      );
    }
    if ((yield* Clock.currentTimeMillis) >= open.deadlineAt) {
      return false;
    }
    return (
      (yield* durableEmit(
        state,
        state.ports.store.recordCollectiveAnswer({
          operationId: id,
          member: agentAddressOf(post.message.sender),
          recordHash: post.recordHash,
        }),
      )) === post.recordHash
    );
  });
}

/**
 * Whether an answer arrived where the operation's answers are sent.
 */
function answeredInConversation(
  open: OpenGather,
  message: InboundMessage,
): boolean {
  switch (open.op) {
    case "gather":
      return message.kind === "direct";
    case "all_gather":
      return message.kind === "group" && message.address === open.to;
    default: {
      const exhaustive: never = open.op;
      return exhaustive;
    }
  }
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
    state.ports.store.readCollectivePosts({
      operationId: prepared.id,
      role: "request",
    }),
  ).pipe(
    Effect.flatMap(
      (posts): Effect.Effect<never, SendError | CollectiveError> =>
        posts.length > 0
          ? Effect.fail(error)
          : abandonGroupRequest(state, prepared, error),
    ),
  );
}

/**
 * Abandon an all_gather whose group post failed: drop it, and refuse naming
 * every member with the post's reason and detail.
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
            postRefusal(agentAddressOf(member), error),
          ),
        }),
      ),
    ),
  );
}

/**
 * Retirement and deadline selection claim one terminal outcome before either cancels the timer.
 */
function forgetGather(
  state: CollectiveState,
  id: CollectiveId,
): Effect.Effect<boolean, SendError> {
  return state.transitions
    .withPermits(1)(
      Effect.uninterruptible(
        Effect.gen(function* () {
          const operation = yield* durableSend(
            state,
            state.ports.store.readCollectiveOperation(id),
          );
          if (operation !== undefined && operation.phase !== "collecting") {
            return;
          }
          if (operation !== undefined) {
            yield* durableSend(
              state,
              encodeRuntimeValue({ kind: "refused" }).pipe(
                Effect.flatMap((selection) =>
                  state.ports.store.retireCollectiveOperation(id, selection),
                ),
              ),
            );
          }
          const open = state.gathers.get(id);
          state.gathers.delete(id);
          const announced = state.announced.delete(id);
          return { timer: open?.timer, announced };
        }),
      ),
    )
    .pipe(
      Effect.flatMap((retired) => {
        if (retired === undefined) {
          return Effect.succeed(false);
        }
        return (
          retired.timer === undefined
            ? Effect.void
            : Fiber.interrupt(retired.timer)
        ).pipe(
          Effect.zipRight(
            retired.announced ? closedSpan(id, "refused") : Effect.void,
          ),
          Effect.as(true),
        );
      }),
    );
}

function releaseGather(
  state: CollectiveState,
  id: CollectiveId,
): Effect.Effect<void> {
  return Effect.suspend(() => {
    const open = state.gathers.get(id);
    state.gathers.delete(id);
    return open?.timer === undefined
      ? Effect.void
      : Fiber.interrupt(open.timer);
  });
}

/**
 * Record `collective.closed` as `refused` for an abandoned operation that
 * recorded `collective.opened` and whose completion does not already own the
 * span.
 */
function markRefused(
  state: CollectiveState,
  id: CollectiveId,
): Effect.Effect<void> {
  return Effect.suspend(() =>
    state.announced.delete(id) ? closedSpan(id, "refused") : Effect.void,
  );
}

/**
 * The short `collective.closed` span: the operation's result was emitted
 * (`completed`); its all_gather close was not certified, or its result or
 * failure could not be kept (`failed`); or it was abandoned after opening
 * (`refused`).
 */
function closedSpan(id: CollectiveId, outcome: ClosedOutcome) {
  return Effect.withSpan(Effect.void, "collective.closed", {
    captureStackTrace: false,
    attributes: { operationId: id, outcome },
  });
}

/** The transition permit keeps counted answers and request refusals ahead of one frozen decision. */
function freezeResult(
  state: CollectiveState,
  id: CollectiveId,
  open: OpenGather,
): Effect.Effect<CollectiveClosure, CollectiveEmitError> {
  return durableEmit(
    state,
    Effect.gen(function* () {
      const operation = yield* state.ports.store.readCollectiveOperation(id);
      if (operation?.canonicalSelection !== undefined) {
        const selection = yield* readCollectiveSelection(
          operation.canonicalSelection,
        );
        if (selection.kind !== "result") {
          return yield* new EndpointStoreError({ reason: "corrupt" });
        }
        return { closedAt: selection.closedAt, closedBy: selection.closedBy };
      }
      const closure: CollectiveClosure = {
        closedAt: yield* Clock.currentTimeMillis,
        closedBy:
          open.outcomes.size === open.members.length ? "settled" : "deadline",
      };
      const selection = yield* encodeRuntimeValue({
        kind: "result",
        ...closure,
        answers: [...open.answerHashes].map(([member, recordHash]) => ({
          member,
          recordHash,
        })),
      });
      yield* state.ports.store.finalizeCollectiveOperation(id, selection);
      return closure;
    }),
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
