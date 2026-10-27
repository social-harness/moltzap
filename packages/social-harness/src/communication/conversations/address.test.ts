/** @file Address resolution against verified immutable Registry cards. */

import { live as it } from "@effect/vitest";
import { Effect, Exit, Schema } from "effect";
import { generateKeyPairSync } from "node:crypto";
import { describe, expect } from "vitest";
import type { VerifiedAgentCard } from "../../identity/cards.js";
import type { RegistryLookupResult } from "../../identity/registry/contract.js";
import {
  issueTestCard,
  makeTestAuthority,
} from "../../__tests__/agent-card-fixtures.js";
import { maximumMembers, MessageAddressInput } from "../records/values.js";
import {
  type AddressRegistryPort,
  renderGroupAddress,
  type ResolvedMessageAddress,
  resolveMessageAddress,
} from "./address.js";

interface AddressFixture {
  readonly cards: readonly [
    VerifiedAgentCard,
    VerifiedAgentCard,
    VerifiedAgentCard,
  ];
  readonly registry: AddressRegistryPort;
}

const makeFixture = Effect.gen(function* () {
  const registryKeys = generateKeyPairSync("ed25519");
  const authority = yield* makeTestAuthority();
  const local = yield* issueTestCard({
    byte: 1,
    name: "agent-1",
    authority,
    registryKeys,
  });
  const second = yield* issueTestCard({
    byte: 10,
    name: "agent-10",
    authority,
    registryKeys,
  });
  const third = yield* issueTestCard({
    byte: 2,
    name: "agent-2",
    authority,
    registryKeys,
  });
  const cards = [local, second, third] as const;
  const lookup = (
    request: Parameters<AddressRegistryPort["lookup"]>[0],
  ): RegistryLookupResult => {
    const found = cards.find((card) =>
      "agentName" in request
        ? card.agentName === request.agentName
        : card.agentId === request.agentId,
    );
    return found === undefined
      ? { kind: "not_found" }
      : { kind: "found", agentCard: found };
  };
  const fixture: AddressFixture = {
    cards,
    registry: {
      lookup: (request) => Effect.succeed(lookup(request)),
    },
  };
  return fixture;
}).pipe(Effect.orDie);

const decodeInput = (value: string) =>
  Schema.decodeUnknownSync(MessageAddressInput)(value);

const memberNames = (resolved: ResolvedMessageAddress) =>
  resolved.memberCards.map((card) => card.agentName);

const thirtyTwoRemoteNames = Array.from(
  Array(32).keys(),
  (index) => `remote-${String(index).padStart(2, "0")}`,
).join(",");

// @agent-code-guard/regression-only: Resolution pins canonical runtime and private membership projections.
describe("resolved address state", () => {
  it("resolves a direct peer into deterministic private membership", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const inputAddress = "agent:agent-2";
      const expectedKind = "direct";
      const expectedNames = ["agent-1", "agent-2"];
      const resolved = yield* resolveMessageAddress({
        localAgentCard: fixture.cards[0],
        registry: fixture.registry,
        to: decodeInput(inputAddress),
      });

      expect(resolved.kind).toBe(expectedKind);
      expect(resolved.address).toBe(inputAddress);
      expect(memberNames(resolved)).toEqual(expectedNames);
    }));

  it("inserts self and renders complete groups in unsigned ASCII order", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const inputAddress = "group:agent-2,agent-10";
      const expectedKind = "group";
      const expectedAddress = "group:agent-1,agent-10,agent-2";
      const expectedNames = ["agent-1", "agent-2", "agent-10"];
      const resolved = yield* resolveMessageAddress({
        localAgentCard: fixture.cards[0],
        registry: fixture.registry,
        to: decodeInput(inputAddress),
      });

      expect(resolved.kind).toBe(expectedKind);
      expect(resolved.address).toBe(expectedAddress);
      expect(memberNames(resolved)).toEqual(expectedNames);
    }));
});

const membershipInvalid = "membership-invalid";
const unknownAgent = "unknown-agent";

// @agent-code-guard/regression-only: Resolution pins closed membership and lookup failures.
describe("invalid address membership", () => {
  it("refuses a direct address to self", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;

      const error = yield* resolveMessageAddress({
        localAgentCard: fixture.cards[0],
        registry: fixture.registry,
        to: decodeInput("agent:agent-1"),
      }).pipe(Effect.flip);

      expect(error.reason).toBe(membershipInvalid);
      expect(error.detail).toBeDefined();
    }));

  it("refuses a group naming an agent twice", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;

      const error = yield* resolveMessageAddress({
        localAgentCard: fixture.cards[0],
        registry: fixture.registry,
        to: decodeInput("group:agent-10,agent-10"),
      }).pipe(Effect.flip);

      expect(error.reason).toBe(membershipInvalid);
      expect(error.detail).toBeDefined();
    }));

  it("refuses an unknown agent and names it in the message", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const address = "agent:unknown-agent";

      const error = yield* resolveMessageAddress({
        localAgentCard: fixture.cards[0],
        registry: fixture.registry,
        to: decodeInput(address),
      }).pipe(Effect.flip);

      expect(error.reason).toBe(unknownAgent);
      expect(error.message).toContain(address);
    }));
});

// @agent-code-guard/regression-only: Resolution pins the direct address a one-other-agent group names.
describe("group naming one other agent", () => {
  it("resolves to that agent's direct conversation", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const direct = yield* resolveMessageAddress({
        localAgentCard: fixture.cards[0],
        registry: fixture.registry,
        to: decodeInput("agent:agent-2"),
      });

      const resolved = yield* resolveMessageAddress({
        localAgentCard: fixture.cards[0],
        registry: fixture.registry,
        to: decodeInput("group:agent-2"),
      });

      expect(resolved).toEqual(direct);
    }));

  it("resolves to that agent's direct conversation when self is listed too", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const direct = yield* resolveMessageAddress({
        localAgentCard: fixture.cards[0],
        registry: fixture.registry,
        to: decodeInput("agent:agent-2"),
      });

      const resolved = yield* resolveMessageAddress({
        localAgentCard: fixture.cards[0],
        registry: fixture.registry,
        to: decodeInput("group:agent-1,agent-2"),
      });

      expect(resolved).toEqual(direct);
    }));
});

// @agent-code-guard/regression-only: Resolution pins the accepted group-size boundary.
describe("group size", () => {
  it("refuses a group naming only self", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;

      const error = yield* resolveMessageAddress({
        localAgentCard: fixture.cards[0],
        registry: fixture.registry,
        to: decodeInput("group:agent-1"),
      }).pipe(Effect.flip);

      expect(error.reason).toBe(membershipInvalid);
    }));

  it("refuses a group over the member limit and states the limit", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;

      const error = yield* resolveMessageAddress({
        localAgentCard: fixture.cards[0],
        registry: fixture.registry,
        to: decodeInput(`group:${thirtyTwoRemoteNames}`),
      }).pipe(Effect.flip);

      expect(error.reason).toBe(membershipInvalid);
      expect(error.message).toContain(String(maximumMembers));
    }));
});

/**
 * A group address lists its members' names in unsigned ASCII order, and the
 * names it returns follow the address. Fails when the names keep their input
 * order while the address sorts them.
 */
const rendersGroupNamesInAddressOrder = () =>
  Effect.gen(function* () {
    const rendered = yield* Effect.exit(
      renderGroupAddress(["agent-2", "agent-10", "agent-1"]),
    );

    expect(rendered).toEqual(
      Exit.succeed({
        address: "group:agent-1,agent-10,agent-2",
        names: ["agent-1", "agent-10", "agent-2"],
      }),
    );
  });

describe("group address rendering", () => {
  it(
    "returns the names in the order the address lists them",
    rendersGroupNamesInAddressOrder,
  );
});
