/** @file AgentCard and SignedMessage immutability, representation, bounds, and signature tests. */

import {
  Effect,
  Either,
  Encoding,
  ParseResult,
  Redacted,
  Schema,
} from "effect";
import * as fc from "fast-check";
import { generateKeyPairSync } from "node:crypto";
import { expect, it } from "vitest";
import {
  AgentCardIssuedAt,
  makeVerifiedCard,
} from "../../__tests__/agent-card-fixtures.js";
import {
  decodeCanonicalJson,
  encodeCanonicalJson,
} from "../../../encoding/canonical-json.js";
import {
  AgentCard,
  AgentCardVerificationError,
  digestAgentCard,
  type VerifiedAgentCard,
} from "../../cards.js";
import {
  AgentId,
  type AgentId as AgentIdValue,
  AgentName,
  PrincipalId,
} from "../../identifiers.js";
import {
  AgentSigningAuthority,
  type AgentSigningAuthority as AgentSigningAuthorityValue,
  agentSigningPrivateKey,
  Ed25519PublicKey,
  ed25519PublicKeyThumbprintUri,
} from "../../keys.js";
import {
  EnvelopeId,
  SignedMessage,
  SignedMessageSigningError,
  type SignedMessage as SignedMessageValue,
} from "../signed-message.js";
import cofactoredGolden from "./wire-cofactored-golden.json" with { type: "json" };

const MAXIMUM_BODY_BYTES = 262_144;
const MAXIMUM_RECIPIENTS = 128;

const MIXED_ORDER_PUBLIC_KEY_X = "lZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZk";

/**
 * A Registry-signed pre-reset card is outside retained-history admission.
 */
const priorVersionAgentCard = {
  payload:
    "eyJhZ2VudElkIjoiYWd0Xy12cjYtdnI2LXZyNi12cjYtdnI2LWciLCJhZ2VudE5hbWUiOiJtaXhlZC1vcmRlci1zZW5kZXIiLCJpc3N1ZWRBdCI6IjIwMjYtMDctMzBUMTI6MDA6MDBaIiwia2luZCI6ImFnZW50Q2FyZCIsIm1vbHR6YXBWZXJzaW9uIjoiMjAyNi44MjcuMSIsInByaW5jaXBhbElkIjoicHJuXy1mbjUtZm41LWZuNS1mbjUtZm41LVEiLCJwdWJsaWNLZXkiOnsiY3J2IjoiRWQyNTUxOSIsImt0eSI6Ik9LUCIsIngiOiJsWm1abVptWm1abVptWm1abVptWm1abVptWm1abVptWm1abVptWm1abVprIn19",
  signatures: [
    {
      protected:
        "eyJhbGciOiJFZDI1NTE5Iiwia2lkIjoidXJuOmlldGY6cGFyYW1zOm9hdXRoOmp3ay10aHVtYnByaW50OnNoYS0yNTY6a1ByS19xbXhWV2FZVkE5d3dCRjZJdW8zdlZ6ejdUeEhDVHdYQnlnclM0ayIsInR5cCI6ImFwcGxpY2F0aW9uL3ZuZC5tb2x0emFwLmFnZW50LWNhcmQrandzIn0",
      signature:
        "foMLtTx77cf-oM7B5634ShB7tMno9EAtidOMnXIM1FArtOmsFPkegrOxj6FdqD3Etg3zCk1wUnISQON9fijFBg",
    },
  ],
};

const rawSignature = Schema.Struct({
  protected: Schema.String,
  signature: Schema.String,
});
const rawRepresentation = Schema.Struct({
  payload: Schema.String,
  signatures: Schema.Tuple(rawSignature),
});
const rawPayload = Schema.Struct({
  kind: Schema.String,
  sharnessVersion: Schema.String,
  senderAgentId: Schema.String,
  agentCardDigest: Schema.String,
  recipientAgentIds: Schema.Array(Schema.String),
  envelopeId: Schema.String,
  body: Schema.String,
});
const rawProtectedHeader = Schema.Struct({
  alg: Schema.String,
  kid: Schema.String,
  typ: Schema.String,
});

type RawRepresentation = typeof rawRepresentation.Type;
type RawPayload = typeof rawPayload.Type;
type RawProtectedHeader = typeof rawProtectedHeader.Type;

interface IdentityFixture {
  readonly agentCard: VerifiedAgentCard;
  readonly agentSigningAuthority: AgentSigningAuthorityValue;
  readonly registrySignerPublicKey: ReturnType<
    typeof AgentSigningAuthority.publicKey
  >;
}

const identifier = (prefix: string, byte: number): string =>
  `${prefix}${Encoding.encodeBase64Url(new Uint8Array(16).fill(byte))}`;

const makeSigningAuthority = () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const privateKeyPem = privateKey.export({
    format: "pem",
    type: "pkcs8",
  });
  return AgentSigningAuthority.fromPkcs8(Redacted.make(privateKeyPem));
};

const makeIdentityFixture = Effect.gen(function* () {
  const registrySigningAuthority = yield* makeSigningAuthority();
  const agentSigningAuthority = yield* makeSigningAuthority();
  const agentCard = yield* makeVerifiedCard({
    agentId: Schema.decodeUnknownSync(AgentId)(identifier("agt_", 250)),
    principalId: Schema.decodeUnknownSync(PrincipalId)(identifier("prn_", 249)),
    agentName: Schema.decodeUnknownSync(AgentName)("snapshot-sender"),
    publicKey: AgentSigningAuthority.publicKey(agentSigningAuthority),
    issuedAt: Schema.decodeUnknownSync(AgentCardIssuedAt)(
      "2026-07-30T12:00:00Z",
    ),
    registrySigningAuthority,
  });
  return {
    agentCard,
    agentSigningAuthority,
    registrySignerPublicKey: AgentSigningAuthority.publicKey(
      registrySigningAuthority,
    ),
  };
});

const makeAgentId = (byte: number) =>
  Schema.decodeUnknownSync(AgentId)(identifier("agt_", byte));

const makeEnvelopeId = (byte: number) =>
  Schema.decodeUnknownSync(EnvelopeId)(identifier("env_", byte));

const recipientSet = (count: number): ReadonlySet<AgentIdValue> => {
  const recipients = new Set<AgentIdValue>();
  for (let index = 0; index < count; index += 1) {
    recipients.add(makeAgentId(index));
  }
  return recipients;
};

const signMessage = (
  fixture: IdentityFixture,
  body: Uint8Array,
  recipients: ReadonlySet<AgentIdValue>,
  envelopeIdByte: number,
) =>
  SignedMessage.sign({
    agentCard: fixture.agentCard,
    signingAuthority: fixture.agentSigningAuthority,
    recipientAgentIds: recipients,
    envelopeId: makeEnvelopeId(envelopeIdByte),
    body,
  });

const makeSnapshotFixture = Effect.gen(function* () {
  const identity = yield* makeIdentityFixture;
  const firstRecipient = Schema.decodeUnknownSync(AgentId)(
    identifier("agt_", 3),
  );
  const secondRecipient = Schema.decodeUnknownSync(AgentId)(
    identifier("agt_", 4),
  );
  const recipients = new Set([firstRecipient]);
  const body = Uint8Array.from([1, 2, 3, 4]);
  const signedMessage = yield* signMessage(identity, body, recipients, 5);
  return {
    agentCard: identity.agentCard,
    registrySignerPublicKey: identity.registrySignerPublicKey,
    body,
    firstRecipient,
    recipients,
    secondRecipient,
    signedMessage,
  };
});

const messageRepresentation = (signedMessage: SignedMessageValue) =>
  Schema.encode(SignedMessage)(signedMessage).pipe(
    Effect.flatMap(Schema.decodeUnknown(rawRepresentation)),
  );

const agentCardRepresentation = (agentCard: VerifiedAgentCard) =>
  Schema.encode(AgentCard)(agentCard).pipe(
    Effect.flatMap(Schema.decodeUnknown(rawRepresentation)),
  );

const decodeBase64Url = (value: string) =>
  Either.match(Encoding.decodeBase64Url(value), {
    onLeft: (error) => Effect.fail(error),
    onRight: (bytes) => Effect.succeed(bytes),
  });

const wasRejected = <Right, Left>(
  result: Either.Either<Right, Left>,
): boolean =>
  Either.match(result, {
    onLeft: () => true,
    onRight: () => false,
  });

type PayloadMutation = (payload: RawPayload) => RawPayload;
type HeaderMutation = (header: RawProtectedHeader) => RawProtectedHeader;

const mutatePayload = (
  representation: RawRepresentation,
  mutate: PayloadMutation,
) =>
  Effect.gen(function* () {
    const bytes = yield* decodeBase64Url(representation.payload);
    const parsed = yield* decodeCanonicalJson(rawPayload, bytes);
    const encoded = yield* encodeCanonicalJson(mutate(parsed));
    return {
      ...representation,
      payload: Encoding.encodeBase64Url(encoded),
    };
  });

const mutateProtectedHeader = (
  representation: RawRepresentation,
  mutate: HeaderMutation,
) =>
  Effect.gen(function* () {
    const signature = representation.signatures[0];
    const bytes = yield* decodeBase64Url(signature.protected);
    const parsed = yield* decodeCanonicalJson(rawProtectedHeader, bytes);
    const encoded = yield* encodeCanonicalJson(mutate(parsed));
    return {
      ...representation,
      signatures: [
        {
          ...signature,
          protected: Encoding.encodeBase64Url(encoded),
        },
      ] as const,
    };
  });

const mutateSignature = (representation: RawRepresentation) =>
  Effect.gen(function* () {
    const signature = representation.signatures[0];
    const bytes = Uint8Array.from(yield* decodeBase64Url(signature.signature));
    const firstByte = bytes[0];
    if (firstByte === undefined) {
      return representation;
    }
    bytes[0] = firstByte ^ 1;
    return {
      ...representation,
      signatures: [
        {
          ...signature,
          signature: Encoding.encodeBase64Url(bytes),
        },
      ] as const,
    };
  });

const replaceSignature = (
  representation: RawRepresentation,
  signature: Uint8Array,
): RawRepresentation => ({
  ...representation,
  signatures: [
    {
      ...representation.signatures[0],
      signature: Encoding.encodeBase64Url(signature),
    },
  ],
});

/**
 * Signs a message's exact protected header and payload with another
 * authority's key, as that key's holder would to pass the message off as the
 * original sender's.
 */
const resignWith = (
  representation: RawRepresentation,
  authority: AgentSigningAuthorityValue,
) =>
  Effect.tryPromise({
    try: () =>
      crypto.subtle.sign(
        "Ed25519",
        agentSigningPrivateKey(authority),
        new TextEncoder().encode(
          `${representation.signatures[0].protected}.${representation.payload}`,
        ),
      ),
    catch: (cause) => new Error("re-signing failed", { cause }),
  }).pipe(
    Effect.map((signature) =>
      replaceSignature(representation, new Uint8Array(signature)),
    ),
  );

const mutationIsRejected = (
  representation: RawRepresentation,
  agentCard: VerifiedAgentCard,
) =>
  Schema.decodeUnknown(SignedMessage)(representation, {
    exact: true,
    onExcessProperty: "error",
  }).pipe(
    Effect.flatMap((signedMessage) =>
      SignedMessage.verify({ signedMessage, agentCard }),
    ),
    Effect.either,
    Effect.map(Either.isLeft),
  );

const actualEncodedByteLength = (signedMessage: SignedMessageValue) =>
  messageRepresentation(signedMessage).pipe(
    Effect.flatMap(encodeCanonicalJson),
    Effect.map((bytes) => bytes.byteLength),
  );

const assertLengthInvariant = (
  fixture: IdentityFixture,
  body: Uint8Array,
  recipientCount: number,
  envelopeIdByte: number,
) =>
  Effect.gen(function* () {
    const signedMessage = yield* signMessage(
      fixture,
      body,
      recipientSet(recipientCount),
      envelopeIdByte,
    );
    const representation = yield* messageRepresentation(signedMessage);
    const parsed = yield* Schema.decodeUnknown(SignedMessage)(representation);
    const actualLength = yield* actualEncodedByteLength(parsed);
    expect(SignedMessage.encodedByteLength(parsed)).toBe(actualLength);
  });

interface NamedMutation {
  readonly name: string;
  readonly representation: RawRepresentation;
}

const namedMutation = <E, R>(
  name: string,
  mutation: Effect.Effect<RawRepresentation, E, R>,
) => mutation.pipe(Effect.map((representation) => ({ name, representation })));

const payloadMutations = (representation: RawRepresentation) =>
  [
    namedMutation(
      "sender",
      mutatePayload(representation, (value) => ({
        ...value,
        senderAgentId: makeAgentId(200),
      })),
    ),
    namedMutation(
      "recipients",
      mutatePayload(representation, (value) => ({
        ...value,
        recipientAgentIds: [makeAgentId(201)],
      })),
    ),
    namedMutation(
      "message ID",
      mutatePayload(representation, (value) => ({
        ...value,
        envelopeId: makeEnvelopeId(202),
      })),
    ),
    namedMutation(
      "body",
      mutatePayload(representation, (value) => ({
        ...value,
        body: Encoding.encodeBase64Url(Uint8Array.from([9, 8, 7])),
      })),
    ),
    namedMutation(
      "version",
      mutatePayload(representation, (value) => ({
        ...value,
        sharnessVersion: `${value.sharnessVersion}-changed`,
      })),
    ),
    namedMutation(
      "card digest",
      mutatePayload(representation, (value) => ({
        ...value,
        agentCardDigest: `acd_${Encoding.encodeBase64Url(new Uint8Array(32).fill(203))}`,
      })),
    ),
  ] as const;

const headerAndSignatureMutations = (representation: RawRepresentation) =>
  [
    namedMutation(
      "key ID",
      mutateProtectedHeader(representation, (value) => ({
        ...value,
        kid: `${value.kid}-changed`,
      })),
    ),
    namedMutation(
      "type",
      mutateProtectedHeader(representation, (value) => ({
        ...value,
        typ: `${value.typ}-changed`,
      })),
    ),
    namedMutation("signature", mutateSignature(representation)),
  ] as const;

const cryptographicMutations = (representation: RawRepresentation) =>
  Effect.all(
    [
      ...payloadMutations(representation),
      ...headerAndSignatureMutations(representation),
    ],
    { concurrency: 1 },
  );

const assertMutationRejected = (
  mutation: NamedMutation,
  agentCard: VerifiedAgentCard,
) =>
  Effect.gen(function* () {
    const rejected = yield* mutationIsRejected(
      mutation.representation,
      agentCard,
    );
    expect(rejected, mutation.name).toBe(true);
  });

const parsedLengthProperty = (fixture: IdentityFixture) =>
  fc.asyncProperty(
    fc.uint8Array({ maxLength: 4096 }),
    fc.integer({ min: 1, max: MAXIMUM_RECIPIENTS }),
    fc.integer({ min: 0, max: 247 }),
    (body, recipientCount, envelopeIdByte) =>
      Effect.runPromise(
        assertLengthInvariant(fixture, body, recipientCount, envelopeIdByte),
      ),
  );

const verifyParsedLengthProperty = Effect.gen(function* () {
  const fixture = yield* makeIdentityFixture;
  yield* Effect.tryPromise({
    try: () => fc.assert(parsedLengthProperty(fixture), { numRuns: 24 }),
    catch: (cause) =>
      new Error("parsed SignedMessage length property failed", { cause }),
  });
});

it("retains the signed body and recipients independently of caller mutations", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* makeSnapshotFixture;
      const {
        agentCard,
        body,
        firstRecipient,
        recipients,
        secondRecipient,
        signedMessage,
      } = fixture;
      body[0] = 99;
      recipients.add(secondRecipient);
      const returnedBody = signedMessage.body;
      returnedBody[1] = 99;

      expect(signedMessage.recipientAgentIds).toStrictEqual([firstRecipient]);
      expect(signedMessage.body).toStrictEqual(Uint8Array.from([1, 2, 3, 4]));

      const representation = yield* Schema.encode(SignedMessage)(signedMessage);
      const parsed = yield* Schema.decodeUnknown(SignedMessage)(representation);
      const verified = yield* SignedMessage.verify({
        signedMessage: parsed,
        agentCard,
      });

      expect(verified.recipientAgentIds).toStrictEqual([firstRecipient]);
      expect(verified.body).toStrictEqual(Uint8Array.from([1, 2, 3, 4]));
    }),
  ));

it("keeps encoded artifacts unchanged when callers mutate public views", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* makeSnapshotFixture;
      const cardBefore = yield* Schema.encode(AgentCard)(fixture.agentCard);
      const messageBefore = yield* messageRepresentation(fixture.signedMessage);

      expect(
        Reflect.set(fixture.agentCard.publicKey, "x", "A".repeat(43)),
      ).toBe(false);
      expect(
        Reflect.set(
          fixture.signedMessage.recipientAgentIds,
          "0",
          fixture.secondRecipient,
        ),
      ).toBe(false);
      const body = fixture.signedMessage.body;
      body.fill(0);

      const cardAfter = yield* Schema.encode(AgentCard)(fixture.agentCard);
      const messageAfter = yield* messageRepresentation(fixture.signedMessage);
      expect(cardAfter).toStrictEqual(cardBefore);
      expect(messageAfter).toStrictEqual(messageBefore);
    }),
  ));

it("rejects every cryptographically covered field mutation after the original verifies", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* makeSnapshotFixture;
      yield* SignedMessage.verify({
        signedMessage: fixture.signedMessage,
        agentCard: fixture.agentCard,
      });
      const representation = yield* messageRepresentation(
        fixture.signedMessage,
      );
      const mutations: readonly NamedMutation[] =
        yield* cryptographicMutations(representation);

      yield* Effect.forEach(
        mutations,
        (mutation) => assertMutationRejected(mutation, fixture.agentCard),
        { concurrency: 1, discard: true },
      );
    }),
  ));

it("verifies each message under its own card's key, not another key already imported", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const first = yield* makeIdentityFixture;
      const second = yield* makeIdentityFixture;
      const firstMessage = yield* signMessage(
        first,
        Uint8Array.from([1]),
        recipientSet(1),
        1,
      );
      yield* SignedMessage.verify({
        signedMessage: firstMessage,
        agentCard: first.agentCard,
      });
      const secondMessage = yield* signMessage(
        second,
        Uint8Array.from([2]),
        recipientSet(1),
        2,
      );
      const forged = yield* resignWith(
        yield* messageRepresentation(secondMessage),
        first.agentSigningAuthority,
      );

      expect(yield* mutationIsRejected(forged, second.agentCard)).toBe(true);
      yield* SignedMessage.verify({
        signedMessage: secondMessage,
        agentCard: second.agentCard,
      });
    }),
  ));

/**
 * A Proxy over a valid key passes the Ed25519PublicKey Schema, which inspects
 * property descriptors only, yet throws when its `x` is read.
 */
it("fails AgentCard verification with its typed error when the Registry key cannot be read", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* makeIdentityFixture;
      const registrySignerPublicKey = Schema.validateSync(Ed25519PublicKey)(
        new Proxy(fixture.registrySignerPublicKey, {
          get: () => {
            throw new Error("unreadable key");
          },
        }),
      );

      const outcome = yield* AgentCard.verify({
        agentCard: fixture.agentCard,
        registrySignerPublicKey,
      }).pipe(Effect.either);

      expect(outcome).toStrictEqual(
        Either.left(new AgentCardVerificationError()),
      );
    }),
  ));

it("fails signing with its typed error when the sender's AgentCard cannot be read", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* makeIdentityFixture;
      const agentCard = new Proxy(fixture.agentCard, {
        get: () => {
          throw new Error("unreadable card");
        },
      });

      const outcome = yield* SignedMessage.sign({
        agentCard,
        signingAuthority: fixture.agentSigningAuthority,
        recipientAgentIds: recipientSet(1),
        envelopeId: makeEnvelopeId(1),
        body: Uint8Array.from([1]),
      }).pipe(Effect.either);

      expect(outcome).toStrictEqual(
        Either.left(new SignedMessageSigningError()),
      );
    }),
  ));

it("rejects the identity-point universal signature on every signed artifact", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* makeSnapshotFixture;
      const universalSignature = new Uint8Array(64);
      universalSignature[0] = 1;
      const [agentCard, signedMessage] = yield* Effect.all(
        [
          agentCardRepresentation(fixture.agentCard),
          messageRepresentation(fixture.signedMessage),
        ] as const,
        { concurrency: 2 },
      );

      const parsedCard = yield* Schema.decodeUnknown(AgentCard)(
        replaceSignature(agentCard, universalSignature),
      );
      const parsedMessage = yield* Schema.decodeUnknown(SignedMessage)(
        replaceSignature(signedMessage, universalSignature),
      );
      const cardResult = yield* AgentCard.verify({
        agentCard: parsedCard,
        registrySignerPublicKey: fixture.registrySignerPublicKey,
      }).pipe(Effect.either);
      const messageResult = yield* SignedMessage.verify({
        signedMessage: parsedMessage,
        agentCard: fixture.agentCard,
      }).pipe(Effect.either);

      expect(wasRejected(cardResult)).toBe(true);
      expect(wasRejected(messageResult)).toBe(true);
    }),
  ));

it("rejects a signature accepted only by cofactored Ed25519 verification", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const registrySignerPublicKey = yield* Schema.decodeUnknown(
        Ed25519PublicKey,
      )(cofactoredGolden.registryKey);
      const parsedCard = yield* Schema.decodeUnknown(AgentCard)(
        cofactoredGolden.card,
      );
      const agentCard = yield* AgentCard.verify({
        agentCard: parsedCard,
        registrySignerPublicKey,
      });
      expect(agentCard.publicKey.x).toBe(MIXED_ORDER_PUBLIC_KEY_X);
      expect(yield* digestAgentCard(agentCard)).toBe(
        cofactoredGolden.cardDigest,
      );
      expect(yield* ed25519PublicKeyThumbprintUri(agentCard.publicKey)).toBe(
        cofactoredGolden.keyId,
      );

      const signedMessage = yield* Schema.decodeUnknown(SignedMessage)(
        cofactoredGolden.message,
      );
      expect(signedMessage.senderAgentId).toBe(agentCard.agentId);
      expect(signedMessage.agentCardDigest).toBe(cofactoredGolden.cardDigest);
      expect(new TextDecoder().decode(signedMessage.body)).toBe(
        cofactoredGolden.bodyText,
      );
      const result = yield* SignedMessage.verify({
        signedMessage,
        agentCard,
      }).pipe(Effect.either);
      expect(wasRejected(result)).toBe(true);
    }),
  ));

it("refuses an AgentCard the Registry signed under the prior Social Harness version", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const refusal = yield* Schema.decodeUnknown(AgentCard)(
        priorVersionAgentCard,
      ).pipe(Effect.flip);

      expect(refusal).toBeInstanceOf(ParseResult.ParseError);
    }),
  ));

it("derives the exact maximum complete SignedMessage encoding", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* makeIdentityFixture;
      const signedMessage = yield* signMessage(
        fixture,
        new Uint8Array(MAXIMUM_BODY_BYTES),
        recipientSet(MAXIMUM_RECIPIENTS),
        248,
      );
      const actualLength = yield* actualEncodedByteLength(signedMessage);

      expect(actualLength).toBe(SignedMessage.maximumEncodedByteLength);
      expect(
        yield* signMessage(
          fixture,
          new Uint8Array(MAXIMUM_BODY_BYTES + 1),
          recipientSet(MAXIMUM_RECIPIENTS),
          249,
        ).pipe(Effect.isFailure),
      ).toBe(true);
      expect(SignedMessage.encodedByteLength(signedMessage)).toBe(actualLength);
    }),
  ));

it("reports the actual retained encoding length for parsed messages", () => {
  expect.hasAssertions();
  return Effect.runPromise(verifyParsedLengthProperty);
});
