/** @file Complete Registry-owned client, request, and representation contract. */

import { Data, Effect, type Redacted, Schema } from "effect";
import type { HttpEnvelopeError } from "../signing/http-errors.js";
import type { AgentSigningError } from "../signing/http-signature.js";
import {
  decodeCanonicalJson,
  encodeCanonicalJson,
} from "../../encoding/canonical-json.js";
import { exactParseOptions, exactStruct } from "../../encoding/exact.js";
import { canonicalIdentifier } from "../../encoding/identifier.js";
import { AgentId, AgentName, PrincipalId } from "../agents.js";
import {
  AgentCard,
  type VerifiedAgentCard,
  verifiedAgentCardSchema,
} from "../cards.js";
import { type AgentSigningAuthority, Ed25519PublicKey } from "../keys.js";

/** Idempotency identity for a registration operation. */
// eslint-disable-next-line @typescript-eslint/naming-convention -- Effect Schemas share the public domain name they decode.
export const OperationId = canonicalIdentifier("OperationId", "opn_", 16);
/** Validated nominal value decoded by OperationId. */
// eslint-disable-next-line @typescript-eslint/no-redeclare -- The same-named Schema and type form one boundary model.
export type OperationId = typeof OperationId.Type;

/** The Registry connection could not be established or used. */
export class RegistryConnectionError extends Data.TaggedError(
  "RegistryConnectionError",
) {}

/** The configured complete Registry call deadline expired. */
export class RegistryRequestTimeoutError extends Data.TaggedError(
  "RegistryRequestTimeoutError",
) {}

/** A Registry response did not match the selected operation contract. */
export class RegistryInvalidResponseError extends Data.TaggedError(
  "RegistryInvalidResponseError",
) {}

/** Closed Registry bootstrap registration request. */
// eslint-disable-next-line @typescript-eslint/naming-convention -- Effect Schemas share the public domain name they decode.
export const RegistryRegisterRequest = exactStruct({
  operationId: OperationId,
  principalId: PrincipalId,
  agentName: AgentName,
  publicKey: Ed25519PublicKey,
}).annotations({ identifier: "RegistryRegisterRequest" });
/** Validated Registry bootstrap registration request. */
// eslint-disable-next-line @typescript-eslint/no-redeclare -- The same-named Schema and type form one boundary model.
export type RegistryRegisterRequest = typeof RegistryRegisterRequest.Type;

/** Closed Registry lookup selector. */
// eslint-disable-next-line @typescript-eslint/naming-convention -- Effect Schemas share the public domain name they decode.
export const RegistryLookupRequest = Schema.Union(
  exactStruct({
    agentId: Schema.propertySignature(AgentId).annotations({
      description:
        "Look up this Registry-minted agent identity (agt_ plus canonical base64url for 16 bytes); use alone.",
    }),
  }),
  exactStruct({
    agentName: Schema.propertySignature(AgentName).annotations({
      description:
        "Look up this immutable Registry-wide agent handle; use alone.",
    }),
  }),
).annotations({
  identifier: "RegistryLookupRequest",
  parseOptions: exactParseOptions,
});
/** Validated Registry lookup selector. */
// eslint-disable-next-line @typescript-eslint/no-redeclare -- The same-named Schema and type form one boundary model.
export type RegistryLookupRequest = typeof RegistryLookupRequest.Type;

/** Name, key and idempotency conflicts are results; authentication and transport failures remain errors. */
export type RegistryRegisterResult =
  | Readonly<{ kind: "registered"; agentCard: VerifiedAgentCard }>
  | Readonly<{ kind: "name_taken" }>
  | Readonly<{ kind: "key_already_registered" }>
  | Readonly<{ kind: "idempotency_conflict" }>;

/** A found card is Registry-verified. A missing identity is a normal result. */
export type RegistryLookupResult =
  | Readonly<{ kind: "found"; agentCard: VerifiedAgentCard }>
  | Readonly<{ kind: "not_found" }>;

/** The admission credential authorizes registration, and the signing authority proves possession of the agent key. */
export type RegistryRegisterCall = Readonly<{
  request: RegistryRegisterRequest;
  admissionCredential: Redacted.Redacted;
  signingAuthority: AgentSigningAuthority;
}>;

/** A request failed to complete or returned an invalid response. */
type RegistryClientError =
  | RegistryConnectionError
  | RegistryRequestTimeoutError
  | RegistryInvalidResponseError;

/** Server failures from unauthenticated identity lookup. */
export type RegistryPublicReadError = Exclude<
  HttpEnvelopeError,
  { readonly _tag: "AuthenticationFailedError" }
>;

/** Registration and lookup return cards verified against the configured Registry signing key. */
export interface RegistryClientService {
  readonly register: (
    input: RegistryRegisterCall,
  ) => Effect.Effect<
    RegistryRegisterResult,
    HttpEnvelopeError | RegistryClientError | AgentSigningError
  >;
  readonly lookup: (
    request: RegistryLookupRequest,
  ) => Effect.Effect<
    RegistryLookupResult,
    RegistryPublicReadError | RegistryClientError
  >;
}

/** Validated registration outcomes shared through registryContract. */
const registerResultSchema = Schema.Union(
  exactStruct({
    kind: Schema.Literal("registered"),
    agentCard: verifiedAgentCardSchema,
  }),
  exactStruct({ kind: Schema.Literal("name_taken") }),
  exactStruct({ kind: Schema.Literal("key_already_registered") }),
  exactStruct({ kind: Schema.Literal("idempotency_conflict") }),
);

/** Validated lookup outcomes shared through registryContract. */
const lookupResultSchema = Schema.Union(
  exactStruct({
    kind: Schema.Literal("found"),
    agentCard: verifiedAgentCardSchema,
  }),
  exactStruct({ kind: Schema.Literal("not_found") }),
);

/** Exact registration response representation used by both HTTP adapters. */
// eslint-disable-next-line agent-code-guard/no-exported-brand-constructor -- Private HTTP and storage adapters share this Schema; the package root does not export it.
export const registerResponseSchema = Schema.Union(
  exactStruct({
    kind: Schema.Literal("registered"),
    agentCard: AgentCard,
  }),
  exactStruct({ kind: Schema.Literal("name_taken") }),
  exactStruct({ kind: Schema.Literal("key_already_registered") }),
  exactStruct({ kind: Schema.Literal("idempotency_conflict") }),
);

/** Exact lookup response representation used by both HTTP adapters. */
// eslint-disable-next-line agent-code-guard/no-exported-brand-constructor -- Private HTTP adapters share this Schema; the package root does not export it.
export const lookupResponseSchema = Schema.Union(
  exactStruct({
    kind: Schema.Literal("found"),
    agentCard: AgentCard,
  }),
  exactStruct({ kind: Schema.Literal("not_found") }),
);

/** Exact bootstrap registration HTTP body. */
const registrationBody = exactStruct({
  request: RegistryRegisterRequest,
});

/** Exact bootstrap registration request path. */
export const REGISTER_PATH = "/v1/identities:register";
/** Exact public lookup request path. */
export const LOOKUP_PATH = "/v1/identities:lookup";
/** Exact Registry readiness path. */
const HEALTH_PATH = "/healthz";

/** Effect Router patterns escape the literal colon in Registry paths. */
const REGISTER_ROUTE = "/v1/identities::register";
/** Effect Router pattern for the literal lookup path. */
const LOOKUP_ROUTE = "/v1/identities::lookup";
/** Exact paths used to classify method mismatches at the fallback route. */
const KNOWN_PATHS = new Set([REGISTER_PATH, LOOKUP_PATH, HEALTH_PATH]);

const maximumIdentifier = "agt_AAAAAAAAAAAAAAAAAAAAAA";
const maximumOperationId = "opn_AAAAAAAAAAAAAAAAAAAAAA";
const maximumPrincipalId = "prn_AAAAAAAAAAAAAAAAAAAAAA";
const maximumName = "a".repeat(32);
const maximumCoordinate = "A".repeat(43);
const byteLength = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;

/** Derived exact maximum bootstrap registration body size. */
const REGISTER_BODY_CAP = byteLength({
  request: {
    operationId: maximumOperationId,
    principalId: maximumPrincipalId,
    agentName: maximumName,
    publicKey: {
      crv: "Ed25519",
      kty: "OKP",
      x: maximumCoordinate,
    },
  },
});

/** Derived exact maximum public lookup body size. */
const LOOKUP_BODY_CAP = Math.max(
  byteLength({ agentId: maximumIdentifier }),
  byteLength({ agentName: maximumName }),
);

/** Registration body, durable operation identity, and response share exact codecs. */
export const registryRegisterCodec = {
  request: { encode: canonicalCodec(RegistryRegisterRequest).encode },
  body: { encode: canonicalCodec(registrationBody).encode },
  response: canonicalCodec(registerResponseSchema),
};

/** Public lookup bytes use the same closed representations on both HTTP sides. */
export const registryLookupCodec = {
  request: canonicalCodec(RegistryLookupRequest),
  response: canonicalCodec(lookupResponseSchema),
};

/** Stored cards retain their complete canonical signed representation. */
const registryAgentCardCodec = canonicalCodec(AgentCard);

function canonicalCodec<A, I>(schema: Schema.Schema<A, I>) {
  return {
    encode: (value: A) =>
      Schema.encode(schema)(value).pipe(Effect.flatMap(encodeCanonicalJson)),
    decode: (bytes: Uint8Array) => decodeCanonicalJson(schema, bytes),
  };
}

/** Registry HTTP adapters and persistence share these exact routes, bounds, request and result schemas, and canonical codecs. */
export const registryContract = Object.freeze({
  HEALTH_PATH,
  KNOWN_PATHS,
  LOOKUP_BODY_CAP,
  LOOKUP_PATH,
  LOOKUP_ROUTE,
  lookupResultSchema,
  OperationId,
  REGISTER_BODY_CAP,
  REGISTER_PATH,
  REGISTER_ROUTE,
  registerResultSchema,
  registrationBody,
  registryAgentCardCodec,
  registryLookupCodec,
  RegistryLookupRequest,
  registryRegisterCodec,
  RegistryRegisterRequest,
});
