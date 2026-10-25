/** @file Immutable AgentCard representation, verification, and digest. */

import {
  Brand,
  Data,
  Effect,
  Encoding,
  ParseResult,
  Schema,
  type SchemaAST,
} from "effect";
import { GeneralSign, generalVerify } from "jose";
import { createHash } from "node:crypto";
import {
  decodeCanonicalJson,
  encodeCanonicalJson,
} from "../encoding/canonical-json.js";
import { exactStruct } from "../encoding/exact.js";
import { canonicalIdentifier } from "../encoding/identifier.js";
import {
  AgentId,
  type AgentId as AgentIdValue,
  AgentName,
  type AgentName as AgentNameValue,
  PrincipalId,
  type PrincipalId as PrincipalIdValue,
} from "./agents.js";
import {
  AgentSigningAuthority,
  agentSigningPrivateKey,
  Ed25519PublicKey,
  ed25519PublicKeyThumbprintUri,
  type Ed25519PublicKey as Ed25519PublicKeyValue,
  ed25519VerificationKey,
  generalJwsRepresentation,
  snapshotRepresentation,
} from "./keys.js";
import { AGENT_CARD_TYPE, WireVersions } from "./wire-version.js";

const DIGEST_BYTE_LENGTH = 32;
const WHOLE_SECOND_UTC =
  /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\dZ$/;

const isWholeSecondUtc = (value: string): boolean => {
  if (typeof value !== "string") {
    return false;
  }
  const epochMilliseconds = Date.parse(value);
  if (!Number.isFinite(epochMilliseconds)) {
    return false;
  }
  const wholeSecondValue = `${value.slice(0, -1)}.000Z`;
  return new Date(epochMilliseconds).toISOString() === wholeSecondValue;
};

/** Digest binding a message to one complete immutable AgentCard. */
// eslint-disable-next-line @typescript-eslint/naming-convention -- Effect Schemas share the public domain name they decode.
export const AgentCardDigest = canonicalIdentifier(
  "AgentCardDigest",
  "acd_",
  DIGEST_BYTE_LENGTH,
);
/** Validated nominal value decoded by AgentCardDigest. */
// eslint-disable-next-line @typescript-eslint/no-redeclare -- The same-named Schema and type form one boundary model.
export type AgentCardDigest = typeof AgentCardDigest.Type;

/** Shared whole-second UTC validation for parsed and issued AgentCards. */
const agentCardIssuedAtSchema = Schema.String.pipe(
  Schema.pattern(WHOLE_SECOND_UTC),
  Schema.filter(isWholeSecondUtc, {
    identifier: "AgentCardIssuedAt",
    description: "AgentCard issuance time in whole-second UTC",
  }),
  Schema.brand("AgentCardIssuedAt"),
  Schema.annotations({
    identifier: "AgentCardIssuedAt",
    description: "AgentCard issuance time in whole-second UTC",
  }),
);
type AgentCardRepresentation = typeof generalJwsRepresentation.Type;

const protectedHeader = exactStruct({
  alg: Schema.Literal("Ed25519"),
  kid: Schema.String,
  typ: Schema.Literal(AGENT_CARD_TYPE),
});

const payload = exactStruct({
  kind: Schema.Literal("agentCard"),
  sharnessVersion: WireVersions.history,
  agentId: AgentId,
  principalId: PrincipalId,
  agentName: AgentName,
  publicKey: Ed25519PublicKey,
  issuedAt: agentCardIssuedAtSchema,
});

/** Immutable public identity fields carried by an AgentCard. */
export interface AgentCard {
  readonly agentId: AgentIdValue;
  readonly principalId: PrincipalIdValue;
  readonly agentName: AgentNameValue;
  readonly publicKey: Ed25519PublicKeyValue;
  readonly issuedAt: string;
}

interface AgentCardState {
  readonly wireVersion: string;
  readonly representation: AgentCardRepresentation;
  readonly protectedHeader: typeof protectedHeader.Type;
  /** SHA-256 over the retained canonical JWS, fixed for the card's lifetime. */
  readonly digest: AgentCardDigest;
}

const cardState = new WeakMap<object, AgentCardState>();
const verifiedCards = new WeakSet();

const hasAgentCardState = (value: unknown): value is AgentCard =>
  typeof value === "object" &&
  value !== null &&
  Object.isFrozen(value) &&
  cardState.has(value);

const agentCardView = Schema.declare(hasAgentCardState, {
  identifier: "AgentCardView",
});

const parseIssue = (
  ast: SchemaAST.Transformation,
  actual: unknown,
): ParseResult.ParseIssue =>
  new ParseResult.Type(ast, actual, "Expected an exact AgentCard");

const decodeBase64Url = (
  value: string,
  ast: SchemaAST.Transformation,
): Effect.Effect<Uint8Array, ParseResult.ParseIssue> =>
  Encoding.decodeBase64Url(value).pipe(
    Effect.mapError(() => parseIssue(ast, value)),
  );

/** The refined SHA-256 digest of a card's retained canonical bytes. */
const digestOf = (
  bytes: Uint8Array,
  issue: () => ParseResult.ParseIssue,
): Effect.Effect<AgentCardDigest, ParseResult.ParseIssue> =>
  Effect.try({
    try: () => createHash("sha256").update(bytes).digest(),
    catch: issue,
  }).pipe(
    Effect.flatMap((hash) =>
      Schema.decodeUnknown(AgentCardDigest)(
        `acd_${Encoding.encodeBase64Url(hash)}`,
      ).pipe(Effect.mapError(issue)),
    ),
  );

const decodeRepresentation = (
  representation: AgentCardRepresentation,
  ast: SchemaAST.Transformation,
): Effect.Effect<AgentCard, ParseResult.ParseIssue> =>
  Effect.gen(function* () {
    const payloadBytes = yield* decodeBase64Url(representation.payload, ast);
    const headerBytes = yield* decodeBase64Url(
      representation.signatures[0].protected,
      ast,
    );
    const decodedPayload = yield* decodeCanonicalJson(
      payload,
      payloadBytes,
    ).pipe(Effect.mapError(() => parseIssue(ast, representation)));
    const decodedHeader = yield* decodeCanonicalJson(
      protectedHeader,
      headerBytes,
    ).pipe(Effect.mapError(() => parseIssue(ast, representation)));
    const publicKey = yield* Schema.decodeUnknown(Ed25519PublicKey)(
      Object.freeze({
        crv: decodedPayload.publicKey.crv,
        kty: decodedPayload.publicKey.kty,
        x: decodedPayload.publicKey.x,
      }),
    ).pipe(Effect.mapError(() => parseIssue(ast, representation)));
    const card = Object.freeze({
      agentId: decodedPayload.agentId,
      principalId: decodedPayload.principalId,
      agentName: decodedPayload.agentName,
      publicKey,
      issuedAt: decodedPayload.issuedAt,
    });
    const retained = snapshotRepresentation(representation);
    const retainedBytes = yield* encodeCanonicalJson(retained).pipe(
      Effect.mapError(() => parseIssue(ast, representation)),
    );
    const digest = yield* digestOf(retainedBytes, () =>
      parseIssue(ast, representation),
    );
    cardState.set(card, {
      wireVersion: decodedPayload.sharnessVersion,
      representation: retained,
      protectedHeader: Object.freeze({ ...decodedHeader }),
      digest,
    });
    return card;
  });

const encodeView = (
  card: AgentCard,
  ast: SchemaAST.Transformation,
): Effect.Effect<AgentCardRepresentation, ParseResult.ParseIssue> => {
  const state = cardState.get(card);
  return state === undefined
    ? Effect.fail(parseIssue(ast, card))
    : Effect.succeed(state.representation);
};

const agentCardSchema = Schema.transformOrFail(
  generalJwsRepresentation,
  agentCardView,
  {
    strict: true,
    decode: (representation, ...[, ast]) =>
      decodeRepresentation(representation, ast),
    encode: (card, ...[, ast]) => encodeView(card, ast),
  },
).annotations({
  identifier: "AgentCard",
  parseOptions: {
    exact: true,
    onExcessProperty: "error",
  },
});

/** AgentCard verified against a deployment-pinned Registry signer. */
export type VerifiedAgentCard = AgentCard & Brand.Brand<"VerifiedAgentCard">;

const brandVerifiedAgentCard = Brand.nominal<VerifiedAgentCard>();

/** Private no-serialization RPC witness for a verified card. */
export const verifiedAgentCardSchema = Schema.declare(
  (value: unknown): value is VerifiedAgentCard =>
    typeof value === "object" &&
    value !== null &&
    cardState.has(value) &&
    verifiedCards.has(value),
  { identifier: "VerifiedAgentCard" },
);

/** A parsed AgentCard does not verify against the pinned Registry signer. */
export class AgentCardVerificationError extends Data.TaggedError(
  "AgentCardVerificationError",
) {}

const verificationFailure = (): AgentCardVerificationError =>
  new AgentCardVerificationError();

const verifyAgentCard = (input: {
  readonly agentCard: AgentCard;
  readonly registrySignerPublicKey: Ed25519PublicKeyValue;
}): Effect.Effect<VerifiedAgentCard, AgentCardVerificationError> =>
  Effect.gen(function* () {
    const state = cardState.get(input.agentCard);
    if (state === undefined) {
      return yield* new AgentCardVerificationError();
    }
    const expectedKid = yield* ed25519PublicKeyThumbprintUri(
      input.registrySignerPublicKey,
    ).pipe(Effect.mapError(verificationFailure));
    if (
      state.protectedHeader.alg !== "Ed25519" ||
      state.protectedHeader.typ !== AGENT_CARD_TYPE ||
      state.protectedHeader.kid !== expectedKid
    ) {
      return yield* new AgentCardVerificationError();
    }
    const key = yield* ed25519VerificationKey(
      input.registrySignerPublicKey,
    ).pipe(Effect.mapError(verificationFailure));
    yield* Effect.tryPromise({
      try: () => {
        const signature = state.representation.signatures[0];
        return generalVerify(
          {
            payload: state.representation.payload,
            signatures: [
              {
                protected: signature.protected,
                signature: signature.signature,
              },
            ],
          },
          key,
          {
            algorithms: ["Ed25519"],
          },
        );
      },
      catch: verificationFailure,
    });
    verifiedCards.add(input.agentCard);
    return brandVerifiedAgentCard(input.agentCard);
  });

/**
 * Identity-owned digest over the complete retained AgentCard JWS.
 *
 * @param agentCard Parsed AgentCard to digest.
 * @returns The refined SHA-256 AgentCard digest.
 */
export const digestAgentCard = (
  agentCard: AgentCard,
): Effect.Effect<AgentCardDigest, AgentCardVerificationError> =>
  Effect.suspend(() => {
    const state = cardState.get(agentCard);
    return state === undefined
      ? Effect.fail(new AgentCardVerificationError())
      : Effect.succeed(state.digest);
  }).pipe(Effect.withSpan("digestAgentCard"));

/* eslint-disable @typescript-eslint/no-redeclare, @typescript-eslint/naming-convention, agent-code-guard/require-assertion-rationale --
 * The accepted same-name Schema/type API retains the exact private General JWS AST while erasing only its encoded TypeScript type.
 */
/** The retained signed version lets members derive the same conversation foundation. */
const wireVersion = (card: AgentCard): string =>
  cardState.get(card)?.wireVersion ?? "";

/** Verifies immutable Registry attestation without exposing JOSE mechanics. */
export const AgentCard = Object.assign(agentCardSchema, {
  verify: verifyAgentCard,
  wireVersion,
}) as Schema.Schema<AgentCard, unknown> &
  Readonly<{
    readonly verify: typeof verifyAgentCard;
    readonly wireVersion: typeof wireVersion;
  }>;
/* eslint-enable @typescript-eslint/no-redeclare, @typescript-eslint/naming-convention, agent-code-guard/require-assertion-rationale --
 * The accepted same-name Schema/type API retains the exact private General JWS AST while erasing only its encoded TypeScript type.
 */

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
