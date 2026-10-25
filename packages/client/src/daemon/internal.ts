/**
 * @file Identity capabilities reserved for workspace service compositions.
 * @internal
 */

import { Effect, Schema } from "effect";
import { GeneralSign } from "jose";
import type { AgentId, AgentName, PrincipalId } from "../identity/agents.js";
import { encodeCanonicalJson } from "../encoding/canonical-json.js";
import {
  AgentCard,
  agentCardIssuedAtSchema,
  AgentCardVerificationError,
} from "../identity/cards.js";
import {
  AgentSigningAuthority,
  agentSigningPrivateKey,
  type Ed25519PublicKey,
  ed25519PublicKeyThumbprintUri,
} from "../identity/keys.js";
import { AGENT_CARD_TYPE } from "../identity/wire-version.js";

/** Closed Registry wire grammar shared by client encoding and service admission. */
export {
  HEALTH_PATH,
  KNOWN_PATHS,
  LIST_BODY_CAP,
  LIST_PATH,
  LIST_ROUTE,
  listResultSchema,
  LOOKUP_BODY_CAP,
  LOOKUP_PATH,
  LOOKUP_ROUTE,
  lookupResultSchema,
  REGISTER_BODY_CAP,
  REGISTER_PATH,
  REGISTER_ROUTE,
  registerResultSchema,
  registrationBody,
  registryAgentCardCodec,
  registryListCodec,
  registryLookupCodec,
  registryRegisterCodec,
} from "../identity/registry/contract.js";
/** Bootstrap verification keeps private signature proofs inside service admission. */
export {
  type VerifiedHttpSignature,
  verifyBootstrapRequest,
} from "../identity/signing/http-signature.js";

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

/** Registry client operation values and failures shared by services. */
export {
  PollCursor,
  RouterInstanceId,
  SignedMessageDigest,
} from "../communication/router/api/contract.js";
/** Closed operation Schemas and their decoded domain types. */
export {
  RouterPollRequest,
  RouterPollResult,
  RouterSendRequest,
  RouterSendResult,
} from "../communication/router/api/contract.js";
/** Public Router client capability. */
export { Router } from "../communication/router/api/client.js";
/** Route refusals and transport failures retain separate typed channels. */
export {
  RouterConnectionError,
  RouterInvalidResponseError,
  RouterRequestTimeoutError,
} from "../communication/router/api/contract.js";

/** Registry client construction remains outside host acquisition. */
export {
  OperationId,
  RegistryConnectionError,
  RegistryInvalidResponseError,
  RegistryListRequest,
  type RegistryListResult,
  RegistryLookupRequest,
  type RegistryLookupResult,
  RegistryRegisterRequest,
  type RegistryRegisterResult,
  RegistryRequestTimeoutError,
} from "../identity/registry/contract.js";
/** Immutable resolution and registration require only an injected HTTP client. */
export { Registry } from "../identity/registry/index.js";

/** Exact Router wire admission and response codecs. */
export {
  calculateRouterRepresentationLimits,
  encodedPollCursorProtectedHeader,
  isCanonicalRouterJson,
  maximumPollCursorLength,
  pollCursorEncodedLength,
  pollCursorPrefix,
  pollCursorProtectedHeader,
  RawRouterSendRequest,
  type RouterClientError,
  routerHealthPath,
  type RouterHttpEnvelopeError,
  routerHttpErrorEnvelope,
  routerHttpErrorFromResponse,
  routerInstanceIdByteLength,
  routerJsonContentType,
  routerPollPath,
  routerPollRoutePattern,
  RouterRepresentationLengthError,
  routerRepresentationLimits,
  type RouterRepresentationLimits,
  routerSendPath,
  routerSendRoutePattern,
} from "../communication/router/api/contract.js";
