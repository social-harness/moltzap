/** @file Authenticated HTTP card retention and eviction through Registry resolution. */

import { Array, Effect, Encoding, Ref, Schema } from "effect";
import { expect, it } from "vitest";
import type { RegistryClientService } from "../../registry/contract.js";
import {
  AgentCardIssuedAt,
  makeVerifiedCard,
} from "../../__tests__/agent-card-fixtures.js";
import { AgentId, AgentName } from "../../identifiers.js";
import {
  type IdentityFixture,
  makeIdentityFixture,
} from "./authenticated-http-fixtures.js";
import {
  authenticatedHttpLayerWithRegistry,
  prepareRequest,
  registryWithLookup,
  verifyAgentRequest,
} from "./authenticated-http-requests.js";

const makeDistinctFixture = (index: number) =>
  Effect.gen(function* () {
    const fixture = yield* makeIdentityFixture;
    const agentCard = yield* makeVerifiedCard({
      agentId: yield* Schema.decodeUnknown(AgentId)(
        `agt_${Encoding.encodeBase64Url(new Uint8Array(16).fill(index))}`,
      ),
      principalId: fixture.agentCard.principalId,
      agentName: yield* Schema.decodeUnknown(AgentName)(
        `cache-signer-${index}`,
      ),
      publicKey: fixture.agentCard.publicKey,
      issuedAt: yield* Schema.decodeUnknown(AgentCardIssuedAt)(
        fixture.agentCard.issuedAt,
      ),
      registrySigningAuthority: fixture.registryAuthority,
    });
    return { ...fixture, agentCard };
  });

const lookupCards =
  (
    fixtures: readonly IdentityFixture[],
    lookups: Ref.Ref<readonly AgentId[]>,
  ): RegistryClientService["lookup"] =>
  (request) => {
    if (!("agentId" in request)) {
      return Effect.dieMessage("LRU lookup requires an AgentId");
    }
    const { agentId } = request;
    return Ref.update(lookups, (ids) => [...ids, agentId]).pipe(
      Effect.map(() => {
        const fixture = fixtures.find(
          (candidate) => candidate.agentCard.agentId === agentId,
        );
        return fixture === undefined
          ? ({ kind: "not_found" } as const)
          : ({ kind: "found", agentCard: fixture.agentCard } as const);
      }),
    );
  };

const makeCacheFixtures = Effect.gen(function* () {
  const cacheCapacity = 8;
  const fixtures = yield* Effect.all(
    Array.makeBy(cacheCapacity + 1, (index) => makeDistinctFixture(index)),
  );
  const first = fixtures[0];
  const second = fixtures[1];
  const newest = fixtures[cacheCapacity];
  if (first === undefined || second === undefined || newest === undefined) {
    return yield* Effect.dieMessage("LRU fixtures are missing");
  }
  return { cacheCapacity, fixtures, first, second, newest };
});

it("retains a recently used card and looks up the least recently used card after eviction", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { cacheCapacity, fixtures, first, second, newest } =
        yield* makeCacheFixtures;
      const lookups = yield* Ref.make<readonly AgentId[]>([]);
      const verifyFresh = (fixture: IdentityFixture) =>
        prepareRequest({ fixture }).pipe(Effect.flatMap(verifyAgentRequest));
      yield* Effect.gen(function* () {
        yield* Effect.forEach(fixtures.slice(0, cacheCapacity), verifyFresh, {
          concurrency: 1,
        });
        yield* verifyFresh(first);
        yield* verifyFresh(newest);
        yield* Ref.set(lookups, []);
        expect((yield* verifyFresh(first)).agentCard).toBe(first.agentCard);
        expect(yield* Ref.get(lookups)).toStrictEqual([]);
        expect((yield* verifyFresh(second)).agentCard).toBe(second.agentCard);
        expect(yield* Ref.get(lookups)).toStrictEqual([
          second.agentCard.agentId,
        ]);
      }).pipe(
        Effect.provide(
          authenticatedHttpLayerWithRegistry(
            registryWithLookup(lookupCards(fixtures, lookups)),
            { agentCardCacheCapacity: cacheCapacity },
          ),
        ),
      );
    }),
  ));
