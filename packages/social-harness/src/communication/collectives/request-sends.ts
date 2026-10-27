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
} from "effect";
import type { EngineSentPost } from "../conversations/index.js";
import type { CollectiveOperation } from "./forms.js";
import type { Members } from "./shared-answers.js";
import { canonicalMessageAddress } from "../conversations/address.js";
import { SendError } from "../conversations/errors.js";
import { AgentAddress, type MessageAddressInput } from "../records/values.js";

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
  const selfName = self.slice("agent:".length);
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
 * one group post must be certified by then, or the all_gather cannot start:
 * a cold group's GENESIS needs every member. The bound stays under the MCP
 * SDK's request timeout so a waiting host receives the result rather than a
 * transport timeout. It runs from the send's start, so a firewall's check of
 * the operation comes out of it.
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
export const isAddressRefusal = (refusal: RequestRefusal): boolean =>
  ADDRESS_FAILURES.has(refusal.reason);

/**
 * Look up every member and name each whose lookup fails, in member order.
 * @param members The members to resolve.
 * @param lookup The engine's address resolution for one member.
 * @returns Each failing member with its reason; empty when all resolve.
 */
export const lookupRefusals = (
  members: readonly AgentAddress[],
  lookup: (member: AgentAddress) => Effect.Effect<void, SendError>,
): Effect.Effect<RequestRefusal[]> =>
  Effect.forEach(
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
