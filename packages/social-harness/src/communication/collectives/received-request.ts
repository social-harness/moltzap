/**
 * @file The requests a member endpoint received, and which one an answer
 * answers.
 *
 * The model sends an answer to the conversation its request arrived in. An
 * answer that names its request's id answers that request; one that names
 * none answers the one request open there, and is refused rather than
 * guessed when several are open.
 */

import { Duration, Either, Option } from "effect";
import type { InboundMessage } from "../conversations/message.js";
import type { PostId, RecordHash } from "../records/index.js";
import type {
  AgentAddress,
  GroupAddress,
  MessageAddressInput,
} from "../records/values.js";
import type { CertifiedPost } from "./ports.js";
import type { SharedAnswers } from "./shared-answers.js";
import {
  CollectiveError,
  type CollectiveFailure,
  type CollectiveId,
  MAXIMUM_DEADLINE_SECONDS,
  type OpenElsewhere,
} from "./forms.js";
import {
  collectiveIdOf,
  type CollectiveValue,
  type FormModeSchema,
} from "./part/index.js";
import { questionText } from "./render.js";

/**
 * What matching reads of a received request: `to` is the canonical address
 * of the conversation it arrived in. `sending` holds the one answer in
 * flight, so a member answers at most once; an all_gather request becomes
 * `closed` at its close. With a firewall installed a request starts
 * `unadmitted` and becomes `open` once the runtime is shown it, or `withheld`
 * when it is not; matching passes over both, as though the request had not
 * arrived.
 */
export interface RequestStatus {
  readonly to: AgentAddress | GroupAddress;
  readonly deadlineAt: number;
  readonly state:
    | "unadmitted"
    | "open"
    | "sending"
    | "answered"
    | "closed"
    | "withheld";
}

/** The one request an answer answers, with its id. */
export interface OpenRequest<Request extends RequestStatus> {
  readonly id: CollectiveId;
  readonly request: Request;
}

/**
 * Why no single request takes an answer: several are open, with their ids,
 * when the answer named none; or none was received, it was answered, or it
 * has expired, with the requests open in other conversations.
 */
type UnmatchedAnswer =
  | AmbiguousAnswer
  | {
      readonly kind: UnansweredKind;
      readonly openElsewhere: readonly OpenElsewhere[];
    };

/** Why an answer matches nothing in its own conversation. */
type ConversationRefusal = AmbiguousAnswer | { readonly kind: UnansweredKind };

interface AmbiguousAnswer {
  readonly kind: "request-ambiguous";
  readonly openIds: readonly CollectiveId[];
}

type UnansweredKind = Extract<
  CollectiveFailure["kind"],
  `request-${"none" | "answered" | "expired"}`
>;

/**
 * A request this endpoint received. `postId` is the request post it came in,
 * `recordHash` its certified record, and every answer goes to `to`. A refused
 * answer reopens the request.
 */
interface ReceivedRequestFields extends RequestStatus {
  readonly postId: PostId;
  readonly recordHash: RecordHash;
  readonly from: AgentAddress;
  /** The question as every member's model reads it. */
  readonly question: string;
  readonly requestedSchema: FormModeSchema;
  state: RequestStatus["state"];
}

/** The request kind determines whether answers are shared until a group close. */
export type ReceivedRequest = ReceivedRequestFields &
  (
    | { readonly kind: "gather" }
    | { readonly kind: "all_gather"; readonly shared: SharedAnswers }
  );

type CollectingValue = Extract<
  CollectiveValue,
  { readonly kind: "operation"; readonly op: "gather" | "all_gather" }
>;

/**
 * How long past its deadline a member keeps an all_gather request while it
 * waits for the requester's close. The requester closes at the deadline at
 * the latest, so the close normally follows within seconds; the bound frees
 * the request of a requester that never closes.
 */
const CLOSE_WAIT = Duration.hours(1);

/**
 * How far past the longest deadline a sender may state a received request's
 * deadline still lies. It absorbs clock skew between the two endpoints; a
 * request further out is consumed, which bounds how long its state is held
 * and keeps every stored deadline a representable date.
 */
const RECEIVED_DEADLINE_ALLOWANCE = Duration.hours(1);

/** The furthest past `now` a received request's deadline may lie. */
const RECEIVED_DEADLINE_HORIZON = Duration.toMillis(
  Duration.sum(
    Duration.seconds(MAXIMUM_DEADLINE_SECONDS),
    RECEIVED_DEADLINE_ALLOWANCE,
  ),
);

/**
 * Find the request an answer answers, open in its conversation: received,
 * not yet answered, and before its deadline and close. An answer with `id`
 * answers the request with that id; one without, the one request open there.
 * @param requests Every request this endpoint holds, by id.
 * @param conversation The canonical address the answer is sent to.
 * @param now The current time in epoch milliseconds.
 * @param answer The request the answer names, if any.
 * @param answer.id The id of the request it names, if it names one.
 * @returns The open request, or why none takes the answer: several are open,
 *   one was already answered, none was received, or each has expired.
 */
export const matchOpenRequest = <Request extends RequestStatus>(
  requests: ReadonlyMap<CollectiveId, Request>,
  conversation: MessageAddressInput,
  now: number,
  answer: { readonly id?: CollectiveId },
): Either.Either<OpenRequest<Request>, UnmatchedAnswer> => {
  const matched =
    answer.id === undefined
      ? onlyOpenRequest(requests, conversation, now)
      : namedRequest(requests, conversation, now, answer.id);
  return Either.mapLeft(
    matched,
    (unmatched): UnmatchedAnswer =>
      unmatched.kind === "request-ambiguous"
        ? unmatched
        : {
            kind: unmatched.kind,
            openElsewhere: openElsewhere(requests, conversation, now),
          },
  );
};

/**
 * The refusal of an answer no request takes; it names the open requests' ids
 * when the answer named none and several are open, and otherwise the
 * questions open in other conversations.
 * @param id The id minted for the refusal.
 * @param unmatched Why no request takes the answer.
 * @returns The error the answer fails with.
 */
export const unmatchedAnswerError = (
  id: CollectiveId,
  unmatched: UnmatchedAnswer,
) =>
  unmatched.kind === "request-ambiguous"
    ? new CollectiveError({
        id,
        failure: { kind: unmatched.kind },
        openIds: unmatched.openIds,
      })
    : new CollectiveError({
        id,
        failure: { kind: unmatched.kind },
        ...(unmatched.openElsewhere.length === 0
          ? {}
          : { openElsewhere: unmatched.openElsewhere }),
      });

/**
 * The request state a request post opens, when it arrived where its
 * operation sends it and its id derives from its sender: a gather's in the
 * member's direct conversation with the requester before its deadline, an
 * all_gather's in a group conversation, whose other members are the ones
 * asked, until `CLOSE_WAIT` past its deadline. A deadline beyond
 * `RECEIVED_DEADLINE_HORIZON` opens nothing. Under a firewall the request
 * starts `unadmitted`.
 * @param post The certified request post and its record.
 * @param value The request's collective part.
 * @param now The current time in epoch milliseconds.
 * @param initial The state the request starts in.
 * @returns The request to hold, or none when the post opens nothing.
 */
export function receivedRequest(
  post: CertifiedPost,
  value: CollectingValue,
  now: number,
  initial: "open" | "unadmitted",
): Option.Option<ReceivedRequest> {
  const { message } = post;
  if (!trustedRequest(message, value, now)) {
    return Option.none();
  }
  const request: ReceivedRequestFields = {
    postId: message.postId,
    recordHash: post.recordHash,
    from: message.sender,
    to: message.address,
    question: questionText(message.content),
    requestedSchema: value.requestedSchema,
    deadlineAt: value.deadlineAt,
    state: initial,
  };
  if (value.op === "gather") {
    return message.kind === "direct" && now < value.deadlineAt
      ? Option.some({ ...request, kind: "gather" })
      : Option.none();
  }
  if (
    message.kind !== "group" ||
    now >= retainedUntil({ ...request, kind: "all_gather" })
  ) {
    return Option.none();
  }
  const [first, ...rest] = message.members.filter(
    (member) => member !== message.sender,
  );
  return first === undefined
    ? Option.none()
    : Option.some({
        ...request,
        kind: "all_gather",
        shared: {
          members: [first, ...rest],
          answers: new Map(),
        },
      });
}

/**
 * Forget every request past the time `retainedUntil` gives it.
 * @param requests Every request this endpoint holds, by id.
 * @param now The current time in epoch milliseconds.
 */
export function forgetExpiredRequests(
  requests: Map<CollectiveId, ReceivedRequest>,
  now: number,
): void {
  for (const [id, request] of requests) {
    if (now >= retainedUntil(request)) {
      requests.delete(id);
    }
  }
}

/** The requests the runtime was shown that are open outside `conversation`, where an answer meant for them belongs. */
function openElsewhere(
  requests: ReadonlyMap<CollectiveId, RequestStatus>,
  conversation: MessageAddressInput,
  now: number,
): readonly OpenElsewhere[] {
  return [...requests].flatMap(([id, request]) =>
    request.to !== conversation &&
    requestShown(request.state) &&
    requestUnavailable(request, now) === undefined
      ? [{ id, to: request.to }]
      : [],
  );
}

/** The one request open in `conversation`, or why no single request is. */
function onlyOpenRequest<Request extends RequestStatus>(
  requests: ReadonlyMap<CollectiveId, Request>,
  conversation: MessageAddressInput,
  now: number,
): Either.Either<OpenRequest<Request>, ConversationRefusal> {
  const asked = [...requests]
    .filter(
      ([, request]) =>
        request.to === conversation && requestShown(request.state),
    )
    .map(([id, request]) => ({
      id,
      request,
      unavailable: requestUnavailable(request, now),
    }));
  const open = asked.filter(({ unavailable }) => unavailable === undefined);
  const [only] = open;
  if (only !== undefined && open.length === 1) {
    return Either.right({ id: only.id, request: only.request });
  }
  if (open.length > 1) {
    return Either.left({
      kind: "request-ambiguous",
      openIds: open.map(({ id }) => id),
    });
  }
  if (asked.some(({ unavailable }) => unavailable === "request-answered")) {
    return Either.left({ kind: "request-answered" });
  }
  return Either.left({
    kind: asked.length === 0 ? "request-none" : "request-expired",
  });
}

/**
 * The request with id `named`, when the runtime was shown it in
 * `conversation` and it is still open; otherwise why it takes no answer, as
 * `request-none` when no such request arrived there.
 */
function namedRequest<Request extends RequestStatus>(
  requests: ReadonlyMap<CollectiveId, Request>,
  conversation: MessageAddressInput,
  now: number,
  named: CollectiveId,
): Either.Either<OpenRequest<Request>, ConversationRefusal> {
  const request = requests.get(named);
  if (
    request === undefined ||
    request.to !== conversation ||
    !requestShown(request.state)
  ) {
    return Either.left({ kind: "request-none" });
  }
  const unavailable = requestUnavailable(request, now);
  return unavailable === undefined
    ? Either.right({ id: named, request })
    : Either.left({ kind: unavailable });
}

/**
 * Why a request the runtime was shown no longer takes an answer, or
 * undefined while it is open before its deadline.
 * @param request The received request's state and deadline.
 * @param now The current time in epoch milliseconds.
 * @returns The refusal an answer to it alone would get, or undefined.
 */
function requestUnavailable(
  request: RequestStatus,
  now: number,
): "request-answered" | "request-expired" | undefined {
  switch (request.state) {
    case "open":
      return now >= request.deadlineAt ? "request-expired" : undefined;
    case "sending":
    case "answered":
      return "request-answered";
    case "closed":
    case "unadmitted":
    case "withheld":
      return "request-expired";
    default: {
      const exhaustive: never = request.state;
      return exhaustive;
    }
  }
}

/** Whether the runtime was shown a request, so that answers can match it. */
function requestShown(state: RequestStatus["state"]): boolean {
  switch (state) {
    case "unadmitted":
    case "withheld":
      return false;
    case "open":
    case "sending":
    case "answered":
    case "closed":
      return true;
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}

/**
 * Whether a request's id derives from its sender and its deadline lies
 * within `RECEIVED_DEADLINE_HORIZON`.
 */
function trustedRequest(
  message: InboundMessage,
  value: CollectingValue,
  now: number,
): boolean {
  return (
    value.deadlineAt <= now + RECEIVED_DEADLINE_HORIZON &&
    collectiveIdOf(message.sender, value.nonce) === value.id
  );
}

/**
 * When this endpoint drops a received request: at its deadline, or for an
 * all_gather `CLOSE_WAIT` later, since its close follows the deadline.
 */
function retainedUntil(
  request: Pick<ReceivedRequest, "deadlineAt" | "kind">,
): number {
  return (
    request.deadlineAt +
    (request.kind === "all_gather" ? Duration.toMillis(CLOSE_WAIT) : 0)
  );
}
