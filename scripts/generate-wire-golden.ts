/**
 * @file Rebuild synthetic retained-wire fixtures with deterministic test-only keys.
 * Regenerate with pnpm nx run workspace:generate-wire-golden.
 */

import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect, Encoding, Redacted, Schema } from "effect";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  AgentCardIssuedAt as agentCardIssuedAt,
  issueAgentCard,
} from "../packages/registry/dist/issuance.js";
import {
  MessageId,
  SignedMessage,
} from "../packages/social-harness/dist/communication/envelope/signed-message.js";
import { encodeCanonicalJson } from "../packages/social-harness/dist/encoding/canonical-json.js";
import {
  AgentId,
  AgentName,
  PrincipalId,
} from "../packages/social-harness/dist/identity/agents.js";
import {
  AgentCard,
  digestAgentCard,
} from "../packages/social-harness/dist/identity/cards.js";
import {
  AgentSigningAuthority,
  Ed25519PublicKey,
} from "../packages/social-harness/dist/identity/keys.js";
import {
  WIRE_VERSION,
  WireVersions,
} from "../packages/social-harness/dist/identity/wire-version.js";

/** Public deterministic seeds belong only to synthetic golden fixtures. */
function testAuthority(byte: number) {
  const der = Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"),
    Buffer.alloc(32, byte),
  ]);
  return AgentSigningAuthority.fromPkcs8(
    Redacted.make(
      `-----BEGIN PRIVATE KEY-----\n${der.toString("base64")}\n-----END PRIVATE KEY-----\n`,
    ),
  );
}

const identifier = (prefix: string, byte: number) =>
  `${prefix}${Encoding.encodeBase64Url(new Uint8Array(16).fill(byte))}`;
const retainedVersion = "2099.101.0";

/**
 * For A = B + T with T of order two, R = B and S = 1 + k satisfy the
 * cofactored equation. Odd k leaves T in the strict equation, so it fails.
 * The scalar one and public points are synthetic test material.
 */
function cofactoredSignature(input: Uint8Array): Uint8Array | undefined {
  const order = (1n << 252n) + 27742317777372353535851937790883648493n;
  const r = Buffer.from(`58${"66".repeat(31)}`, "hex");
  const a = Buffer.from(
    "lZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZk",
    "base64url",
  );
  const hash = createHash("sha512").update(r).update(a).update(input).digest();
  const k = BigInt(`0x${Buffer.from(hash).reverse().toString("hex")}`) % order;
  if (k % 2n === 0n) {
    return undefined;
  }
  const scalar = Buffer.from(
    ((1n + k) % order).toString(16).padStart(64, "0"),
    "hex",
  ).reverse();
  return Buffer.concat([r, scalar]);
}

/** Select an odd challenge so the strict and cofactored equations differ. */
const cofactoredMessage = (
  card: AgentCard,
  cardDigest: string,
  header: string,
) =>
  Effect.gen(function* () {
    for (let attempt = 0; ; attempt += 1) {
      const bodyText = `cofactored-canary-${attempt}`;
      const payload = Encoding.encodeBase64Url(
        yield* encodeCanonicalJson({
          kind: "signedMessage",
          sharnessVersion: WIRE_VERSION,
          senderAgentId: card.agentId,
          agentCardDigest: cardDigest,
          recipientAgentIds: [identifier("agt_", 0)],
          messageId: identifier("msg_", 1),
          body: Buffer.from(bodyText).toString("base64url"),
        }),
      );
      const signature = cofactoredSignature(
        Buffer.from(`${header}.${payload}`),
      );
      if (signature !== undefined) {
        return {
          message: {
            payload,
            signatures: [
              {
                protected: header,
                signature: Encoding.encodeBase64Url(signature),
              },
            ],
          },
          bodyText,
        };
      }
    }
  });

/** Build complete current-wire artifacts so schema refusal cannot mask strict verification. */
const generateCofactored = Effect.gen(function* () {
  const registryAuthority = yield* testAuthority(1);
  const publicKey = yield* Schema.decodeUnknown(Ed25519PublicKey)({
    crv: "Ed25519",
    kty: "OKP",
    x: "lZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZk",
  });
  const card = yield* issueAgentCard({
    agentId: Schema.decodeUnknownSync(AgentId)(identifier("agt_", 254)),
    principalId: Schema.decodeUnknownSync(PrincipalId)(identifier("prn_", 253)),
    agentName: Schema.decodeUnknownSync(AgentName)("mixed-order-sender"),
    publicKey,
    issuedAt: Schema.decodeUnknownSync(agentCardIssuedAt)(
      "2026-07-30T12:00:00Z",
    ),
    registrySigningAuthority: registryAuthority,
  });
  const cardDigest = yield* digestAgentCard(card);
  const kidHash = createHash("sha256")
    .update(yield* encodeCanonicalJson(publicKey))
    .digest("base64url");
  const keyId = `urn:ietf:params:oauth:jwk-thumbprint:sha-256:${kidHash}`;
  const header = Encoding.encodeBase64Url(
    yield* encodeCanonicalJson({
      alg: "Ed25519",
      kid: keyId,
      typ: "application/vnd.sharness.signed-message+jws",
    }),
  );
  return {
    provenance:
      "Synthetic cofactored-only Ed25519 evidence. Regenerate: pnpm nx run workspace:generate-wire-golden.",
    registryKey: yield* Schema.encode(Ed25519PublicKey)(
      AgentSigningAuthority.publicKey(registryAuthority),
    ),
    card: yield* Schema.encode(AgentCard)(card),
    ...(yield* cofactoredMessage(card, cardDigest, header)),
    cardDigest,
    keyId,
  };
});

const generate = Effect.gen(function* () {
  const registryAuthority = yield* testAuthority(1);
  const signingAuthority = yield* testAuthority(2);
  const agentCard = yield* issueAgentCard({
    agentId: Schema.decodeUnknownSync(AgentId)(identifier("agt_", 1)),
    principalId: Schema.decodeUnknownSync(PrincipalId)(identifier("prn_", 2)),
    agentName: Schema.decodeUnknownSync(AgentName)("http-signer"),
    publicKey: AgentSigningAuthority.publicKey(signingAuthority),
    issuedAt: Schema.decodeUnknownSync(agentCardIssuedAt)(
      "2026-07-30T12:00:00Z",
    ),
    registrySigningAuthority: registryAuthority,
  });
  const message = yield* SignedMessage.sign({
    agentCard,
    signingAuthority,
    recipientAgentIds: new Set([agentCard.agentId]),
    messageId: Schema.decodeUnknownSync(MessageId)(identifier("msg_", 2)),
    body: new TextEncoder().encode("retained golden evidence"),
  });
  return {
    provenance:
      "Synthetic signed retained-version fixture using fictional 2099.101.0; not captured from a published release. Regenerate: pnpm nx run workspace:generate-wire-golden.",
    registryKey: yield* Schema.encode(Ed25519PublicKey)(
      AgentSigningAuthority.publicKey(registryAuthority),
    ),
    card: yield* Schema.encode(AgentCard)(agentCard),
    message: yield* Schema.encode(SignedMessage)(message),
  };
}).pipe(
  Effect.provideService(WireVersions, {
    emitted: retainedVersion,
    live: [retainedVersion],
    history: [retainedVersion],
  }),
);

await Effect.runPromise(
  Effect.all([generate, generateCofactored]).pipe(
    Effect.flatMap(([golden, cofactored]) =>
      FileSystem.FileSystem.pipe(
        Effect.flatMap((fileSystem) =>
          Effect.all([
            fileSystem.writeFileString(
              fileURLToPath(
                new URL(
                  "../packages/social-harness/src/communication/envelope/__tests__/wire-golden.json",
                  import.meta.url,
                ),
              ),
              `${JSON.stringify(golden, null, 2)}\n`,
            ),
            fileSystem.writeFileString(
              fileURLToPath(
                new URL(
                  "../packages/social-harness/src/communication/envelope/__tests__/wire-cofactored-golden.json",
                  import.meta.url,
                ),
              ),
              `${JSON.stringify(cofactored, null, 2)}\n`,
            ),
          ]),
        ),
      ),
    ),
    Effect.provide(NodeFileSystem.layer),
  ),
);
