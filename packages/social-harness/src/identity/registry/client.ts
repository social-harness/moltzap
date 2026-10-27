/** @file Authenticated HTTP adapter behind the public Registry capability. */

import {
  HttpClient,
  HttpClientRequest,
  type HttpClientResponse,
} from "@effect/platform";
import { Duration, Effect, ParseResult, Redacted, Schema } from "effect";
import { decodeCanonicalJson } from "../../encoding/canonical-json.js";
import { AgentCard, type VerifiedAgentCard } from "../cards.js";
import {
  AgentSigningAuthority,
  type Ed25519PublicKey,
  sameEd25519PublicKey,
} from "../keys.js";
import {
  AuthenticationFailedError,
  type HttpEnvelopeError,
  InternalServerError,
  MalformedRequestError,
  MethodNotAllowedError,
  OverloadedError,
  PayloadTooLargeError,
  RouteNotFoundError,
  UnavailableError,
  UnsupportedMediaTypeError,
  VersionMismatchError,
} from "../signing/http-errors.js";
import {
  AgentSigningError,
  signHttpRequest,
} from "../signing/http-signature.js";
import { WireVersions } from "../wire-version.js";
import {
  LOOKUP_PATH,
  REGISTER_PATH,
  type RegistryClientService,
  RegistryConnectionError,
  RegistryInvalidResponseError,
  registryLookupCodec,
  RegistryLookupRequest,
  type RegistryLookupResult,
  type RegistryPublicReadError,
  type RegistryRegisterCall,
  registryRegisterCodec,
  RegistryRegisterRequest,
  type RegistryRegisterResult,
  RegistryRequestTimeoutError,
} from "./contract.js";

/**
 * Builds the service installed behind the public Registry capability.
 *
 * @param input Immutable Registry client configuration.
 * @param input.origin Registry HTTP origin.
 * @param input.registrySignerPublicKey Pinned Registry verification key.
 * @param input.requestTimeout Complete per-call deadline.
 * @returns The configured service, requiring an Effect HTTP client.
 */
export function makeRegistryService(input: {
  readonly origin: URL;
  readonly registrySignerPublicKey: Ed25519PublicKey;
  readonly requestTimeout: Duration.Duration;
}): Effect.Effect<RegistryClientService, never, HttpClient.HttpClient> {
  const origin = new URL(input.origin.href);
  const requestTimeout = Duration.millis(
    Duration.toMillis(input.requestTimeout),
  );
  return Effect.map(
    HttpClient.HttpClient,
    (client): RegistryClientService => ({
      register: makeRegister({
        client,
        origin,
        registrySignerPublicKey: input.registrySignerPublicKey,
        requestTimeout,
      }),
      lookup: makeLookup({
        client,
        origin,
        registrySignerPublicKey: input.registrySignerPublicKey,
        requestTimeout,
      }),
    }),
  );
}

type ErrorEnvelope = Readonly<{
  body: string;
  make: () => HttpEnvelopeError;
}>;

const errorEnvelope = new Map<number, ErrorEnvelope>([
  [
    400,
    { body: '{"error":"malformed"}', make: () => new MalformedRequestError() },
  ],
  [
    401,
    {
      body: '{"error":"authentication_failed"}',
      make: () => new AuthenticationFailedError(),
    },
  ],
  [
    404,
    { body: '{"error":"not_found"}', make: () => new RouteNotFoundError() },
  ],
  [
    405,
    {
      body: '{"error":"method_not_allowed"}',
      make: () => new MethodNotAllowedError(),
    },
  ],
  [
    413,
    {
      body: '{"error":"payload_too_large"}',
      make: () => new PayloadTooLargeError(),
    },
  ],
  [
    415,
    {
      body: '{"error":"unsupported_media_type"}',
      make: () => new UnsupportedMediaTypeError(),
    },
  ],
  [429, { body: '{"error":"overloaded"}', make: () => new OverloadedError() }],
  [
    503,
    { body: '{"error":"unavailable"}', make: () => new UnavailableError() },
  ],
  [
    500,
    { body: '{"error":"internal"}', make: () => new InternalServerError() },
  ],
]);

const invalidResponse = (): RegistryInvalidResponseError =>
  new RegistryInvalidResponseError();

const textDecoder = new TextDecoder("utf-8", {
  fatal: true,
  ignoreBOM: true,
});

const exactText = (bytes: Uint8Array): string | undefined => {
  try {
    return textDecoder.decode(bytes);
    // eslint-disable-next-line agent-code-guard/bare-catch -- Invalid UTF-8 is an ordinary closed-response validation failure.
  } catch {
    return undefined;
  }
};

type ClientOperation = "register" | "lookup";
type RegistryClientInput = Readonly<{
  client: HttpClient.HttpClient;
  origin: URL;
  registrySignerPublicKey: Ed25519PublicKey;
  requestTimeout: Duration.Duration;
}>;

const operationDeclares = (
  operation: ClientOperation,
  error: HttpEnvelopeError,
): boolean =>
  operation === "register" || error._tag !== "AuthenticationFailedError";

const connectionFailure = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, RegistryConnectionError, R> =>
  effect.pipe(
    // eslint-disable-next-line agent-code-guard/no-effect-error-coalescing -- The client exposes one transport failure without leaking platform implementation details.
    Effect.mapError(() => new RegistryConnectionError()),
  );

const readResponseBytes = (
  response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<Uint8Array, RegistryConnectionError> =>
  connectionFailure(response.arrayBuffer).pipe(
    Effect.map((buffer) => new Uint8Array(buffer)),
  );

const decodeEnvelope = (
  operation: ClientOperation,
  response: HttpClientResponse.HttpClientResponse,
  bytes: Uint8Array,
): Effect.Effect<never, HttpEnvelopeError | RegistryInvalidResponseError> => {
  if (response.headers["content-type"] !== "application/json") {
    return Effect.fail(invalidResponse());
  }
  if (response.status === 412) {
    return decodeCanonicalJson(
      Schema.Struct({
        error: Schema.Literal("version_mismatch"),
        supported: VersionMismatchError.supportedSchema,
      }),
      bytes,
    ).pipe(
      Effect.mapError(invalidResponse),
      Effect.flatMap(({ supported }) =>
        Effect.fail(new VersionMismatchError({ supported })),
      ),
    );
  }
  const expected = errorEnvelope.get(response.status);
  const actual = exactText(bytes);
  if (expected === undefined || actual !== expected.body) {
    return Effect.fail(invalidResponse());
  }
  const error = expected.make();
  return operationDeclares(operation, error)
    ? Effect.fail(error)
    : Effect.fail(invalidResponse());
};

const execute = (input: {
  readonly client: HttpClient.HttpClient;
  readonly request: HttpClientRequest.HttpClientRequest;
  readonly operation: ClientOperation;
}): Effect.Effect<
  readonly [HttpClientResponse.HttpClientResponse, Uint8Array],
  RegistryConnectionError | HttpEnvelopeError | RegistryInvalidResponseError
> =>
  connectionFailure(input.client.execute(input.request)).pipe(
    Effect.flatMap((response) =>
      readResponseBytes(response).pipe(
        Effect.flatMap((bytes) =>
          response.status === 200
            ? Effect.succeed([response, bytes] as const)
            : decodeEnvelope(input.operation, response, bytes),
        ),
      ),
    ),
  );

const executePublicRead = (input: {
  readonly client: HttpClient.HttpClient;
  readonly request: HttpClientRequest.HttpClientRequest;
}) =>
  execute({ ...input, operation: "lookup" }).pipe(
    Effect.catchTag("AuthenticationFailedError", () =>
      Effect.fail(invalidResponse()),
    ),
  );

const requireJsonSuccess = (
  response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<void, RegistryInvalidResponseError> =>
  response.headers["content-type"] === "application/json"
    ? Effect.void
    : Effect.fail(invalidResponse());

/**
 * One decoded copy of a caller's request record. Schema encoding reads members
 * directly and does not catch a throwing getter, so the record is read once
 * here under a try, and every later step reads only the copy. A record the
 * Schema refuses fails as `RegistryInvalidResponseError`, as an unencodable
 * request always has; a record whose members throw fails as `unreadable`.
 */
const snapshotRequest = <A, I, E>(
  schema: Schema.Schema<A, I>,
  read: () => A,
  unreadable: () => E,
): Effect.Effect<A, E | RegistryInvalidResponseError> =>
  Effect.try({
    try: () =>
      Schema.decodeUnknownSync(schema)(Schema.encodeSync(schema)(read())),
    catch: (cause) =>
      ParseResult.isParseError(cause) ? invalidResponse() : unreadable(),
  });

const verifyCard = (
  agentCard: AgentCard,
  registrySignerPublicKey: Ed25519PublicKey,
): Effect.Effect<VerifiedAgentCard, RegistryInvalidResponseError> =>
  AgentCard.verify({ agentCard, registrySignerPublicKey }).pipe(
    Effect.mapError(invalidResponse),
  );

const withDeadline = <A, E>(
  effect: Effect.Effect<A, E>,
  timeout: Duration.Duration,
): Effect.Effect<A, E | RegistryRequestTimeoutError> =>
  effect.pipe(
    Effect.timeoutFail({
      duration: timeout,
      onTimeout: () => new RegistryRequestTimeoutError(),
    }),
  );

const makePost = (
  origin: URL,
  path: string,
  bodyBytes: Uint8Array,
  wireVersion: string,
): HttpClientRequest.HttpClientRequest =>
  HttpClientRequest.post(new URL(path, origin)).pipe(
    HttpClientRequest.bodyUint8Array(bodyBytes, "application/json"),
    HttpClientRequest.setHeader("sharness-version", wireVersion),
  );

const makeSignedRegistrationRequest = (
  input: RegistryClientInput,
  call: RegistryRegisterCall,
  registerRequest: typeof RegistryRegisterRequest.Type,
) =>
  Effect.gen(function* () {
    const sameKey = yield* sameEd25519PublicKey(
      () => AgentSigningAuthority.publicKey(call.signingAuthority),
      () => registerRequest.publicKey,
    ).pipe(
      Effect.catchTag("Ed25519PublicKeyOperationError", () =>
        Effect.fail(new AgentSigningError()),
      ),
    );
    if (!sameKey) {
      return yield* new AgentSigningError();
    }
    const bodyBytes = yield* registryRegisterCodec.body
      .encode({
        request: registerRequest,
      })
      .pipe(Effect.mapError(invalidResponse));
    const httpRequest = makePost(
      input.origin,
      REGISTER_PATH,
      bodyBytes,
      yield* WireVersions.emitted,
    ).pipe(
      HttpClientRequest.setHeader(
        "authorization",
        `Sharness-Admission ${Redacted.value(call.admissionCredential)}`,
      ),
    );
    return yield* signHttpRequest({
      httpRequest,
      bodyBytes,
      signingAuthority: call.signingAuthority,
      profile: "registration",
    });
  });

/**
 * The returned card must carry the signing authority's key, which
 * `makeSignedRegistrationRequest` already required the request's key to
 * equal. Comparing with the authority's key reads no caller-supplied key.
 */
const registrationMatchesCall = (
  agentCard: VerifiedAgentCard,
  call: RegistryRegisterCall,
  registerRequest: typeof RegistryRegisterRequest.Type,
): boolean =>
  agentCard.principalId === registerRequest.principalId &&
  agentCard.agentName === registerRequest.agentName &&
  agentCard.publicKey.x ===
    AgentSigningAuthority.publicKey(call.signingAuthority).x;

const decodeRegistrationResult = (
  input: RegistryClientInput,
  call: RegistryRegisterCall,
  registerRequest: typeof RegistryRegisterRequest.Type,
  responseBytes: Uint8Array,
): Effect.Effect<RegistryRegisterResult, RegistryInvalidResponseError> =>
  Effect.gen(function* () {
    const result = yield* registryRegisterCodec.response
      .decode(responseBytes)
      .pipe(Effect.mapError(invalidResponse));
    if (result.kind !== "registered") {
      return Object.freeze({ kind: result.kind });
    }
    const agentCard = yield* verifyCard(
      result.agentCard,
      input.registrySignerPublicKey,
    );
    if (!registrationMatchesCall(agentCard, call, registerRequest)) {
      return yield* invalidResponse();
    }
    return Object.freeze({ kind: "registered", agentCard });
  });

function makeRegister(
  input: RegistryClientInput,
): (
  call: RegistryRegisterCall,
) => Effect.Effect<
  RegistryRegisterResult,
  | HttpEnvelopeError
  | RegistryConnectionError
  | RegistryRequestTimeoutError
  | RegistryInvalidResponseError
  | AgentSigningError
> {
  return (candidate) =>
    Effect.gen(function* () {
      const call = yield* Effect.try({
        try: (): RegistryRegisterCall => {
          const { request, signingAuthority, admissionCredential } = candidate;
          return { request, signingAuthority, admissionCredential };
        },
        catch: () => new AgentSigningError(),
      });
      const registerRequest = yield* snapshotRequest(
        RegistryRegisterRequest,
        () => call.request,
        () => new AgentSigningError(),
      );
      const request = yield* makeSignedRegistrationRequest(
        input,
        call,
        registerRequest,
      );
      const [response, responseBytes] = yield* execute({
        client: input.client,
        request,
        operation: "register",
      });
      yield* requireJsonSuccess(response);
      return yield* decodeRegistrationResult(
        input,
        call,
        registerRequest,
        responseBytes,
      );
    }).pipe((effect) => withDeadline(effect, input.requestTimeout));
}

function makeLookup(
  input: RegistryClientInput,
): (
  call: typeof RegistryLookupRequest.Type,
) => Effect.Effect<
  RegistryLookupResult,
  | RegistryPublicReadError
  | RegistryConnectionError
  | RegistryRequestTimeoutError
  | RegistryInvalidResponseError
> {
  return (candidate) =>
    Effect.gen(function* () {
      const call = yield* snapshotRequest(
        RegistryLookupRequest,
        () => candidate,
        invalidResponse,
      );
      const [response, responseBytes] = yield* executePublicRead({
        client: input.client,
        request: makePost(
          input.origin,
          LOOKUP_PATH,
          yield* registryLookupCodec.request
            .encode(call)
            .pipe(Effect.mapError(invalidResponse)),
          yield* WireVersions.emitted,
        ),
      });
      yield* requireJsonSuccess(response);
      const result = yield* registryLookupCodec.response
        .decode(responseBytes)
        .pipe(Effect.mapError(invalidResponse));
      if (result.kind === "not_found") {
        return Object.freeze({ kind: "not_found" });
      }
      const agentCard = yield* verifyCard(
        result.agentCard,
        input.registrySignerPublicKey,
      );
      if (
        ("agentId" in call && agentCard.agentId !== call.agentId) ||
        ("agentName" in call && agentCard.agentName !== call.agentName)
      ) {
        return yield* invalidResponse();
      }
      return Object.freeze({ kind: "found", agentCard });
    }).pipe((effect) => withDeadline(effect, input.requestTimeout));
}
