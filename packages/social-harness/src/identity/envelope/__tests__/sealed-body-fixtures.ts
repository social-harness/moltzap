/**
 * @file Registered members, sealing, signing, and opening for the SealedBody
 * tests.
 */

import { Effect, Encoding, Redacted, Schema } from "effect";
import { generateKeyPairSync } from "node:crypto";
import type { VerifiedAgentCard } from "../../cards.js";
import {
  AgentCardIssuedAt,
  makeVerifiedCard,
} from "../../__tests__/agent-card-fixtures.js";
import { AgentId, AgentName, PrincipalId } from "../../identifiers.js";
import {
  AgentSigningAuthority,
  type AgentSigningAuthority as AgentSigningAuthorityValue,
  type Ed25519PublicKey,
} from "../../keys.js";
import { SealedBody } from "../sealed-body.js";
import {
  EnvelopeId,
  SignedMessage,
  type VerifiedSignedMessage,
} from "../signed-message.js";

/**
 * Building fixtures dominates these tests: every group member costs an
 * Ed25519 key, two PKCS#8 imports, and an issued AgentCard, and the largest
 * groups have 129 members and seal about 256 KB to 128 recipients. Loaded CI
 * hosts need more than the default five seconds.
 */
export const KEY_AGREEMENT_HEAVY_TIMEOUT_MS = 60_000;

/** How many members `makeGroup` builds, and tests open as, at once. */
export const FIXTURE_CONCURRENCY = 8;

/** A short text plaintext that the tests seal unless they need other bytes. */
export const plaintext = new TextEncoder().encode("sealed outer body");

/** A registered agent: its verified AgentCard and its signing authority. */
export interface Member {
  readonly agentCard: VerifiedAgentCard;
  readonly authority: AgentSigningAuthorityValue;
}

const identifier = (prefix: string, byte: number): string =>
  `${prefix}${Encoding.encodeBase64Url(new Uint8Array(16).fill(byte))}`;

const makeAuthority = () =>
  AgentSigningAuthority.fromPkcs8(
    Redacted.make(
      generateKeyPairSync("ed25519").privateKey.export({
        format: "pem",
        type: "pkcs8",
      }),
    ),
  );

/**
 * Issues an AgentCard whose identifiers all repeat `byte`, so two cards with
 * the same byte share an AgentId.
 *
 * @param registrySigningAuthority Registry that signs the card.
 * @param byte Byte repeated through the AgentId, PrincipalId, and name.
 * @param publicKey Ed25519 key the card carries.
 * @returns The verified card.
 */
export const issueCard = (
  registrySigningAuthority: AgentSigningAuthorityValue,
  byte: number,
  publicKey: Ed25519PublicKey,
) =>
  makeVerifiedCard({
    agentId: Schema.decodeUnknownSync(AgentId)(identifier("agt_", byte)),
    principalId: Schema.decodeUnknownSync(PrincipalId)(
      identifier("prn_", byte),
    ),
    agentName: Schema.decodeUnknownSync(AgentName)(`member-${byte}`),
    publicKey,
    issuedAt: Schema.decodeUnknownSync(AgentCardIssuedAt)(
      "2026-10-05T12:00:00Z",
    ),
    registrySigningAuthority,
  });

/**
 * Generates a fresh authority and has the Registry issue its AgentCard, with
 * `byte` repeated through the card's identifiers.
 */
export const makeMember = (
  registrySigningAuthority: AgentSigningAuthorityValue,
  byte: number,
) =>
  Effect.gen(function* () {
    const authority = yield* makeAuthority();
    const agentCard = yield* issueCard(
      registrySigningAuthority,
      byte,
      AgentSigningAuthority.publicKey(authority),
    );
    const member: Member = { agentCard, authority };
    return member;
  }).pipe(Effect.withSpan("makeMember"));

/**
 * Builds a sender, a peer, an outsider, and a recipient list that starts with
 * the sender, then the peer, then further members up to `recipientCount`.
 * The identifier bytes increase along the list, so it is in canonical order.
 *
 * @param recipientCount Number of recipients, sender included.
 * @returns The named members, the recipient list, and the Registry.
 */
export const makeGroup = (recipientCount: number) =>
  Effect.gen(function* () {
    const registrySigningAuthority = yield* makeAuthority();
    const sender = yield* makeMember(registrySigningAuthority, 1);
    const peer = yield* makeMember(registrySigningAuthority, 2);
    const outsider = yield* makeMember(registrySigningAuthority, 255);
    const others = yield* Effect.all(
      Array.from(Array(Math.max(recipientCount - 2, 0)).keys(), (index) =>
        makeMember(registrySigningAuthority, index + 3),
      ),
      { concurrency: FIXTURE_CONCURRENCY },
    );
    const recipients = [sender, peer, ...others].slice(0, recipientCount);
    return { sender, peer, outsider, recipients, registrySigningAuthority };
  }).pipe(Effect.withSpan("makeGroup"));

/** The members and Registry that `makeGroup` builds. */
export type Group = Effect.Effect.Success<ReturnType<typeof makeGroup>>;

/**
 * The EnvelopeId whose 16 bytes all repeat `byte`. `sealFrom` and `signBody`
 * both default to byte 1, so a test that names no EnvelopeId seals and signs
 * under the same one.
 */
export const envelopeIdOf = (byte: number) =>
  Schema.decodeUnknownSync(EnvelopeId)(identifier("env_", byte));

/**
 * Seals `bytes` from `sender` to the recipients' AgentCards.
 *
 * @param sender Sender whose AgentId the header binds.
 * @param recipients Recipients in the order the sender lists their cards.
 * @param bytes Plaintext to seal.
 * @param envelopeIdByte Byte repeated through the EnvelopeId the header binds.
 * @returns The sealed body.
 */
export const sealFrom = (
  sender: Member,
  recipients: readonly Member[],
  bytes: Uint8Array,
  envelopeIdByte = 1,
) =>
  SealedBody.seal({
    senderAgentId: sender.agentCard.agentId,
    recipientAgentCards: recipients.map((member) => member.agentCard),
    envelopeId: envelopeIdOf(envelopeIdByte),
    plaintext: bytes,
  });

/**
 * Signs `body` from `signer` to the recipients.
 *
 * @param signer Member that signs.
 * @param recipients Recipients the SignedMessage names.
 * @param body Body bytes, sealed or not.
 * @param envelopeIdByte Byte repeated through the EnvelopeId.
 * @returns The verified SignedMessage.
 */
export const signBody = (
  signer: Member,
  recipients: readonly Member[],
  body: Uint8Array,
  envelopeIdByte = 1,
) =>
  SignedMessage.sign({
    agentCard: signer.agentCard,
    signingAuthority: signer.authority,
    recipientAgentIds: new Set(
      recipients.map((member) => member.agentCard.agentId),
    ),
    envelopeId: envelopeIdOf(envelopeIdByte),
    body,
  });

/**
 * Opens `signedMessage` as `member`, with its own card and authority.
 *
 * @param member Local agent.
 * @param signedMessage Verified SignedMessage carrying a sealed body.
 * @returns The plaintext.
 */
export const openAs = (member: Member, signedMessage: VerifiedSignedMessage) =>
  SealedBody.open({
    agentCard: member.agentCard,
    signingAuthority: member.authority,
    signedMessage,
  });
