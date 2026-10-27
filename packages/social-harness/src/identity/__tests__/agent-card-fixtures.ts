/** @file Immutable card fixtures signed through the Identity capability. */

import { Effect } from "effect";
import type { AgentCardVerificationError } from "../cards.js";
import {
  AgentCard,
  AgentSigningAuthority,
  type VerifiedAgentCard,
} from "../../index.js";
import { type AgentCardClaims, agentCardSigning } from "../card-signing.js";
import { wireVersions } from "../wire-version.js";

/** Whole-second UTC issuance evidence carried by an AgentCard. */
// eslint-disable-next-line @typescript-eslint/naming-convention -- Effect Schemas share the package-owned domain name they decode.
export const AgentCardIssuedAt = agentCardSigning.issuedAt;
/** Validated nominal value decoded by AgentCardIssuedAt. */
// eslint-disable-next-line @typescript-eslint/no-redeclare -- The same-named Schema and type form one package boundary model.
export type AgentCardIssuedAt = typeof AgentCardIssuedAt.Type;

interface CardFixtureInput
  extends Omit<AgentCardClaims, "kind" | "sharnessVersion"> {
  readonly registrySigningAuthority: AgentSigningAuthority;
}

/**
 * Signs and verifies immutable card claims for Identity fixtures.
 *
 * @param input Complete identity fields and Registry signing authority.
 * @returns A Registry-verified immutable AgentCard.
 */
export const makeVerifiedCard = (
  input: CardFixtureInput,
): Effect.Effect<VerifiedAgentCard, AgentCardVerificationError> =>
  Effect.gen(function* () {
    const { registrySigningAuthority, ...claims } = input;
    const card = yield* agentCardSigning.sign(
      {
        kind: "agentCard",
        sharnessVersion: yield* wireVersions.emitted,
        ...claims,
      },
      registrySigningAuthority,
    );
    return yield* AgentCard.verify({
      agentCard: card,
      registrySignerPublicKey: AgentSigningAuthority.publicKey(
        registrySigningAuthority,
      ),
    });
  }).pipe(Effect.withSpan("makeVerifiedCard"));
