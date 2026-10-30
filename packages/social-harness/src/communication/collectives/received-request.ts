/**
 * @file The requests a member endpoint received, and which one an answer
 * answers.
 *
 * The model sends an answer to the conversation its request arrived in. An
 * answer that names its request's operationId answers that request; one that names
 * none answers the one request open there, and is refused rather than
 * guessed when several are open.
 */

import { Duration, Either, Option } from "effect";
import type { AgentView } from "../../identity/cards.js";
import type { InboundMessage } from "../conversations/message.js";
import type { MsgId, RecordHash } from "../records/index.js";
import type {
  AgentAddress,
  GroupAddress,
  MessageAddressInput,
} from "../records/values.js";
import type { CertifiedMessage } from "./ports.js";
import type { SharedAnswers } from "./shared-answers.js";
import {
  CollectiveError,
  type CollectiveFailure,
  type CollectiveId,
  MAXIMUM_DEADLINE_SECONDS,
} from "./contracts.js";
import { questionText } from "./render.js";
import {
  collectiveRequesterOf,
  type CollectiveValue,
  type FormModeSchema,
} from "./wire/index.js";

/**
 * What matching reads of a received request: `to` is the canonical address
 * of the conversation it arrived in. `sending` holds the one answer in
 * flight, so a member answers at most once; an all_gather request becomes
 * `closed` at its close.
 */
export interface RequestStatus {
  readonly to: AgentAddress | GroupAddress;
  readonly deadlineAt: number;
  readonly state: "open" | "sending" | "answered" | "closed";
}

/** The one request an answer answers, with its operationId. */
export interface OpenRequest<Request extends RequestStatus> {
  readonly operationId: CollectiveId;
  readonly request: Request;
}

/** Named request refusal reveals no unrelated conversation or request identity. */
interface UnmatchedAnswer {
  readonly kind: UnansweredKind;
  readonly operationId?: CollectiveId;
}
type ConversationRefusal = UnmatchedAnswer;

type UnansweredKind = Extract<
  CollectiveFailure["kind"],
  `request-${"none" | "answered" | "expired"}`
>;

/**
 * A request this endpoint received. `msgId` is the request message it came in,
 * `recordHash` its certified record, and every answer goes to `to`. A refused
 * answer reopens the request.
 */
interface ReceivedRequestFields extends RequestStatus {
  readonly msgId: MsgId;
  readonly recordHash: RecordHash;
  readonly from: AgentView;
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
 * not yet answered, and before its deadline and close. An answer with `operationId`
 * answers the request with that operationId; one without, the one request open there.
 * @param requests Every request this endpoint holds, by operationId.
 * @param conversation The canonical address the answer is sent to.
 * @param now The current time in epoch milliseconds.
 * @param answer The request the answer names, if any.
 * @param answer.operationId The operationId of the request it names, if it names one.
 * @returns The open request, or why none takes the answer: several are open,
 *   one was already answered, none was received, or each has expired.
 */
export const matchOpenRequest = <Request extends RequestStatus>(
  requests: ReadonlyMap<CollectiveId, Request>,
  conversation: MessageAddressInput,
  now: number,
  answer: { readonly operationId: CollectiveId },
): Either.Either<OpenRequest<Request>, UnmatchedAnswer> =>
  namedRequest(requests, conversation, now, answer.operationId);

/** A named refusal never discloses requests the caller did not select. */
export const unmatchedAnswerError = (unmatched: UnmatchedAnswer) =>
  new CollectiveError({
    ...(unmatched.operationId === undefined
      ? {}
      : { operationId: unmatched.operationId }),
    failure: { kind: unmatched.kind },
  });

/**
 * The request state a request message opens, when it arrived where its
 * operation sends it and its operationId identifies its sender: a gather's in the
 * member's direct conversation with the requester before its deadline, an
 * all_gather's in a group conversation, whose other members are the ones
 * asked. The request remains available for close processing after its deadline. A deadline beyond
 * `RECEIVED_DEADLINE_HORIZON` opens nothing.
 * @param certified The request message and its certified record.
 * @param value The request's collective part.
 * @param now The current time in epoch milliseconds.
 * @returns The request to hold, or none when the message opens nothing.
 */
export function receivedRequest(
  certified: CertifiedMessage,
  value: CollectingValue,
  now: number,
): Option.Option<ReceivedRequest> {
  const { message } = certified;
  if (!trustedRequest(message, value, now)) {
    return Option.none();
  }
  const request: ReceivedRequestFields = {
    msgId: message.msgId,
    recordHash: certified.recordHash,
    from: message.sender,
    to: message.address,
    question: questionText(message.content),
    requestedSchema: value.requestedSchema,
    deadlineAt: value.deadlineAt,
    state: "open",
  };
  if (value.op === "gather") {
    return message.kind === "direct"
      ? Option.some({ ...request, kind: "gather" })
      : Option.none();
  }
  if (message.kind !== "group") {
    return Option.none();
  }
  const [first, ...rest] = message.members.filter(
    (member) => member.agentId !== message.sender.agentId,
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
 * The request with operationId `named`, when the runtime was shown it in
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
  if (request === undefined || request.to !== conversation) {
    return Either.left({ kind: "request-none" });
  }
  const unavailable = requestUnavailable(request, now);
  return unavailable === undefined
    ? Either.right({ operationId: named, request })
    : Either.left({ kind: unavailable, operationId: named });
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
      return "request-expired";
    default: {
      const exhaustive: never = request.state;
      return exhaustive;
    }
  }
}

/**
 * Whether a request's operationId identifies its sender and its deadline lies
 * within `RECEIVED_DEADLINE_HORIZON`.
 */
function trustedRequest(
  message: InboundMessage,
  value: CollectingValue,
  now: number,
): boolean {
  return (
    value.deadlineAt <= now + RECEIVED_DEADLINE_HORIZON &&
    collectiveRequesterOf(value.operationId) === message.sender.agentId
  );
}
