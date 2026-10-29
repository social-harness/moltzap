/** @file Deterministic identifiers and Registry-signed AgentCards for client tests. */

import canonicalize from "canonicalize";
import { Effect, Encoding, Redacted, Schema } from "effect";
import {
  createHash,
  generateKeyPairSync,
  type KeyObject,
  sign as signBytes,
} from "node:crypto";
import {
  AgentCard,
  AgentView,
  type VerifiedAgentCard,
} from "../identity/cards.js";
import { AgentId, AgentName, PrincipalId } from "../identity/identifiers.js";
import { AgentSigningAuthority, Ed25519PublicKey } from "../identity/keys.js";
import { WIRE_VERSION } from "../identity/wire-version.js";

/** A Registry signing key pair, as `generateKeyPairSync("ed25519")` returns. */
export interface RegistryKeyPair {
  readonly publicKey: KeyObject;
  readonly privateKey: KeyObject;
}

/** What one test card binds; `byte` fills both its AgentId and PrincipalId. */
interface TestCardInput {
  readonly byte: number;
  readonly name: string;
  readonly authority: AgentSigningAuthority;
  /** The Registry key pair the card is issued and verified under. */
  readonly registryKeys: RegistryKeyPair;
}

/**
 * A prefixed identifier over 16 repeated bytes, the form of AgentId,
 * PrincipalId, RouterInstanceId and the other short protocol identifiers.
 * @param prefix Identifier prefix, such as `agt_`.
 * @param byte Value repeated across all 16 bytes.
 * @returns The identifier text, before schema decoding.
 */
export function identifier(prefix: string, byte: number): string {
  return `${prefix}${Encoding.encodeBase64Url(new Uint8Array(16).fill(byte))}`;
}

/** Host projection fixtures use the same immutable identities as the signed Alice, Bob and Carol fixtures. */
export function testAgentView(address: string): AgentView {
  const name = address.startsWith("agent:")
    ? address.slice("agent:".length)
    : address;
  const index = ["alice", "bob", "carol", "dave"].indexOf(name);
  const suffix =
    index < 0
      ? createHash("sha256")
          .update(name)
          .digest()
          .subarray(0, 16)
          .toString("base64url")
      : Encoding.encodeBase64Url(new Uint8Array(16).fill(index + 1));
  return Schema.decodeUnknownSync(AgentView)({
    agentId: `agt_${suffix}`,
    agentName: name,
    principalId: `prn_${suffix}`,
  });
}

/**
 * A prefixed identifier over 32 repeated bytes, the form of PostId,
 * RecordHash, DeliveryToken, CollectiveId and the other digest-shaped
 * identifiers.
 * @param prefix Identifier prefix, such as `pst_`.
 * @param byte Value repeated across all 32 bytes.
 * @returns The identifier text, before schema decoding.
 */
export function digest(prefix: string, byte: number): string {
  return `${prefix}${Encoding.encodeBase64Url(new Uint8Array(32).fill(byte))}`;
}

/**
 * A signing authority over a fresh Ed25519 key.
 * @returns The authority; a key Node generated always imports.
 */
export function makeTestAuthority(): Effect.Effect<AgentSigningAuthority> {
  const { privateKey } = generateKeyPairSync("ed25519");
  return AgentSigningAuthority.fromPkcs8(
    Redacted.make(privateKey.export({ format: "pem", type: "pkcs8" })),
  ).pipe(Effect.orDie);
}

/**
 * Issue the AgentCard the Registry would sign for `input` and verify it as an
 * endpoint does, so a test holds only cards that pass `AgentCard.verify`.
 * @param input Identifier byte, agent name, agent key and Registry key pair.
 * @returns The verified card.
 */
export function issueTestCard(
  input: TestCardInput,
): Effect.Effect<VerifiedAgentCard> {
  return Effect.gen(function* () {
    const registrySignerPublicKey = yield* Schema.decodeUnknown(
      Ed25519PublicKey,
    )(input.registryKeys.publicKey.export({ format: "jwk" }));
    const thumbprint = createHash("sha256")
      .update(canonicalize(registrySignerPublicKey) ?? "")
      .digest("base64url");
    const protectedText = canonicalize({
      alg: "Ed25519",
      kid: `urn:ietf:params:oauth:jwk-thumbprint:sha-256:${thumbprint}`,
      typ: "application/vnd.sharness.agent-card+jws",
    });
    const payloadText = canonicalize({
      agentId: Schema.decodeUnknownSync(AgentId)(
        identifier("agt_", input.byte),
      ),
      agentName: Schema.decodeUnknownSync(AgentName)(input.name),
      issuedAt: "2026-08-27T12:00:00Z",
      kind: "agentCard",
      sharnessVersion: WIRE_VERSION,
      principalId: Schema.decodeUnknownSync(PrincipalId)(
        identifier("prn_", input.byte),
      ),
      publicKey: AgentSigningAuthority.publicKey(input.authority),
    });
    if (protectedText === undefined || payloadText === undefined) {
      return yield* Effect.dieMessage("canonical AgentCard fixture failed");
    }
    const protectedValue = Buffer.from(protectedText).toString("base64url");
    const payload = Buffer.from(payloadText).toString("base64url");
    const signature = signBytes(
      null,
      Buffer.from(`${protectedValue}.${payload}`),
      input.registryKeys.privateKey,
    ).toString("base64url");
    const card = yield* Schema.decodeUnknown(AgentCard)({
      payload,
      signatures: [{ protected: protectedValue, signature }],
    });
    return yield* AgentCard.verify({
      agentCard: card,
      registrySignerPublicKey,
    });
  }).pipe(Effect.orDie, Effect.withSpan("issueTestCard"));
}
