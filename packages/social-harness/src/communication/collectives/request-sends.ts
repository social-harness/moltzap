/**
 * @file Who a gather's request messages go to, how long its send waits for
 * them, the messages while they are sent, and how each one is settled when the
 * requester stops waiting.
 */

import {
  Clock,
  Duration,
  Effect,
  Either,
  Exit,
  Fiber,
  Option,
  Schema,
  type Scope,
} from "effect";
import type { EngineSentMessage } from "../conversations/index.js";
import type { CollectiveOperation } from "./contracts.js";
import type { CollectivePorts } from "./ports.js";
import type { PreparedGather } from "./state.js";
import { canonicalMessageAddress } from "../conversations/address.js";
import { SendError } from "../conversations/errors.js";
import {
  AgentAddress,
  agentNameOf,
  type MessageAddressInput,
} from "../records/values.js";

/**
 * A member whose request message was refused, and why.
 */
export type RequestRefusal = Readonly<{
  member: AgentAddress;
  reason: SendError["reason"];
  detail?: string;
}>;

/**
 * The refusal of a member whose message failed with `error`.
 * @param member The member the message was for.
 * @param error The message's send failure.
 * @returns The member with the failure's reason and any detail.
 */
export const messageRefusal = (
  member: AgentAddress,
  error: SendError,
): RequestRefusal =>
  error.detail === undefined
    ? { member, reason: error.reason }
    : { member, reason: error.reason, detail: error.detail };

const decodeAgentAddress = Schema.decodeUnknownOption(AgentAddress);

/** A collecting operation's canonical address and the members it asks. */
interface GatherAddress {
  readonly to: MessageAddressInput;
  readonly members: readonly [AgentAddress, ...AgentAddress[]];
}

/**
 * The canonical address a collecting operation's result and failure name, by
 * the rule every send shares, and the members it asks: the one agent of an
 * `agent:` address, or every member of a group but the requester. An
 * all_gather asks a group in its conversation, so an `agent:` address is
 * refused as `membership-invalid`.
 */
export function gatherAddress(
  to: MessageAddressInput,
  self: AgentAddress,
  op: Extract<CollectiveOperation, { readonly deadline: number }>["op"],
): Effect.Effect<GatherAddress, SendError> {
  const selfName = agentNameOf(self);
  const membershipInvalid = new SendError({
    reason: "membership-invalid",
    detail: "an all_gather asks a group of two or more other agents",
  });
  return canonicalMessageAddress(to, selfName).pipe(
    Effect.flatMap((canonical): Effect.Effect<GatherAddress, SendError> => {
      if (canonical.kind === "direct") {
        return op === "gather"
          ? Effect.succeed({
              to: canonical.address,
              members: [canonical.address],
            })
          : Effect.fail(membershipInvalid);
      }
      const [first, ...rest] = canonical.memberNames
        .filter((name) => name !== selfName)
        .flatMap((name) => Option.toArray(decodeAgentAddress(`agent:${name}`)));
      return first === undefined
        ? Effect.fail(membershipInvalid)
        : Effect.succeed({ to: canonical.address, members: [first, ...rest] });
    }),
  );
}

/**
 * How long a collecting operation's send waits for its request messages before
 * returning. A gather's request still uncertified then is left running: its
 * member answers or is reported as no-answer at the deadline. An all_gather's
 * bound group message returns delivery-pending when it is still uncertified;
 * that same message remains accepted work. The wait stays under the MCP
 * SDK's request timeout so a waiting host receives the result rather than a
 * transport timeout. It runs from the send's start, so a firewall's check of
 * the operation comes out of it. Only certification of a durably bound
 * all_gather message is timed; attachment and binding retain their own failure
 * boundaries.
 */
const REQUEST_SEND_WAIT = Duration.seconds(20);

/**
 * An operation's absolute deadline, and when its send stops waiting for
 * request messages.
 * @param deadlineSeconds The operation's deadline, in seconds from now.
 * @returns Both times in milliseconds since the epoch.
 */
export function operationTimes(deadlineSeconds: number): Effect.Effect<{
  readonly deadlineAt: number;
  readonly waitUntil: number;
}> {
  return Clock.currentTimeMillis.pipe(
    Effect.map((now) => {
      const untilDeadline = Duration.toMillis(
        Duration.seconds(deadlineSeconds),
      );
      return {
        deadlineAt: now + untilDeadline,
        waitUntil:
          now + Math.min(Duration.toMillis(REQUEST_SEND_WAIT), untilDeadline),
      };
    }),
  );
}

/**
 * A request message, failing as uncertified when the send's wait ends first.
 */
export function withinRequestWait<R>(
  waitUntil: number,
  certified: Effect.Effect<EngineSentMessage, SendError, R>,
) {
  return requestWait(waitUntil).pipe(
    Effect.flatMap((duration) =>
      Effect.timeoutFail(certified, {
        duration,
        onTimeout: () => new SendError({ reason: "delivery-pending" }),
      }),
    ),
  );
}

/**
 * How long a send still waits for request messages: until its wait ends, never
 * past the deadline.
 * @param waitUntil When the send stops waiting, from {@link operationTimes}.
 * @returns The remaining wait, zero once it has passed.
 */
export function requestWait(
  waitUntil: number,
): Effect.Effect<Duration.Duration> {
  return Clock.currentTimeMillis.pipe(
    Effect.map((now) => Duration.millis(Math.max(0, waitUntil - now))),
  );
}

/** A request message in flight, resolving to the member's refusal, if any. */
export type RequestSend = Fiber.RuntimeFiber<
  Either.Either<EngineSentMessage, RequestRefusal>
>;

/**
 * Where a gather's request messages stand when the send stops waiting: each
 * certified message and each member refused. A send still pending keeps
 * running and is in neither.
 * @param sends Each member's request send.
 * @returns The messages and refusals, in member order.
 */
export const requestsSoFar = (
  sends: readonly RequestSend[],
): Effect.Effect<{
  readonly messages: EngineSentMessage[];
  readonly refused: RequestRefusal[];
}> =>
  Effect.forEach(
    sends,
    (send) =>
      Fiber.poll(send).pipe(
        Effect.map((poll) =>
          Option.flatMap(poll, (exit) =>
            Exit.isSuccess(exit) ? Option.some(exit.value) : Option.none(),
          ),
        ),
      ),
    { concurrency: 1 },
  ).pipe(
    Effect.map((states) => ({
      messages: states.flatMap((result) =>
        Option.toArray(Option.flatMap(result, Either.getRight)),
      ),
      refused: states.flatMap((result) =>
        Option.toArray(Option.flatMap(result, Either.getLeft)),
      ),
    })),
  );

/**
 * Keep each sleep below the JavaScript timer limit, so a long deadline cannot
 * overflow to an immediate wake-up.
 */
const DEADLINE_TIMER_STEP = Duration.days(1);

/** Sleep until the absolute time `at`, in steps no timer overflows. */
export function sleepUntil(at: number): Effect.Effect<void> {
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

/** Each destination transfers to the endpoint scope before the caller waits on its outcome. */
export function fanOutRequests<R>(
  prepared: PreparedGather,
  acceptRequest: CollectivePorts["acceptMessage"],
  scope: Scope.Scope,
  refuse: (refusal: RequestRefusal) => Effect.Effect<void, never, R>,
) {
  const { operationId } = prepared;
  return Effect.forEach(
    prepared.requests,
    ({ to, message }): Effect.Effect<RequestSend, never, R> =>
      acceptRequest(
        {
          ...message,
          collective: { operationId, role: "request", destination: to },
        },
        Effect.succeed(Effect.void),
      ).pipe(
        Effect.flatMap(({ certified }) => certified),
        Effect.mapError((error) =>
          messageRefusal(Schema.decodeUnknownSync(AgentAddress)(to), error),
        ),
        Effect.tapError(refuse),
        Effect.either,
        Effect.forkIn(scope),
      ),
    { concurrency: 1 },
  );
}
