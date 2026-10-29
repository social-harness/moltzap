/**
 * @file Who a gather's request posts go to, how long its send waits for
 * them, the posts while they are sent, and how each one is settled when the
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
import type { EngineSentPost } from "../conversations/index.js";
import type {
  CollectiveFailure,
  CollectiveOperation,
  Members,
} from "./contracts.js";
import type { AdmittedPost, CollectivePorts, PostSender } from "./ports.js";
import type { PreparedGather } from "./state.js";
import { canonicalMessageAddress } from "../conversations/address.js";
import { SendError } from "../conversations/errors.js";
import {
  AgentAddress,
  agentNameOf,
  type MessageAddressInput,
} from "../records/values.js";

/**
 * A member whose request post was refused, and why.
 */
export type RequestRefusal = Readonly<{
  member: AgentAddress;
  reason: SendError["reason"];
  detail?: string;
}>;

/**
 * The refusal of a member whose post failed with `error`.
 * @param member The member the post was for.
 * @param error The post's send failure.
 * @returns The member with the failure's reason and any detail.
 */
export const postRefusal = (
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
  readonly members: Members;
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
 * How long a collecting operation's send waits for its request posts before
 * returning. A gather's request still uncertified then is left running: its
 * member answers or is reported as no-answer at the deadline. An all_gather's
 * bound group post returns delivery-pending when it is still uncertified;
 * that same post remains accepted work. The wait stays under the MCP
 * SDK's request timeout so a waiting host receives the result rather than a
 * transport timeout. It runs from the send's start, so a firewall's check of
 * the operation comes out of it. Only certification of a durably bound
 * all_gather post is timed; attachment and binding retain their own failure
 * boundaries.
 */
const REQUEST_SEND_WAIT = Duration.seconds(20);

/**
 * An operation's absolute deadline, and when its send stops waiting for
 * request posts.
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
 * A request post, failing as uncertified when the send's wait ends first.
 */
export function withinRequestWait(
  waitUntil: number,
  certified: AdmittedPost["certified"],
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
 * How long a send still waits for request posts: until its wait ends, never
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

/** A request post in flight, resolving to the member's refusal, if any. */
export type RequestSend = Fiber.RuntimeFiber<
  Either.Either<EngineSentPost, RequestRefusal>
>;

/** How many Registry lookups run at once; a group has at most 32 members. */
const MEMBER_LOOKUP_CONCURRENCY = 8;

/**
 * Failures that address resolution alone determines, so the send can refuse
 * them before any post.
 */
const ADDRESS_FAILURES: ReadonlySet<SendError["reason"]> = new Set([
  "invalid-address",
  "unknown-agent",
  "membership-invalid",
]);

/**
 * Whether a member's refusal is an address error rather than a delivery
 * failure.
 * @param refusal A member's lookup or post refusal.
 * @returns True for a malformed or unknown member or invalid membership.
 */
const isAddressRefusal = (refusal: RequestRefusal): boolean =>
  ADDRESS_FAILURES.has(refusal.reason);

/**
 * Resolve every member before any post through the engine's address
 * resolution. A malformed or unknown member, or invalid membership, refuses
 * the whole send naming each one; any other lookup failure is left to the
 * post, which reports it as a delivery failure.
 */
export function refuseAddressErrors(
  members: Members,
  lookup: CollectivePorts["lookupMember"],
): Effect.Effect<void, CollectiveFailure> {
  return lookupRefusals(members, lookup).pipe(
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

/**
 * Where a gather's request posts stand when the send stops waiting: each
 * certified post and each member refused. A send still pending keeps
 * running and is in neither.
 * @param sends Each member's request send.
 * @returns The posts and refusals, in member order.
 */
export const requestsSoFar = (
  sends: readonly RequestSend[],
): Effect.Effect<{
  readonly posts: EngineSentPost[];
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
      posts: states.flatMap((result) =>
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
export function fanOutRequests(
  prepared: PreparedGather,
  sendRequest: PostSender,
  scope: Scope.Scope,
  refuse: (refusal: RequestRefusal) => Effect.Effect<void>,
) {
  const { id, open } = prepared;
  return Effect.forEach(
    open.members,
    (member): Effect.Effect<RequestSend> =>
      sendRequest({
        to: member,
        content: prepared.content,
        collective: { operationId: id, role: "request", destination: member },
      }).pipe(
        Effect.mapError((error) => postRefusal(member, error)),
        Effect.tapError(refuse),
        Effect.either,
        Effect.forkIn(scope),
      ),
    { concurrency: 1 },
  );
}

/** Lookup failures retain the requested member order. */
function lookupRefusals(
  members: readonly AgentAddress[],
  lookup: (member: AgentAddress) => Effect.Effect<void, SendError>,
): Effect.Effect<RequestRefusal[]> {
  return Effect.forEach(
    members,
    (member) =>
      lookup(member).pipe(
        Effect.flip,
        Effect.map(
          (error): RequestRefusal => ({ member, reason: error.reason }),
        ),
        Effect.option,
      ),
    { concurrency: MEMBER_LOOKUP_CONCURRENCY },
  ).pipe(
    Effect.map((lookups) => lookups.flatMap((found) => Option.toArray(found))),
  );
}
