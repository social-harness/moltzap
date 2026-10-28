/**
 * @file Collective operations over the post envelope.
 *
 * The daemon holds one `CollectiveOperations` per active identity. It turns
 * each send into the posts its operation certifies and each certified remote
 * post into the item the subscriber receives, or consumes it. Every post an
 * endpoint authors carries its operation as an explicit collective part, so
 * each certified post says which operation it belongs to; a post without a
 * collective part reads as multicast, the operation an omitted `op` names.
 *
 * Collective state lives in daemon memory: an operation open at a daemon
 * restart is lost, and a request whose delivery the member already
 * acknowledged can no longer be answered after one.
 *
 * ```mermaid
 * sequenceDiagram
 *   participant RM as Requester host
 *   participant RE as Requester endpoint
 *   participant ME as Member endpoint
 *   participant MM as Member host
 *   RM->>RE: send gather to, question, deadline, schema
 *   RE->>RE: validate schema, resolve every member, refuse an address error before any post
 *   RE->>RE: mint id, deadline = now + duration
 *   RE->>ME: one request post in each member's direct conversation
 *   alt every request post is refused
 *     RE-->>RM: error naming each member and its reason
 *   else otherwise, after at most 20 s
 *     RE-->>RM: operation id
 *     RE->>RE: a refused member is no-answer, a pending one settles later, no-answer at the deadline
 *   end
 *   ME->>MM: collectiveRequest item
 *   MM->>ME: send collectiveResponse to the requester, action, content
 *   ME->>ME: match the request open in that conversation, validate content against its schema
 *   ME->>RE: response post in the direct conversation
 *   RE->>RE: consume, validate and record the answer
 *   Note over RE: complete when every member has an outcome, or at the deadline
 *   RE->>RM: collectiveResult item
 * ```
 *
 * An all_gather asks a group in its own conversation. Every member endpoint
 * consumes the answers it sees there, so no model sees a peer's answer before
 * the close, and builds its result from exactly the answers the requester's
 * close lists.
 *
 * ```mermaid
 * sequenceDiagram
 *   participant RM as Requester host
 *   participant RE as Requester endpoint
 *   participant ME as Member endpoints
 *   participant MM as Member hosts
 *   RM->>RE: send all_gather to group, question, deadline, schema
 *   RE->>RE: validate schema, resolve every member, refuse an address error before any post
 *   RE->>ME: one request post in the group conversation
 *   alt the group post is refused or not certified in time
 *     RE-->>RM: error naming every member with the post's reason
 *   else the deadline completes it before its post certifies
 *     RE-->>RM: operation id, its result stands
 *   else request post certified
 *     RE-->>RM: operation id
 *   end
 *   ME->>MM: collectiveRequest item
 *   MM->>ME: send collectiveResponse to the group, action, content
 *   ME->>ME: match the request open in the group, validate content against its schema
 *   ME->>RE: response post to the group
 *   ME->>ME: peer response posts, consumed and recorded by record hash
 *   Note over RE: complete when every member has an outcome, or at the deadline
 *   RE->>ME: close post listing the counted answers' record hashes
 *   alt the close is not certified
 *     RE->>RM: operationFailed item, and members get no result
 *   else close certified
 *     RE->>RM: collectiveResult item
 *     ME->>ME: build the result from exactly the listed answers
 *     ME->>MM: collectiveResult item, the same outcomes
 *   end
 * ```
 */

import {
  Clock,
  Duration,
  Effect,
  Array as EffectArray,
  Either,
  Exit,
  Fiber,
  Option,
  Schema,
} from "effect";
import type { InboundMessage } from "../conversations/message.js";
import type { CollectiveMemberOutcome, InboundItem } from "./inbound.js";
import type {
  AdmittedGather,
  AdmittedPost,
  AuthoredPostError,
  BindHold,
  CertifiedPost,
  CollectiveOperations,
  CollectivePorts,
  CollectiveSendError,
  EngineSendInput,
  PostSender,
  ResultProvenance,
} from "./ports.js";
import { canonicalMessageAddress } from "../conversations/address.js";
import { SendError } from "../conversations/errors.js";
import {
  type AgentAddress,
  agentNameOf,
  type MessageAddressInput,
  type RecordHash,
} from "../records/index.js";
import {
  type OperationRefusal,
  refusedAs,
  type RefusedSend,
  refuseOperation,
  reportFailure,
} from "./failures.js";
import {
  closeFailureText,
  type CollectiveEmitError,
  CollectiveError,
  type CollectiveFailure,
  type CollectiveId,
  type CollectiveOperation,
  type CollectiveResponse,
  type CollectiveSendOutcome,
  describeIssues,
  type FailureDelivery,
  type SendInput,
} from "./forms.js";
import {
  type CollectiveValue,
  encodeCollectiveContent,
  FormModeSchema,
  mintCollectiveId,
  readCollectiveValue,
  withoutCollectivePart,
} from "./part/index.js";
import {
  forgetExpiredRequests,
  matchOpenRequest,
  type OpenRequest,
  type ReceivedRequest,
  receivedRequest,
  unmatchedAnswerError,
} from "./received-request.js";
import {
  gatherAddress,
  isAddressRefusal,
  lookupRefusals,
  operationTimes,
  postRefusal,
  type RequestRefusal,
  type RequestSend,
  requestsSoFar,
  requestWait,
} from "./request-sends.js";
import {
  type CertifiedAnswer,
  type CollectiveResultItem,
  type HeldClose,
  keepFirstAnswer,
  listedAnswers,
  memberOutcomes,
  type Members,
  type ResponseValue,
} from "./shared-answers.js";
import { outcomeOfResponse, validateAnswer } from "./validation.js";

type PostContent = InboundMessage["content"];

type CollectingOperation = Extract<
  CollectiveOperation,
  { readonly deadline: number }
>;

type CollectingValue = Extract<
  CollectiveValue,
  { readonly kind: "operation"; readonly op: "gather" | "all_gather" }
>;

type CloseValue = Extract<CollectiveValue, { readonly kind: "close" }>;

/**
 * The longest single sleep a deadline timer takes. A JavaScript timer longer
 * than about 24.8 days never fires, so a longer deadline is reached in steps.
 */
const DEADLINE_TIMER_STEP = Duration.days(1);

/**
 * A gather or all_gather this endpoint started, before its deadline timer is
 * running. `answerHashes` holds the certified record of each counted answer,
 * which an all_gather's close lists.
 */
interface GatherRequest {
  readonly op: CollectingOperation["op"];
  readonly to: MessageAddressInput;
  readonly question: string;
  readonly members: Members;
  readonly requestedSchema: FormModeSchema;
  readonly outcomes: Map<AgentAddress, CollectiveMemberOutcome>;
  readonly answerHashes: Map<AgentAddress, RecordHash>;
}

/**
 * An operation this endpoint started that has not completed. `timer`
 * completes it at its deadline; completing it earlier interrupts the timer.
 */
interface OpenGather extends GatherRequest {
  readonly timer: Fiber.RuntimeFiber<void>;
  requestsSettled: boolean;
}

interface CollectiveState {
  readonly ports: CollectivePorts;
  readonly gathers: Map<CollectiveId, OpenGather>;
  readonly requests: Map<CollectiveId, ReceivedRequest>;
  /**
   * Operations that recorded `collective.opened` whose `collective.closed`
   * neither completion nor abandonment has claimed yet.
   */
  readonly announced: Set<CollectiveId>;
}

const contentInvalid = () => new SendError({ reason: "content-invalid" });

const collectiveFailure = (id: CollectiveId, failure: CollectiveFailure) =>
  new CollectiveError({ id, failure });

/**
 * Build the collective layer for one active identity.
 * @param ports The daemon's post sending, item queue, scope and identity.
 * @returns Send and classification over state held in daemon memory.
 */
export const makeCollectiveOperations = (
  ports: CollectivePorts,
): CollectiveOperations => {
  const state: CollectiveState = {
    ports,
    gathers: new Map(),
    requests: new Map(),
    announced: new Set(),
  };
  return {
    send: (input, failureDelivery) =>
      "collectiveResponse" in input
        ? reportFailure(
            state.ports.emit,
            failureDelivery,
            respond(state, input.to, input.collectiveResponse),
          )
        : sendOperation(state, input, failureDelivery),
    classify: (message) => classify(state, message),
    settleRequest: (id, presented) =>
      Effect.sync(() => {
        const request = state.requests.get(id);
        if (request?.state === "unadmitted") {
          request.state = presented ? "open" : "withheld";
        }
      }),
  };
};

function sendOperation(
  state: CollectiveState,
  input: Extract<SendInput, { readonly text: string }>,
  failureDelivery: FailureDelivery,
): Effect.Effect<CollectiveSendOutcome, CollectiveSendError> {
  const operation = input.collective ?? {};
  switch (operation.op) {
    case undefined:
    case "multicast":
      return multicast(state, input.to, input.text);
    case "gather":
    case "all_gather":
      return reportFailure(
        state.ports.emit,
        failureDelivery,
        gather(state, input.to, input.text, operation),
      );
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
      state,
      { to, content },
      Effect.succeed(Effect.void),
    );
    const { postId } = yield* certified;
    return { postIds: [postId], postId, address, guidance };
  });
}

/**
 * A validated gather ready to fan out: its state, the request content every
 * member receives, its absolute deadline, and the time its send stops
 * waiting for request posts.
 */
interface PreparedGather {
  readonly id: CollectiveId;
  readonly open: GatherRequest;
  readonly content: PostContent;
  readonly deadlineAt: number;
  readonly waitUntil: number;
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
 * Validate a gather or all_gather before any post: mint its id, check its
 * schema against the form-mode grammar, name and resolve its members, fix
 * its absolute deadline, and build the request content within the content
 * limit.
 */
function prepareGather(
  state: CollectiveState,
  requestedTo: MessageAddressInput,
  question: string,
  operation: CollectingOperation,
): Effect.Effect<PreparedGather, RefusedSend<SendError | CollectiveError>> {
  return Effect.gen(function* () {
    const { id, nonce } = yield* mintCollectiveId(state.ports.self);
    const { to, members } = yield* gatherAddress(
      requestedTo,
      state.ports.self,
      operation.op,
    ).pipe(Effect.mapError(refusedAs(id, requestedTo)));
    const refused = refusedAs<SendError | CollectiveError>(id, to);
    const requestedSchema = yield* formModeSchema(
      id,
      operation.requestedSchema,
    ).pipe(Effect.mapError(refused));
    yield* refuseAddressErrors(state, members).pipe(
      Effect.mapError((failure) => refused(collectiveFailure(id, failure))),
    );
    const { deadlineAt, waitUntil } = yield* operationTimes(operation.deadline);
    const content = yield* encodeCollectiveContent(
      {
        kind: "operation",
        op: operation.op,
        id,
        nonce,
        deadlineAt,
        requestedSchema,
      },
      question,
    ).pipe(Effect.mapError(() => refused(contentInvalid())));
    const open: GatherRequest = {
      op: operation.op,
      to,
      question,
      members,
      requestedSchema,
      outcomes: new Map(),
      answerHashes: new Map(),
    };
    return { id, open, content, deadlineAt, waitUntil };
  });
}

/**
 * Start a gather or all_gather. A gather is checked once by an installed
 * firewall before anything else; its deadline timer then starts, it opens so
 * answers can be recorded while its requests are still being sent, and its
 * request posts go out through the sender the check admitted. An
 * all_gather's one group post is checked as the agent's post, and its timer
 * starts and it opens just before that post binds. A firewall refusal is the
 * send's own failure, never routed inbound.
 */
function gather(
  state: CollectiveState,
  requestedTo: MessageAddressInput,
  question: string,
  operation: CollectingOperation,
): Effect.Effect<CollectiveSendOutcome, OperationRefusal> {
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
    return { ...sent, operationId: prepared.id };
  });
}

/**
 * Admit a gather, open it, and send its request posts through the sender
 * the check admitted. The admitting check's advice stays with the outcome,
 * and with a refusal that follows admission.
 */
function gatherRequests(
  state: CollectiveState,
  prepared: PreparedGather,
): Effect.Effect<CollectiveSendOutcome, OperationRefusal> {
  return admitGather(state, prepared).pipe(
    Effect.mapError(refuseOperation(prepared.id, prepared.open.to)),
    Effect.flatMap(({ sendRequest, guidance }) =>
      openGather(state, prepared, false).pipe(
        Effect.zipRight(sendRequests(state, prepared, sendRequest)),
        Effect.map((sent) => ({ ...sent, guidance })),
        Effect.mapError(refusedAs(prepared.id, prepared.open.to, guidance)),
      ),
    ),
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
  return admission === undefined
    ? Effect.succeed({ sendRequest: state.ports.sendPost })
    : admission.admitGather({
        to: prepared.open.to,
        content: prepared.content,
      });
}

/**
 * Resolve every member before any post through the engine's address
 * resolution. A malformed or unknown member, or invalid membership, refuses
 * the whole send naming each one; any other lookup failure is left to the
 * post, which reports it as a delivery failure.
 */
function refuseAddressErrors(
  state: CollectiveState,
  members: Members,
): Effect.Effect<void, CollectiveFailure> {
  return lookupRefusals(members, state.ports.lookupMember).pipe(
    Effect.map((refusals) => refusals.filter(isAddressRefusal)),
    Effect.flatMap(([first, ...rest]) =>
      first === undefined
        ? Effect.void
        : Effect.fail<CollectiveFailure>({
            kind: "members-unreachable",
            members: [first, ...rest],
          }),
    ),
  );
}

/** Sleep until the absolute time `at`, in steps no timer overflows. */
function sleepUntil(at: number): Effect.Effect<void> {
  return Clock.currentTimeMillis.pipe(
    Effect.flatMap((now) =>
      now >= at
        ? Effect.void
        : Effect.sleep(
            Duration.min(Duration.millis(at - now), DEADLINE_TIMER_STEP),
          ).pipe(Effect.zipRight(sleepUntil(at))),
    ),
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
): Effect.Effect<CollectiveSendOutcome, CollectiveError | SendError> {
  return Effect.gen(function* () {
    const { id, open } = prepared;
    const sends = yield* Effect.forEach(
      open.members,
      (member): Effect.Effect<RequestSend> =>
        sendRequest({ to: member, content: prepared.content }).pipe(
          Effect.mapError((error) => postRefusal(member, error)),
          Effect.tapError((refusal) => recordRefusal(state, id, refusal)),
          Effect.either,
          Effect.forkIn(state.ports.scope),
        ),
      { concurrency: 1 },
    );
    yield* Fiber.awaitAll(sends).pipe(
      Effect.timeoutOption(yield* requestWait(prepared.waitUntil)),
    );
    const { posts, refused } = yield* requestsSoFar(sends);
    const [refusal, ...refusals] = refused;
    if (
      refusal !== undefined &&
      refusals.length + 1 === open.members.length &&
      state.gathers.has(id)
    ) {
      yield* forgetGather(state, id);
      return yield* Effect.fail(
        collectiveFailure(id, {
          kind: "members-unreachable",
          members: [refusal, ...refusals],
        }),
      );
    }
    yield* Effect.ignore(
      updateGather(state, id, (settled) => {
        settled.requestsSettled = true;
      }),
    );
    return { postIds: posts.map((post) => post.postId) };
  });
}

/** Record a member whose request post was refused as `no-answer`. */
function recordRefusal(
  state: CollectiveState,
  id: CollectiveId,
  { member }: RequestRefusal,
): Effect.Effect<void> {
  return Effect.ignore(
    updateGather(state, id, ({ outcomes }) => {
      if (!outcomes.has(member)) {
        outcomes.set(member, { kind: "no-answer" });
      }
    }),
  );
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
  return Effect.suspend(() => {
    const open = state.gathers.get(id);
    if (open === undefined) {
      return Effect.void;
    }
    change(open);
    return open.requestsSettled && open.outcomes.size === open.members.length
      ? completeGather(state, id).pipe(
          Effect.zipRight(Fiber.interrupt(open.timer)),
        )
      : Effect.void;
  });
}

/**
 * Send an all_gather's one request post to the group and wait for it, never
 * past the deadline. A refused post, or one still uncertified when the wait
 * ends, abandons the all_gather: the group's GENESIS needs every member. The
 * deadline timer is forked, and the all_gather opened, just before the post
 * binds and so before the wait starts, so the timer can complete the
 * all_gather first; its result then stands and the send succeeds with the
 * advice the admitting check gave, so an operation ends in exactly one
 * refusal or one result. A firewall's check runs before that, outside the
 * wait, and a refusal binds nothing and opens nothing. A group post succeeds
 * or fails as a whole, so the refusal names every member with the post's
 * reason and detail; members whose address resolution fails were refused
 * before the post. A bind that fails after giving its hold up closes the
 * operation as refused; one that keeps the hold leaves the operation to its
 * deadline.
 */
function sendGroupRequest(
  state: CollectiveState,
  prepared: PreparedGather,
): Effect.Effect<CollectiveSendOutcome, OperationRefusal> {
  const { id, open } = prepared;
  const hold = openGather(state, prepared, true).pipe(
    Effect.as(releaseGather(state, id)),
  );
  return bindAuthoredPost(
    state,
    { to: open.to, content: prepared.content },
    hold,
  ).pipe(
    Effect.onExit((exit) =>
      Exit.isSuccess(exit) || state.gathers.has(id)
        ? Effect.void
        : markRefused(state, id),
    ),
    Effect.catchTag("SendError", (error) =>
      abandonGroupRequest(state, prepared, error),
    ),
    Effect.mapError(refuseOperation(id, open.to)),
    Effect.flatMap(({ certified, guidance }) =>
      withinRequestWait(prepared, certified).pipe(
        Effect.map((post) => ({ postIds: [post.postId], guidance })),
        Effect.catchTag("SendError", (error) =>
          state.gathers.has(id)
            ? abandonGroupRequest(state, prepared, error)
            : Effect.succeed({ postIds: [], guidance }),
        ),
        Effect.mapError(refusedAs(id, open.to, guidance)),
      ),
    ),
  );
}

/** A request post, failing as uncertified when the send's wait ends first. */
function withinRequestWait(
  prepared: PreparedGather,
  certified: AdmittedPost["certified"],
) {
  return requestWait(prepared.waitUntil).pipe(
    Effect.flatMap((duration) =>
      Effect.timeoutFail(certified, {
        duration,
        onTimeout: () => new SendError({ reason: "certification-unavailable" }),
      }),
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
): Effect.Effect<never, CollectiveError> {
  return forgetGather(state, prepared.id).pipe(
    Effect.zipRight(
      Effect.fail(
        collectiveFailure(prepared.id, {
          kind: "members-unreachable",
          members: EffectArray.map(prepared.open.members, (member) =>
            postRefusal(member, error),
          ),
        }),
      ),
    ),
  );
}

/**
 * Start an operation's deadline timer and open it, so answers are recorded
 * from now on. A gather's requests settle when its send returns; an
 * all_gather's one post settles it at once. An all_gather opens inside the
 * engine's uninterruptible bind hold, so the timer is made interruptible
 * explicitly: abandoning the operation must be able to stop it. An
 * operation whose deadline passed while a firewall checked it is refused as
 * `deadline-passed` instead: nothing posts, and no result follows. The first
 * opening records a short `collective.opened` span with the operation's id, op
 * and absolute `deadlineAt`, so a trace reader can hold the operation open
 * until its `collective.closed` span. A stale firewall check gives an
 * all_gather's bind hold up and takes it again, which reopens the operation
 * without a second span.
 */
function openGather(
  state: CollectiveState,
  prepared: PreparedGather,
  requestsSettled: boolean,
): Effect.Effect<void, CollectiveError> {
  return Effect.gen(function* () {
    if ((yield* Clock.currentTimeMillis) >= prepared.deadlineAt) {
      return yield* new CollectiveError({
        id: prepared.id,
        failure: { kind: "deadline-passed" },
      });
    }
    const timer = yield* sleepUntil(prepared.deadlineAt).pipe(
      Effect.zipRight(Effect.ignore(completeGather(state, prepared.id))),
      Effect.interruptible,
      Effect.forkIn(state.ports.scope),
    );
    const firstOpening = yield* Effect.sync(() => {
      state.gathers.set(prepared.id, {
        ...prepared.open,
        timer,
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

/** Drop an operation this endpoint abandons, and stop its deadline timer. */
function forgetGather(
  state: CollectiveState,
  id: CollectiveId,
): Effect.Effect<void> {
  return releaseGather(state, id).pipe(Effect.zipRight(markRefused(state, id)));
}

/**
 * Drop an operation and stop its deadline timer, leaving its spans open: a
 * stale bind gives its hold up this way and takes it again.
 */
function releaseGather(
  state: CollectiveState,
  id: CollectiveId,
): Effect.Effect<void> {
  return Effect.suspend(() => {
    const open = state.gathers.get(id);
    state.gathers.delete(id);
    return open === undefined ? Effect.void : Fiber.interrupt(open.timer);
  });
}

type ClosedOutcome = "completed" | "failed" | "refused";

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
  return Effect.suspend(() => {
    const open = state.gathers.get(id);
    if (open === undefined) {
      return Effect.void;
    }
    state.gathers.delete(id);
    const announced = state.announced.delete(id);
    const close = (outcome: ClosedOutcome) =>
      announced ? closedSpan(id, outcome) : Effect.void;
    const result: CollectiveResultItem = {
      kind: "collectiveResult",
      op: open.op,
      id,
      to: open.to,
      question: open.question,
      outcomes: memberOutcomes(open.members, open.outcomes),
    };
    switch (open.op) {
      case "gather":
        return state.ports
          .emit(result, countedProvenance(open))
          .pipe(
            Effect.onExit((exit) =>
              close(Exit.isSuccess(exit) ? "completed" : "failed"),
            ),
          );
      case "all_gather":
        return closeAllGather(state, open, result, close).pipe(
          Effect.forkIn(state.ports.scope),
          Effect.asVoid,
        );
      default: {
        const exhaustive: never = open.op;
        return exhaustive;
      }
    }
  });
}

/**
 * Post an all_gather's close, listing the certified record of every answer
 * its result counts, and emit the result once the close is certified. A close
 * that is not certified ends the operation at the asker as an
 * `operationFailed` item, whose text says when the close is still queued for
 * the members. `close` records the operation's `collective.closed` span once
 * the result or failure is emitted, or could not be.
 */
function closeAllGather(
  state: CollectiveState,
  open: OpenGather,
  result: CollectiveResultItem,
  close: (outcome: ClosedOutcome) => Effect.Effect<void>,
): Effect.Effect<void, CollectiveEmitError> {
  const included = open.members.flatMap((member) =>
    Option.toArray(Option.fromNullable(open.answerHashes.get(member))),
  );
  return encodeCollectiveContent({
    kind: "close",
    id: result.id,
    included,
  }).pipe(
    Effect.mapError(contentInvalid),
    Effect.flatMap((content) => state.ports.sendPost({ to: open.to, content })),
    Effect.matchEffect({
      onFailure: (error) =>
        state.ports
          .emit({
            kind: "operationFailed",
            id: result.id,
            to: open.to,
            error: closeFailureText(error),
          })
          .pipe(Effect.as<ClosedOutcome>("failed")),
      onSuccess: () =>
        state.ports
          .emit(result, countedProvenance(open))
          .pipe(Effect.as<ClosedOutcome>("completed")),
    }),
    Effect.onExit((exit) =>
      close(Exit.isSuccess(exit) ? exit.value : "failed"),
    ),
    Effect.asVoid,
  );
}

/** The record of every answer an operation this endpoint started counted, in member order. */
function countedProvenance(open: GatherRequest): ResultProvenance {
  return {
    answers: open.members.flatMap((member) => {
      const recordHash = open.answerHashes.get(member);
      return recordHash === undefined ? [] : [{ member, recordHash }];
    }),
  };
}

/**
 * Answer a request open in the conversation `to` names: the one the answer's
 * `id` names, or without one the one request open there; when no request is
 * matched, nothing is sent. An installed firewall checks the answer before
 * `claimRequest` claims the matched request by its id, so a close or the
 * deadline landing during the check refuses the answer without sending, and a
 * request opening during it does not change which one is answered. When the
 * item that settling the answer emits cannot be kept, the answer keeps its own
 * outcome, its post or its refusal.
 */
function respond(
  state: CollectiveState,
  to: MessageAddressInput,
  response: CollectiveResponse,
): Effect.Effect<CollectiveSendOutcome, OperationRefusal> {
  return Effect.gen(function* () {
    const { id, request } = yield* openRequest(state, to, response);
    const refused = refusedAs<SendError | CollectiveError>(id, request.to);
    const value: ResponseValue = { ...response, kind: "response", id };
    const content = yield* responseContent(request, value).pipe(
      Effect.mapError(refused),
    );
    const { certified, guidance } = yield* bindAuthoredPost(
      state,
      { to: request.to, content },
      claimRequest(state, id, request).pipe(Effect.mapError(refused)),
    ).pipe(
      Effect.catchTag("SendError", (error) => Effect.fail(refused(error))),
    );
    const { postId } = yield* certified.pipe(
      Effect.tapBoth({
        onFailure: () =>
          Effect.ignore(settleAnswer(state, id, request, Option.none())),
        onSuccess: (sent) =>
          Effect.ignore(
            settleAnswer(
              state,
              id,
              request,
              Option.some({ recordHash: sent.recordHash, response: value }),
            ),
          ),
      }),
      Effect.onInterrupt(() =>
        Effect.ignore(settleAnswer(state, id, request, Option.none())),
      ),
      Effect.mapError(
        refusedAs<SendError | CollectiveError>(id, request.to, guidance),
      ),
    );
    const address = request.to;
    return { operationId: id, postIds: [postId], postId, address, guidance };
  });
}

/**
 * Bind one post the agent authored, holding `hold` across the bind: through
 * the firewall's check when one is installed, otherwise by taking the hold
 * and sending through `sendPost`.
 */
function bindAuthoredPost<E>(
  state: CollectiveState,
  input: EngineSendInput,
  hold: BindHold<E>,
): Effect.Effect<AdmittedPost, AuthoredPostError<E>> {
  const { admission } = state.ports;
  return admission === undefined
    ? hold.pipe(Effect.as({ certified: state.ports.sendPost(input) }))
    : admission.bindPost(input, hold);
}

/**
 * The request `response` answers in the conversation `to` names. A refusal
 * names an id minted for it, since no request is answered.
 */
function openRequest(
  state: CollectiveState,
  to: MessageAddressInput,
  response: CollectiveResponse,
): Effect.Effect<
  OpenRequest<ReceivedRequest>,
  RefusedSend<SendError | CollectiveError>
> {
  return Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const { id } = yield* mintCollectiveId(state.ports.self);
    const self = agentNameOf(state.ports.self);
    const { address } = yield* canonicalMessageAddress(to, self).pipe(
      Effect.mapError(refusedAs<SendError | CollectiveError>(id, to)),
    );
    return yield* matchOpenRequest(state.requests, address, now, response).pipe(
      Effect.mapError((unmatched) =>
        refusedAs<SendError | CollectiveError>(
          id,
          address,
        )(unmatchedAnswerError(id, unmatched)),
      ),
    );
  });
}

/**
 * Validate an `accept` answer against the request's stored schema and build
 * the response post's content, which carries no text.
 */
function responseContent(
  request: ReceivedRequest,
  response: ResponseValue,
): Effect.Effect<PostContent, SendError | CollectiveError> {
  const validated =
    response.action === "accept"
      ? validateAnswer(request.requestedSchema, response.content).pipe(
          Effect.mapError((fields) =>
            collectiveFailure(response.id, { kind: "answer-invalid", fields }),
          ),
        )
      : Effect.void;
  return validated.pipe(
    Effect.zipRight(
      encodeCollectiveContent(response).pipe(Effect.mapError(contentInvalid)),
    ),
  );
}

/**
 * Hold the request's one answer: match the request `openRequest` matched
 * again by its id, still open in its conversation and before its deadline,
 * and claim it. The match and the claim run in one step, with no yield
 * between them, so of two concurrent answers only one is sent. The hold's
 * release reopens a request whose answer bound nothing.
 */
function claimRequest(
  state: CollectiveState,
  id: CollectiveId,
  request: ReceivedRequest,
): BindHold<CollectiveError> {
  return Clock.currentTimeMillis.pipe(
    Effect.flatMap((now) =>
      Effect.suspend(() =>
        Either.match(
          matchOpenRequest(state.requests, request.to, now, { id }),
          {
            onLeft: (unmatched) =>
              Effect.fail(unmatchedAnswerError(id, unmatched)),
            onRight: () => {
              request.state = "sending";
              return Effect.succeed(reopenRequest(request));
            },
          },
        ),
      ),
    ),
  );
}

/** Reopen a request whose answer is still being sent, so another answer can claim it. */
function reopenRequest(request: ReceivedRequest): Effect.Effect<void> {
  return Effect.sync(() => {
    if (request.state === "sending") {
      request.state = "open";
    }
  });
}

/**
 * Settle a request's answer send: answered with the certified answer, or
 * reopened when it was refused. A member's own answer never arrives inbound,
 * so an all_gather member records it here, and applies a close that was
 * waiting for it; after a refused answer that close lists a record this
 * endpoint will not hold, so applying it drops it. A request already closed
 * stays closed: its result is out, and a close delivered again must not
 * apply a second time.
 */
function settleAnswer(
  state: CollectiveState,
  id: CollectiveId,
  request: ReceivedRequest,
  certified: Option.Option<CertifiedAnswer>,
): Effect.Effect<void, CollectiveEmitError> {
  return Effect.suspend(() => {
    if (request.state === "closed") {
      return Effect.void;
    }
    request.state = Option.isSome(certified) ? "answered" : "open";
    if (request.kind === "gather") {
      return Effect.void;
    }
    const { shared } = request;
    if (Option.isSome(certified)) {
      shared.answers.set(state.ports.self, certified.value);
    }
    const held = shared.heldClose;
    shared.heldClose = undefined;
    return held === undefined
      ? Effect.void
      : applyClose(state, { id, request }, held);
  });
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
        `consumed post ${message.postId} from ${message.sender}: its collective part is ${error.reason}`,
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
): Effect.Effect<Option.Option<InboundItem>> {
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
): Effect.Effect<Option.Option<InboundItem>> {
  const { message } = post;
  return Clock.currentTimeMillis.pipe(
    Effect.map((now) => {
      const received = receivedRequest(
        post,
        value,
        now,
        state.ports.admission === undefined ? "open" : "unadmitted",
      );
      const held = state.requests.get(value.id);
      if (
        Option.isNone(received) ||
        (held ?? received.value).postId !== message.postId
      ) {
        return Option.none();
      }
      if (held === undefined) {
        forgetExpiredRequests(state.requests, now);
        state.requests.set(value.id, received.value);
      }
      return now < value.deadlineAt
        ? Option.some<InboundItem>({
            kind: "collectiveRequest",
            op: value.op,
            id: value.id,
            postId: message.postId,
            from: message.sender,
            to: received.value.to,
            question: received.value.question,
            requestedSchema: value.requestedSchema,
            deadlineAt: value.deadlineAt,
          })
        : Option.none();
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
  const { message } = post;
  if (
    !answeredInConversation(open, message) ||
    !open.members.includes(message.sender) ||
    open.outcomes.has(message.sender)
  ) {
    return Effect.void;
  }
  return outcomeOfResponse(open.requestedSchema, value).pipe(
    Effect.flatMap((outcome) => {
      return updateGather(state, value.id, () => {
        open.outcomes.set(message.sender, outcome);
        open.answerHashes.set(message.sender, post.recordHash);
      });
    }),
  );
}

/** Whether an answer arrived where the operation's answers are sent. */
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

function recordPeerAnswer(
  request: Extract<ReceivedRequest, { readonly kind: "all_gather" }>,
  post: CertifiedPost,
  value: ResponseValue,
): void {
  const { message } = post;
  if (
    request.state === "closed" ||
    message.kind !== "group" ||
    message.address !== request.to
  ) {
    return;
  }
  keepFirstAnswer(request.shared, message.sender, {
    recordHash: post.recordHash,
    response: value,
  });
}

/**
 * Receive an all_gather's close. Only the requester's close in the group
 * conversation of a request this endpoint holds counts. The held request's id
 * derives from its requester, so a close from any other sender names an id
 * that does not derive from that sender; it, and a close for an id this
 * endpoint does not hold, is consumed and logged. Only the first close in the
 * conversation counts, as at every other member: a later one, including one
 * that arrives while the first is held, changes nothing.
 */
function receiveClose(
  state: CollectiveState,
  message: InboundMessage,
  value: CloseValue,
): Effect.Effect<void, CollectiveEmitError> {
  return Effect.suspend(() => {
    const request = state.requests.get(value.id);
    if (
      request?.kind !== "all_gather" ||
      message.kind !== "group" ||
      message.address !== request.to ||
      message.sender !== request.from
    ) {
      return Effect.logWarning(
        `consumed close ${message.postId} from ${message.sender}: it closes no all_gather this endpoint was asked by its sender`,
      );
    }
    if (request.state === "closed" || request.shared.heldClose !== undefined) {
      return Effect.void;
    }
    return applyClose(
      state,
      { id: value.id, request },
      { postId: message.postId, included: value.included },
    );
  });
}

/**
 * Build a member's all_gather result from exactly the answers a close lists,
 * and emit it.
 *
 * Every listed answer precedes the close in the group conversation's
 * certified chain. The store appends a conversation's records only in chain
 * order and pending deliveries are read in that order, so each peer answer
 * the close lists was recorded before the close is classified. The member's
 * own answer is not delivered inbound: it is recorded when its send returns,
 * and a close that arrives while that send is in flight is held until it
 * returns. A listed record the endpoint still does not hold, or one listed
 * twice, means the close does not describe this endpoint's history, for
 * instance after a daemon restart; it is consumed and logged, and no result
 * is emitted. Once closed, the request keeps no answers.
 */
function applyClose(
  state: CollectiveState,
  asked: OpenRequest<Extract<ReceivedRequest, { readonly kind: "all_gather" }>>,
  close: HeldClose,
): Effect.Effect<void, CollectiveEmitError> {
  const { id, request } = asked;
  const { shared } = request;
  const { answers, missing, repeated } = listedAnswers(shared, close.included);
  if (missing && request.state === "sending") {
    shared.heldClose = close;
    return Effect.void;
  }
  request.state = "closed";
  shared.answers.clear();
  if (missing || repeated) {
    return Effect.logWarning(
      `consumed close ${close.postId} of ${id}: it lists answers this endpoint does not hold`,
    );
  }
  return Effect.forEach(
    answers,
    (answer) =>
      outcomeOfResponse(request.requestedSchema, answer.response).pipe(
        Effect.map((outcome) => [answer.member, outcome] as const),
      ),
    { concurrency: 1 },
  ).pipe(
    Effect.flatMap((outcomes) =>
      state.ports.emit(
        {
          kind: "collectiveResult",
          op: "all_gather",
          id,
          to: request.to,
          question: request.question,
          outcomes: memberOutcomes(shared.members, new Map(outcomes)),
        },
        {
          answers: answers.flatMap((answer) =>
            answer.member === state.ports.self
              ? []
              : [{ member: answer.member, recordHash: answer.recordHash }],
          ),
          request: request.recordHash,
        },
      ),
    ),
  );
}
