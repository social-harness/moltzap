/** @file The local identity survives process restarts in one immutable binding. */

import { SqlClient } from "@effect/sql";
import { Data, Effect, Schema } from "effect";
import type { AgentName } from "./identifiers.js";
import type { Ed25519PublicKey } from "./keys.js";
import {
  decodeCanonical,
  encodeCanonical,
  sameBytes,
} from "../encoding/canonical-json.js";
import { AgentCard, type VerifiedAgentCard } from "./cards.js";

/** Local identity bytes must remain readable and agree with the configured keys. */
export class IdentityError extends Data.TaggedError("IdentityError")<{
  readonly agentName?: AgentName;
  readonly reason:
    | "persistence-failed"
    | "incompatible-daemon"
    | "dependency-unavailable"
    | "unknown-agent";
}> {}

const persistenceFailure = () =>
  new IdentityError({ reason: "persistence-failed" });
const representationFailure = () =>
  new IdentityError({ reason: "incompatible-daemon" });

const identityRow = Schema.Struct({
  agent_id: Schema.NonEmptyString,
  canonical_agent_card: Schema.Uint8ArrayFromSelf.pipe(
    Schema.filter((bytes) => bytes.length > 0),
  ),
});

/** Canonical bytes bound to the one local identity. */
export interface IdentityBinding {
  readonly agentId: string;
  readonly canonicalAgentCard: Uint8Array;
}

/** Durable protocol recovery can inspect the binding without assigning identity authority. */
export const readIdentityBinding = () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const row = (yield* sql
      .unsafe<Readonly<Record<string, unknown>>>(
        "SELECT agent_id, canonical_agent_card FROM identity_binding WHERE singleton = 1",
      )
      .pipe(Effect.mapError(persistenceFailure)))[0];
    if (row === undefined) {
      return undefined;
    }
    const decoded = yield* Schema.decodeUnknown(identityRow)(row).pipe(
      Effect.mapError(representationFailure),
    );
    return {
      agentId: decoded.agent_id,
      canonicalAgentCard: Uint8Array.from(decoded.canonical_agent_card),
    };
  }).pipe(Effect.withSpan("readIdentityBinding"));

/** An atomic retry accepts identical bytes and refuses replacement of the saved identity. */
export function bindIdentity(binding: IdentityBinding) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* Schema.decodeUnknown(identityRow)({
      agent_id: binding.agentId,
      canonical_agent_card: binding.canonicalAgentCard,
    }).pipe(Effect.mapError(representationFailure));
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const existing = yield* readIdentityBinding();
          if (existing !== undefined) {
            if (
              existing.agentId !== binding.agentId ||
              !sameBytes(
                existing.canonicalAgentCard,
                binding.canonicalAgentCard,
              )
            ) {
              return yield* representationFailure();
            }
            return "existing" as const;
          }
          yield* sql
            .unsafe(
              "INSERT INTO identity_binding (singleton, agent_id, canonical_agent_card) VALUES (1, ?, ?)",
              [binding.agentId, Uint8Array.from(binding.canonicalAgentCard)],
            )
            .pipe(Effect.mapError(persistenceFailure));
          return "inserted" as const;
        }),
      )
      .pipe(Effect.catchTag("SqlError", () => persistenceFailure()));
  }).pipe(Effect.withSpan("bindIdentity"));
}

/** Reopening a store verifies both Registry authority and ownership of its agent key. */
export function readLocalIdentity(input: {
  readonly registrySignerPublicKey: Ed25519PublicKey;
  readonly agentPublicKey: Ed25519PublicKey;
}): Effect.Effect<
  VerifiedAgentCard | undefined,
  IdentityError,
  SqlClient.SqlClient
> {
  return Effect.gen(function* () {
    const row = yield* readIdentityBinding();
    if (row === undefined) {
      return undefined;
    }
    const encoded = yield* decodeCanonical(
      AgentCard,
      row.canonicalAgentCard,
    ).pipe(Effect.mapError(representationFailure));
    const card = yield* AgentCard.verify({
      agentCard: encoded,
      registrySignerPublicKey: input.registrySignerPublicKey,
    }).pipe(Effect.mapError(representationFailure));
    if (
      row.agentId !== card.agentId ||
      card.publicKey.x !== input.agentPublicKey.x
    ) {
      return yield* representationFailure();
    }
    return card;
  }).pipe(Effect.withSpan("readLocalIdentity"));
}

/** Registration retries may repeat the same binding but cannot replace it. */
export function saveLocalIdentity(
  card: VerifiedAgentCard,
): Effect.Effect<void, IdentityError, SqlClient.SqlClient> {
  return encodeCanonical(AgentCard, card).pipe(
    Effect.mapError(representationFailure),
    Effect.flatMap((canonicalAgentCard) =>
      bindIdentity({ agentId: card.agentId, canonicalAgentCard }),
    ),
    Effect.asVoid,
  );
}
