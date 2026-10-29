/** @file Private address resolution from runtime names to immutable cards. */

import { type Context, Effect, type ParseResult, Schema } from "effect";
import type { VerifiedAgentCard } from "../../identity/cards.js";
import type { Registry } from "../../identity/registry/index.js";
import { compareAscii } from "../../encoding/identifier.js";
import { AgentName } from "../../identity/identifiers.js";
import {
  AGENT_ADDRESS_PREFIX,
  AgentAddress,
  compareAgentIds,
  GROUP_ADDRESS_PREFIX,
  GroupAddress,
  maximumMembers,
  type MessageAddressInput,
} from "../records/values.js";
import { SendError } from "./errors.js";

/** Minimal Registry capability required by address resolution. */
export type AddressRegistryPort = Pick<
  Context.Tag.Service<typeof Registry>,
  "lookup"
>;

/** Resolved deterministic membership for a direct destination. */
interface ResolvedDirectAddress {
  readonly kind: "direct";
  readonly address: AgentAddress;
  readonly memberCards: readonly [VerifiedAgentCard, VerifiedAgentCard];
}

/** Resolved deterministic membership for a fixed group destination. */
interface ResolvedGroupAddress {
  readonly kind: "group";
  readonly address: GroupAddress;
  readonly memberCards: readonly [
    VerifiedAgentCard,
    VerifiedAgentCard,
    VerifiedAgentCard,
    ...VerifiedAgentCard[],
  ];
}

/** Address resolution retains both the runtime spelling and private cards. */
export type ResolvedMessageAddress =
  | ResolvedDirectAddress
  | ResolvedGroupAddress;

interface ResolveMessageAddressInput {
  readonly localAgentCard: VerifiedAgentCard;
  readonly registry: AddressRegistryPort;
  readonly to: MessageAddressInput;
}

/**
 * Resolve one explicit runtime destination to canonical immutable membership.
 * @param input Local verified identity, Registry lookup, and validated input.
 * @returns The canonical runtime address and AgentId-ordered verified cards.
 */
export function resolveMessageAddress(
  input: ResolveMessageAddressInput,
): Effect.Effect<ResolvedMessageAddress, SendError> {
  return canonicalMessageAddress(input.to, input.localAgentCard.agentName).pipe(
    Effect.flatMap(
      (canonical): Effect.Effect<ResolvedMessageAddress, SendError> =>
        canonical.kind === "direct"
          ? resolveDirect(input, canonical)
          : resolveGroup(input, canonical),
    ),
  );
}

/** A destination in canonical form, before any Registry lookup. */
export type CanonicalMessageAddress =
  | {
      readonly kind: "direct";
      readonly address: AgentAddress;
      readonly remoteName: AgentName;
    }
  | {
      readonly kind: "group";
      readonly address: GroupAddress;
      readonly memberNames: readonly AgentName[];
    };

/**
 * Put one destination in canonical form, the rule every send shares. An
 * `agent:` address names one other agent. A `group:` address names each agent
 * once and the local agent is added when absent. Naming one other agent makes
 * it that agent's direct address, since the two-member set is the direct
 * conversation; otherwise the complete group has 3 to `maximumMembers` members
 * in unsigned ASCII name order.
 * @param to The validated destination input.
 * @param localAgentName The local agent's Registry name.
 * @returns The canonical address with its names, local agent included for a
 *   group, or `invalid-address` or `membership-invalid`.
 */
export function canonicalMessageAddress(
  to: MessageAddressInput,
  localAgentName: string,
): Effect.Effect<CanonicalMessageAddress, SendError> {
  return to.startsWith(AGENT_ADDRESS_PREFIX)
    ? canonicalDirect(to, localAgentName)
    : canonicalGroup(to, localAgentName);
}

/**
 * Render a fixed membership's group address: every member's Registry name,
 * the local agent's included, in unsigned ASCII order. This is the one place
 * that orders a group's names, so the names it returns list the members in
 * the address's order.
 * @param names The members' names, in any order.
 * @returns The canonical group address and the names in its order, or the
 *   parse error when the names cannot form one.
 */
export function renderGroupAddress<Name extends string>(
  names: readonly Name[],
): Effect.Effect<
  { readonly address: GroupAddress; readonly names: readonly Name[] },
  ParseResult.ParseError
> {
  const ordered = [...names].sort(compareAscii);
  return Schema.decodeUnknown(GroupAddress)(
    `${GROUP_ADDRESS_PREFIX}${ordered.join(",")}`,
  ).pipe(Effect.map((address) => ({ address, names: ordered })));
}

function invalidAddress(): SendError {
  return new SendError({ reason: "invalid-address" });
}

function invalidMembership(detail: string): SendError {
  return new SendError({ reason: "membership-invalid", detail });
}

function unknownAgent(agentName: AgentName): SendError {
  return new SendError({
    reason: "unknown-agent",
    detail: `${AGENT_ADDRESS_PREFIX}${agentName} is not a known agent`,
  });
}

function mapRegistryFailure(error: { readonly _tag: string }): SendError {
  return new SendError({
    reason:
      error._tag === "VersionMismatchError"
        ? "version-mismatch"
        : "network-unavailable",
  });
}

function orderMemberCards(
  cards: readonly VerifiedAgentCard[],
): readonly VerifiedAgentCard[] {
  const ordered = cards.slice();
  ordered.sort((left, right) => compareAgentIds(left.agentId, right.agentId));
  return ordered;
}

function decodeAgentName(value: string): Effect.Effect<AgentName, SendError> {
  return Schema.decodeUnknown(AgentName)(value).pipe(
    Effect.mapError(invalidAddress),
  );
}

function lookupCard(
  registry: AddressRegistryPort,
  agentName: AgentName,
): Effect.Effect<VerifiedAgentCard, SendError> {
  return registry.lookup({ agentName }).pipe(
    Effect.mapError(mapRegistryFailure),
    Effect.flatMap((result) => {
      if (result.kind === "not_found") {
        return Effect.fail(unknownAgent(agentName));
      }
      return result.agentCard.agentName === agentName
        ? Effect.succeed(result.agentCard)
        : Effect.fail(unknownAgent(agentName));
    }),
  );
}

function canonicalDirect(
  to: MessageAddressInput,
  localAgentName: string,
): Effect.Effect<CanonicalMessageAddress, SendError> {
  return Effect.gen(function* () {
    const remoteName = yield* decodeAgentName(
      to.slice(AGENT_ADDRESS_PREFIX.length),
    );
    if (remoteName === localAgentName) {
      return yield* invalidMembership("the address names only you");
    }
    const address = yield* Schema.decodeUnknown(AgentAddress)(to).pipe(
      Effect.mapError(invalidAddress),
    );
    return { kind: "direct", address, remoteName };
  });
}

function canonicalGroup(
  to: MessageAddressInput,
  localAgentName: string,
): Effect.Effect<CanonicalMessageAddress, SendError> {
  return Effect.gen(function* () {
    const explicitNames = yield* Effect.forEach(
      to.slice(GROUP_ADDRESS_PREFIX.length).split(","),
      decodeAgentName,
      { concurrency: 1 },
    );
    if (new Set(explicitNames).size !== explicitNames.length) {
      return yield* invalidMembership(
        "the address names an agent more than once",
      );
    }
    const localName = yield* decodeAgentName(localAgentName);
    const memberNames = explicitNames.includes(localName)
      ? explicitNames.slice()
      : [...explicitNames, localName];
    const others = memberNames.filter((name) => name !== localName);
    const [onlyOther] = others;
    if (onlyOther === undefined) {
      return yield* invalidMembership("the address names only you");
    }
    if (others.length === 1) {
      const address = yield* Schema.decodeUnknown(AgentAddress)(
        `${AGENT_ADDRESS_PREFIX}${onlyOther}`,
      ).pipe(Effect.mapError(invalidAddress));
      return { kind: "direct", address, remoteName: onlyOther };
    }
    if (memberNames.length > maximumMembers) {
      return yield* invalidMembership(
        `a group has at most ${String(maximumMembers)} members`,
      );
    }
    const group = yield* renderGroupAddress(memberNames).pipe(
      Effect.mapError(invalidAddress),
    );
    return { kind: "group", address: group.address, memberNames: group.names };
  });
}

function resolveDirect(
  input: ResolveMessageAddressInput,
  canonical: Extract<CanonicalMessageAddress, { readonly kind: "direct" }>,
): Effect.Effect<ResolvedDirectAddress, SendError> {
  return Effect.gen(function* () {
    const remoteCard = yield* lookupCard(input.registry, canonical.remoteName);
    const ordered = orderMemberCards([input.localAgentCard, remoteCard]);
    const first = ordered[0];
    const second = ordered[1];
    if (first === undefined || second === undefined) {
      return yield* Effect.dieMessage("direct membership lost a member");
    }
    return {
      kind: "direct",
      address: canonical.address,
      memberCards: [first, second],
    };
  });
}

function resolveGroup(
  input: ResolveMessageAddressInput,
  canonical: Extract<CanonicalMessageAddress, { readonly kind: "group" }>,
): Effect.Effect<ResolvedGroupAddress, SendError> {
  return Effect.gen(function* () {
    const resolved = yield* Effect.forEach(
      canonical.memberNames,
      (agentName) =>
        agentName === input.localAgentCard.agentName
          ? Effect.succeed(input.localAgentCard)
          : lookupCard(input.registry, agentName),
      { concurrency: 1 },
    );
    const ordered = orderMemberCards(resolved);
    const first = ordered[0];
    const second = ordered[1];
    const third = ordered[2];
    if (first === undefined || second === undefined || third === undefined) {
      return yield* Effect.dieMessage("group membership lost a member");
    }
    return {
      kind: "group",
      address: canonical.address,
      memberCards: [first, second, third, ...ordered.slice(3)],
    };
  });
}
