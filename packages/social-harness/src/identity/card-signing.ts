/** @file Registry-only immutable AgentCard issuance. */
import { Effect, Schema } from "effect";
import { GeneralSign } from "jose";
import type { AgentId, AgentName, PrincipalId } from "./identifiers.js";
import { encodeCanonicalJson } from "../encoding/canonical-json.js";
import {
  AgentCard,
  agentCardIssuedAtSchema,
  AgentCardVerificationError,
} from "./cards.js";
import {
  AgentSigningAuthority,
  agentSigningPrivateKey,
  type Ed25519PublicKey,
  ed25519PublicKeyThumbprintUri,
} from "./keys.js";
import { AGENT_CARD_TYPE } from "./wire-version.js";

/** Complete immutable claims accepted by the card-signing capability. */
export interface AgentCardClaims {
  readonly kind: "agentCard";
  readonly sharnessVersion: string;
  readonly agentId: AgentId;
  readonly principalId: PrincipalId;
  readonly agentName: AgentName;
  readonly publicKey: Ed25519PublicKey;
  readonly issuedAt: typeof agentCardIssuedAtSchema.Type;
}

interface CardSigning {
  readonly issuedAt: typeof agentCardIssuedAtSchema;
  readonly publicKeyId: typeof ed25519PublicKeyThumbprintUri;
  readonly sign: (
    payload: AgentCardClaims,
    authority: AgentSigningAuthority,
  ) => Effect.Effect<AgentCard, AgentCardVerificationError>;
}

/** Card signing retains private key access and wire-profile details inside Identity. */
export const agentCardSigning: CardSigning = Object.freeze({
  issuedAt: agentCardIssuedAtSchema,
  publicKeyId: ed25519PublicKeyThumbprintUri,
  sign: signCardPayload,
});

function signCardPayload(
  payload: AgentCardClaims,
  authority: AgentSigningAuthority,
): Effect.Effect<AgentCard, AgentCardVerificationError> {
  return Effect.gen(function* () {
    const failure = () => new AgentCardVerificationError();
    const bytes = yield* encodeCanonicalJson(payload).pipe(
      Effect.mapError(failure),
    );
    const kid = yield* ed25519PublicKeyThumbprintUri(
      AgentSigningAuthority.publicKey(authority),
    ).pipe(Effect.mapError(failure));
    const representation = yield* Effect.tryPromise({
      try: () =>
        new GeneralSign(bytes)
          .addSignature(agentSigningPrivateKey(authority))
          .setProtectedHeader({
            alg: "Ed25519",
            kid,
            typ: AGENT_CARD_TYPE,
          })
          .sign(),
      catch: failure,
    });
    return yield* Schema.decodeUnknown(AgentCard)(representation).pipe(
      Effect.mapError(failure),
    );
  }).pipe(Effect.withSpan("agentCardSigning"));
}
