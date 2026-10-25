/** @file Registry-owned immutable AgentCard issuance. */

import {
  AgentCard,
  type AgentId as AgentIdValue,
  type AgentName as AgentNameValue,
  AgentSigningAuthority,
  type Ed25519PublicKey as Ed25519PublicKeyValue,
  type PrincipalId as PrincipalIdValue,
  type VerifiedAgentCard,
} from "@moltzap/client";
import {
  agentCardSigning,
  type AgentCardVerificationError,
  wireVersions,
} from "@moltzap/client/internal";
import { Effect } from "effect";

/** Whole-second UTC issuance evidence carried by an AgentCard. */
// eslint-disable-next-line @typescript-eslint/naming-convention -- Effect Schemas share the package-owned domain name they decode.
export const AgentCardIssuedAt = agentCardSigning.issuedAt;
/** Validated nominal value decoded by AgentCardIssuedAt. */
// eslint-disable-next-line @typescript-eslint/no-redeclare -- The same-named Schema and type form one package boundary model.
export type AgentCardIssuedAt = typeof AgentCardIssuedAt.Type;

interface IssueAgentCardInput {
  readonly agentId: AgentIdValue;
  readonly principalId: PrincipalIdValue;
  readonly agentName: AgentNameValue;
  readonly publicKey: Ed25519PublicKeyValue;
  readonly issuedAt: AgentCardIssuedAt;
  readonly registrySigningAuthority: AgentSigningAuthority;
}

/**
 * Issues one exact AgentCard for Registry storage.
 *
 * @param input Complete identity fields and Registry signing authority.
 * @returns A Registry-verified immutable AgentCard.
 */
export const issueAgentCard = (
  input: IssueAgentCardInput,
): Effect.Effect<VerifiedAgentCard, AgentCardVerificationError> =>
  Effect.gen(function* () {
    const card = yield* agentCardSigning.sign(
      {
        kind: "agentCard",
        sharnessVersion: yield* wireVersions.emitted,
        agentId: input.agentId,
        principalId: input.principalId,
        agentName: input.agentName,
        publicKey: input.publicKey,
        issuedAt: input.issuedAt,
      },
      input.registrySigningAuthority,
    );
    return yield* AgentCard.verify({
      agentCard: card,
      registrySignerPublicKey: AgentSigningAuthority.publicKey(
        input.registrySigningAuthority,
      ),
    });
  }).pipe(Effect.withSpan("issueAgentCard"));
