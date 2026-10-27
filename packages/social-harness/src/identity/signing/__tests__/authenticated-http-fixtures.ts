/** @file Real Registry-signed identities for HTTP compatibility tests. */
import { Effect, Encoding, Redacted, Schema } from "effect";
import { GeneralSign } from "jose";
import { generateKeyPairSync } from "node:crypto";
import {
  AgentCardIssuedAt,
  makeVerifiedCard,
} from "../../__tests__/agent-card-fixtures.js";
import {
  decodeCanonicalJson,
  encodeCanonicalJson,
} from "../../../encoding/canonical-json.js";
import { AgentId, AgentName, PrincipalId } from "../../agents.js";
import { AgentCard, type VerifiedAgentCard } from "../../cards.js";
import {
  AgentSigningAuthority,
  type AgentSigningAuthority as AgentSigningAuthorityValue,
  agentSigningPrivateKey,
  ed25519PublicKeyThumbprintUri,
} from "../../keys.js";
import { AuthenticationFailedError } from "../http-errors.js";

/** Independent Registry and agent signing keys bound by the verified card. */
export interface IdentityFixture {
  readonly registryAuthority: AgentSigningAuthorityValue;
  readonly agentCard: VerifiedAgentCard;
  readonly signingAuthority: AgentSigningAuthorityValue;
}

const identifier = (prefix: string, byte: number): string =>
  `${prefix}${Encoding.encodeBase64Url(new Uint8Array(16).fill(byte))}`;
const makeAgentId = (byte: number) =>
  Schema.decodeUnknownSync(AgentId)(identifier("agt_", byte));

const makeSigningAuthority = () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  return AgentSigningAuthority.fromPkcs8(
    Redacted.make(privateKey.export({ format: "pem", type: "pkcs8" })),
  );
};

/** Current-version card and both signing authorities for authentic requests. */
export const makeIdentityFixture = Effect.gen(function* () {
  const registryAuthority = yield* makeSigningAuthority();
  const signingAuthority = yield* makeSigningAuthority();
  const agentCard = yield* makeVerifiedCard({
    agentId: makeAgentId(1),
    principalId: Schema.decodeUnknownSync(PrincipalId)(identifier("prn_", 2)),
    agentName: Schema.decodeUnknownSync(AgentName)("http-signer"),
    publicKey: AgentSigningAuthority.publicKey(signingAuthority),
    issuedAt: Schema.decodeUnknownSync(AgentCardIssuedAt)(
      "2026-07-30T12:00:00Z",
    ),
    registrySigningAuthority: registryAuthority,
  });
  return {
    agentCard,
    signingAuthority,
    registryAuthority,
  } satisfies IdentityFixture;
}).pipe(Effect.withSpan("makeIdentityFixture"));

/** The Registry attests a history-only card without changing the agent key. */
export const retainedIdentityFixture = Effect.gen(function* () {
  const fixture = yield* makeIdentityFixture;
  const encoded = yield* Schema.encode(AgentCard)(fixture.agentCard);
  const representation = yield* Schema.decodeUnknown(
    Schema.Struct({ payload: Schema.String }),
  )(encoded);
  const bytes = yield* Encoding.decodeBase64Url(representation.payload);
  const fields = yield* decodeCanonicalJson(
    Schema.Record({ key: Schema.String, value: Schema.Unknown }),
    bytes,
  );
  const payload = yield* encodeCanonicalJson({
    ...fields,
    sharnessVersion: "2099.101.0",
  });
  const registrySignerPublicKey = AgentSigningAuthority.publicKey(
    fixture.registryAuthority,
  );
  const kid = yield* ed25519PublicKeyThumbprintUri(registrySignerPublicKey);
  const signed = yield* Effect.tryPromise({
    try: () =>
      new GeneralSign(payload)
        .addSignature(agentSigningPrivateKey(fixture.registryAuthority))
        .setProtectedHeader({
          alg: "Ed25519",
          kid,
          typ: "application/vnd.sharness.agent-card+jws",
        })
        .sign(),
    catch: () => new AuthenticationFailedError(),
  });
  const agentCard = yield* Schema.decodeUnknown(AgentCard)(signed).pipe(
    Effect.flatMap((agentCard) =>
      AgentCard.verify({ agentCard, registrySignerPublicKey }),
    ),
  );
  return { ...fixture, agentCard };
}).pipe(Effect.withSpan("retainedIdentityFixture"));
