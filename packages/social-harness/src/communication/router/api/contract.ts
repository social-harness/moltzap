/** @file Closed Router wire values, requests, results, bounds, and client failures. */
import canonicalize from "canonicalize";
import { Data, Effect, Either, Encoding, Option, Schema } from "effect";
import { AgentId } from "../../../identity/agents.js";
import {
  type AgentSigningError,
  AuthenticationFailedError,
  InternalServerError,
  MalformedRequestError,
  MethodNotAllowedError,
  OverloadedError,
  PayloadTooLargeError,
  RouteNotFoundError,
  UnavailableError,
  UnsupportedMediaTypeError,
  VersionMismatchError,
} from "../../../identity/index.js";
import { LIVE_WIRE_VERSIONS } from "../../../identity/wire-version.js";
import { SignedMessage } from "../../envelope/signed-message.js";

/** Exact Router send target. */
export const routerSendPath = "/v1/messages:send";
/** Exact Router poll target. */
export const routerPollPath = "/v1/messages:poll";
/** Exact Router health target. */
const routerHealthPath = "/healthz";

/** Effect HTTP Router pattern for the exact send target. */
const routerSendRoutePattern = "/v1/messages::send";
/** Effect HTTP Router pattern for the exact poll target. */
const routerPollRoutePattern = "/v1/messages::poll";

/** Exact media type for Router-owned JSON representations. */
export const routerJsonContentType = "application/json";

const INSTANCE_BYTE_LENGTH = 16;
const DIGEST_BYTE_LENGTH = 32;
/** Exact protected header carried by every PollCursor. */
const pollCursorProtectedHeader = Object.freeze({
  alg: "dir" as const,
  enc: "A256GCM" as const,
  typ: "application/vnd.sharness.poll-cursor+jwe",
});

/** The fixed string fields are declared in canonical key order. */
const pollCursorProtectedHeaderJson = JSON.stringify(pollCursorProtectedHeader);

/** Canonical encoded protected header carried by every PollCursor. */
const encodedPollCursorProtectedHeader = Encoding.encodeBase64Url(
  new TextEncoder().encode(pollCursorProtectedHeaderJson),
);

/** Prefix separating PollCursor values from unrefined compact JWE text. */
const pollCursorPrefix = "plc_";

/* eslint-disable @typescript-eslint/naming-convention, @typescript-eslint/no-redeclare --
 * Named Effect Schemas share their domain names with the types they decode.
 */

/** Identifies one volatile Router process instance. */
export const RouterInstanceId = canonicalValue(
  "RouterInstanceId",
  "rti_",
  INSTANCE_BYTE_LENGTH,
);
/**
 * Validated Router process identity.
 * @useDeclaredType
 */
export type RouterInstanceId = typeof RouterInstanceId.Type;

/** Equality receipt for one complete retained SignedMessage. */
export const SignedMessageDigest = canonicalValue(
  "SignedMessageDigest",
  "smd_",
  DIGEST_BYTE_LENGTH,
);
/**
 * Validated SignedMessage equality receipt.
 * @useDeclaredType
 */
export type SignedMessageDigest = typeof SignedMessageDigest.Type;

/** Opaque, authenticated continuation for one caller and Router instance. */
export const PollCursor = Schema.String.pipe(
  Schema.filter(hasCanonicalCursorShape, {
    identifier: "PollCursor",
    description: "Canonical opaque Router poll continuation",
  }),
  Schema.brand("PollCursor"),
  Schema.annotations({
    identifier: "PollCursor",
    description: "Canonical opaque Router poll continuation",
  }),
);
/**
 * Validated opaque Router poll continuation.
 * @useDeclaredType
 */
export type PollCursor = typeof PollCursor.Type;

const exact = {
  exact: true,
  onExcessProperty: "error" as const,
};

const closedStruct = <Fields extends Schema.Struct.Fields>(fields: Fields) =>
  Schema.Struct(fields).annotations({ parseOptions: exact });

/** Exact private send shape that preserves instance-fence precedence. */
const RawRouterSendRequest = closedStruct({
  expectedRouterInstanceId: RouterInstanceId,
  mode: Schema.Literal("initial", "retry"),
  signedMessage: Schema.Unknown,
}).annotations({ identifier: "RawRouterSendRequest" });
/** Private send shape before the identity-owned artifact is decoded. */
type RawRouterSendRequest = typeof RawRouterSendRequest.Type;

const sendRequest = closedStruct({
  expectedRouterInstanceId: RouterInstanceId,
  mode: Schema.Literal("initial", "retry"),
  signedMessage: SignedMessage.live,
}).annotations({ identifier: "RouterSendRequest" });

/** Exact Schema for one send request. */
export const RouterSendRequest: Schema.Schema<
  RouterSendRequest,
  typeof sendRequest.Encoded
> = sendRequest;
/**
 * The observed Router instance fences a send across restarts. A retry retains
 * the original SignedMessage bytes and never appends another feed entry.
 * @useDeclaredType
 */
export type RouterSendRequest = typeof sendRequest.Type;

const accepted = closedStruct({
  kind: Schema.Literal("accepted"),
  routerInstanceId: RouterInstanceId,
  signedMessageDigest: SignedMessageDigest,
});
const routerRestarted = closedStruct({
  kind: Schema.Literal("router_restarted"),
  routerInstanceId: RouterInstanceId,
});
const messageInvalid = closedStruct({
  kind: Schema.Literal("message_invalid"),
});
const idempotencyConflict = closedStruct({
  kind: Schema.Literal("idempotency_conflict"),
});
const retryIdentityUnknown = closedStruct({
  kind: Schema.Literal("retry_identity_unknown"),
});

const sendResult = Schema.Union(
  accepted,
  routerRestarted,
  messageInvalid,
  idempotencyConflict,
  retryIdentityUnknown,
).annotations({ identifier: "RouterSendResult" });

/** Exact Schema for every closed send outcome. */
export const RouterSendResult: Schema.Schema<
  RouterSendResult,
  typeof sendResult.Encoded
> = sendResult;
/**
 * `accepted` permits checking equality with the retained message, but proves
 * no delivery or durability. `router_restarted` fences old-instance sends.
 * A retained identity conflicts with `initial`; `retry` conflicts only when
 * its bytes differ, and reports `retry_identity_unknown` after eviction.
 * @useDeclaredType
 */
export type RouterSendResult = typeof sendResult.Type;

const pollRequest = closedStruct({
  pollCursor: Schema.optionalWith(PollCursor, { exact: true }),
}).annotations({ identifier: "RouterPollRequest" });

/** Exact Schema for one endpoint-wide poll request. */
export const RouterPollRequest: Schema.Schema<
  RouterPollRequest,
  typeof pollRequest.Encoded
> = pollRequest;
/**
 * Omitting the cursor starts at the current tail without replaying retained messages.
 * @useDeclaredType
 */
export type RouterPollRequest = typeof pollRequest.Type;

const batch = closedStruct({
  kind: Schema.Literal("batch"),
  routerInstanceId: RouterInstanceId,
  signedMessages: Schema.Array(SignedMessage.live),
  pollCursor: PollCursor,
});
const feedGap = closedStruct({
  kind: Schema.Literal("feed_gap"),
  routerInstanceId: RouterInstanceId,
});
const cursorInvalid = closedStruct({
  kind: Schema.Literal("cursor_invalid"),
});

const pollResult = Schema.Union(batch, feedGap, cursorInvalid).annotations({
  identifier: "RouterPollResult",
});

/** Exact Schema for every closed poll outcome. */
export const RouterPollResult: Schema.Schema<
  RouterPollResult,
  typeof pollResult.Encoded
> = pollResult;
/**
 * A batch's messages remain unverified until the endpoint checks them all.
 * Accept its cursor only after those checks. `feed_gap` has no partial batch;
 * `cursor_invalid` reveals no Router instance.
 * @useDeclaredType
 */
export type RouterPollResult = typeof pollResult.Type;

/* eslint-enable @typescript-eslint/naming-convention, @typescript-eslint/no-redeclare -- restore the shared project rules */

/** The Router connection could not be established or used. */
export class RouterConnectionError extends Data.TaggedError(
  "RouterConnectionError",
) {}

/** The configured complete Router call deadline expired. */
export class RouterRequestTimeoutError extends Data.TaggedError(
  "RouterRequestTimeoutError",
) {}

/** A Router response did not match the selected operation contract. */
export class RouterInvalidResponseError extends Data.TaggedError(
  "RouterInvalidResponseError",
) {}

/**
 * Closed failures represented by Router HTTP error envelopes.
 * @inline
 */
export type RouterHttpEnvelopeError =
  | MalformedRequestError
  | AuthenticationFailedError
  | RouteNotFoundError
  | MethodNotAllowedError
  | VersionMismatchError
  | PayloadTooLargeError
  | UnsupportedMediaTypeError
  | OverloadedError
  | UnavailableError
  | InternalServerError;

/**
 * Request failures are distinct from the closed send and poll result values.
 * @inline
 */
export type RouterClientError =
  | RouterHttpEnvelopeError
  | RouterConnectionError
  | RouterRequestTimeoutError
  | RouterInvalidResponseError
  | AgentSigningError;

interface RouterHttpErrorRepresentation {
  readonly status: number;
  readonly body: string;
  readonly make: () => RouterHttpEnvelopeError;
}

const routerHttpErrors = Object.freeze({
  MalformedRequestError: {
    status: 400,
    body: '{"error":"malformed"}',
    make: () => new MalformedRequestError(),
  },
  AuthenticationFailedError: {
    status: 401,
    body: '{"error":"authentication_failed"}',
    make: () => new AuthenticationFailedError(),
  },
  RouteNotFoundError: {
    status: 404,
    body: '{"error":"not_found"}',
    make: () => new RouteNotFoundError(),
  },
  MethodNotAllowedError: {
    status: 405,
    body: '{"error":"method_not_allowed"}',
    make: () => new MethodNotAllowedError(),
  },
  VersionMismatchError: {
    status: 412,
    body: JSON.stringify({
      error: "version_mismatch",
      supported: LIVE_WIRE_VERSIONS,
    }),
    make: () => new VersionMismatchError(),
  },
  PayloadTooLargeError: {
    status: 413,
    body: '{"error":"payload_too_large"}',
    make: () => new PayloadTooLargeError(),
  },
  UnsupportedMediaTypeError: {
    status: 415,
    body: '{"error":"unsupported_media_type"}',
    make: () => new UnsupportedMediaTypeError(),
  },
  OverloadedError: {
    status: 429,
    body: '{"error":"overloaded"}',
    make: () => new OverloadedError(),
  },
  UnavailableError: {
    status: 503,
    body: '{"error":"unavailable"}',
    make: () => new UnavailableError(),
  },
  InternalServerError: {
    status: 500,
    body: '{"error":"internal"}',
    make: () => new InternalServerError(),
  },
} satisfies Readonly<
  Record<RouterHttpEnvelopeError["_tag"], RouterHttpErrorRepresentation>
>);

const isRouterHttpErrorTag = (
  tag: string,
): tag is keyof typeof routerHttpErrors => Object.hasOwn(routerHttpErrors, tag);

/**
 * Finds the exact status and body for one recognized Router failure tag.
 *
 * @param tag Candidate typed failure tag.
 * @returns Its exact envelope or `undefined` when the tag is not recognized.
 */
const routerHttpErrorEnvelope = (
  tag: string,
): Readonly<{ status: number; body: string }> | undefined =>
  isRouterHttpErrorTag(tag) ? routerHttpErrors[tag] : undefined;

/** Whether text is the JCS encoding of encoded. */
export const isCanonicalRouterJson = (
  text: string,
  encoded: unknown,
): boolean => {
  const canonical = canonicalize(encoded);
  return canonical !== undefined && text === canonical;
};

/**
 * Decodes one exact status and body pair into its typed Router failure.
 *
 * @param status Candidate HTTP status.
 * @param body Candidate exact body text.
 * @returns The matching typed failure, when the pair is declared.
 */
export const routerHttpErrorFromResponse = (
  status: number,
  body: string,
): Option.Option<RouterHttpEnvelopeError> => {
  if (status === 412) {
    return Schema.decodeUnknownOption(
      Schema.parseJson(
        closedStruct({
          error: Schema.Literal("version_mismatch"),
          supported: VersionMismatchError.supportedSchema,
        }),
      ),
    )(body).pipe(
      Option.filter((value) => isCanonicalRouterJson(body, value)),
      Option.map(({ supported }) => new VersionMismatchError({ supported })),
    );
  }
  const representation = Object.values(routerHttpErrors).find(
    (candidate) => candidate.status === status && candidate.body === body,
  );
  return representation === undefined
    ? Option.none()
    : Option.some(representation.make());
};

/** A Router enclosing representation cannot be measured safely. */
class RouterRepresentationLengthError extends Data.TaggedError(
  "RouterRepresentationLengthError",
) {}

/** Exact maxima for the Router-owned enclosing representations. */
interface RouterRepresentationLimits {
  readonly sendRequestBodyBytes: number;
  readonly pollRequestBodyBytes: number;
  readonly oneMessageBatchBytes: number;
}

const utf8Encoder = new TextEncoder();
const signedMessagePlaceholder = "__signed_message__";
const signedMessagePlaceholderByteLength = utf8Encoder.encode(
  JSON.stringify(signedMessagePlaceholder),
).byteLength;
const maximumAgentId = "agt_AAAAAAAAAAAAAAAAAAAAAA";
const maximumRouterInstanceId = "rti_AAAAAAAAAAAAAAAAAAAAAA";

/**
 * Computes exact cursor length for a caller, instance, and order width.
 *
 * @param input Plaintext cursor members.
 * @param input.agentId Caller bound into the encrypted continuation.
 * @param input.routerInstanceId Process bound into the continuation.
 * @param input.lastScannedOrder Private order bound into the continuation.
 * @returns The complete prefixed Compact JWE length.
 */
const pollCursorEncodedLength = (input: {
  readonly agentId: AgentId;
  readonly routerInstanceId: RouterInstanceId;
  readonly lastScannedOrder: bigint;
}): number => {
  const plaintext = canonicalize({
    agentId: input.agentId,
    routerInstanceId: input.routerInstanceId,
    lastScannedOrder: input.lastScannedOrder.toString(10),
  });
  if (plaintext === undefined) {
    return Number.POSITIVE_INFINITY;
  }
  const plaintextLength = utf8Encoder.encode(plaintext).byteLength;
  return (
    pollCursorPrefix.length +
    encodedPollCursorProtectedHeader.length +
    1 +
    1 +
    16 +
    1 +
    base64UrlLength(plaintextLength) +
    1 +
    22
  );
};

/** Maximum ASCII characters in a valid PollCursor. */
const maximumPollCursorLength = pollCursorEncodedLength({
  agentId: Schema.decodeUnknownSync(AgentId)(maximumAgentId),
  routerInstanceId: Schema.decodeUnknownSync(RouterInstanceId)(
    maximumRouterInstanceId,
  ),
  lastScannedOrder: (1n << 128n) - 1n,
});

function base64UrlLength(byteLength: number): number {
  return Math.ceil((byteLength * 8) / 6);
}

const canonicalByteLength = (
  value: unknown,
): Effect.Effect<number, RouterRepresentationLengthError> => {
  const encoded = canonicalize(value);
  if (encoded === undefined) {
    return Effect.fail(new RouterRepresentationLengthError());
  }
  return Effect.succeed(utf8Encoder.encode(encoded).byteLength);
};

const supportedLength = (value: number): boolean =>
  Number.isSafeInteger(value) && value >= 0;

const checkedAdd = (
  left: number,
  right: number,
): Effect.Effect<number, RouterRepresentationLengthError> => {
  const result = left + right;
  if (
    !supportedLength(left) ||
    !supportedLength(right) ||
    !supportedLength(result)
  ) {
    return Effect.fail(new RouterRepresentationLengthError());
  }
  return Effect.succeed(result);
};

const maximumSendBody = {
  callerAgentId: maximumAgentId,
  request: {
    expectedRouterInstanceId: maximumRouterInstanceId,
    mode: "initial",
    signedMessage: signedMessagePlaceholder,
  },
};
const maximumPollBody = {
  callerAgentId: maximumAgentId,
  request: {
    pollCursor: "A".repeat(maximumPollCursorLength),
  },
};
const maximumOneMessageBatch = {
  kind: "batch",
  pollCursor: "A".repeat(maximumPollCursorLength),
  routerInstanceId: maximumRouterInstanceId,
  signedMessages: [signedMessagePlaceholder],
};

/**
 * Calculates exact enclosing limits while treating SignedMessage as an
 * identity-owned byte sequence.
 *
 * @param maximumSignedMessageByteLength Identity-owned complete message limit.
 * @returns Exact maximum Router request and one-message result byte lengths.
 */
const calculateRouterRepresentationLimits = (
  maximumSignedMessageByteLength: number,
): Effect.Effect<RouterRepresentationLimits, RouterRepresentationLengthError> =>
  Effect.gen(function* () {
    const sendTemplateBytes = yield* canonicalByteLength(maximumSendBody);
    const pollRequestBodyBytes = yield* canonicalByteLength(maximumPollBody);
    const batchTemplateBytes = yield* canonicalByteLength(
      maximumOneMessageBatch,
    );
    const sendFixedBytes =
      sendTemplateBytes - signedMessagePlaceholderByteLength;
    const batchFixedBytes =
      batchTemplateBytes - signedMessagePlaceholderByteLength;
    return Object.freeze({
      sendRequestBodyBytes: yield* checkedAdd(
        sendFixedBytes,
        maximumSignedMessageByteLength,
      ),
      pollRequestBodyBytes,
      oneMessageBatchBytes: yield* checkedAdd(
        batchFixedBytes,
        maximumSignedMessageByteLength,
      ),
    });
  }).pipe(Effect.withSpan("calculateRouterRepresentationLimits"));

/** Exact limits derived from the current closed Router representations. */
const routerRepresentationLimits = Effect.runSync(
  calculateRouterRepresentationLimits(SignedMessage.maximumEncodedByteLength),
);

interface CursorSegments {
  readonly encodedHeader: string;
  readonly encryptedKey: string;
  readonly iv: string;
  readonly ciphertext: string;
  readonly tag: string;
}

const cursorSegmentsPattern = new RegExp(
  `^(?=[\\s\\S]{0,${maximumPollCursorLength}}$)${pollCursorPrefix}([^.]*?)\\.([^.]*?)\\.([^.]*?)\\.([^.]*?)\\.([^.]*?)$`,
);

function hasCanonicalCursorShape(value: string): boolean {
  const segments = extractCursorSegments(value);
  if (segments === undefined || segments.encryptedKey !== "") {
    return false;
  }
  if (
    segments.encodedHeader !== encodedPollCursorProtectedHeader ||
    !hasCanonicalBase64UrlLength(segments.iv, 12)
  ) {
    return false;
  }
  return (
    hasCanonicalBase64UrlLength(segments.tag, 16) &&
    hasCanonicalCiphertext(segments.ciphertext)
  );
}

function extractCursorSegments(value: string): CursorSegments | undefined {
  const match = cursorSegmentsPattern.exec(value);
  let result: CursorSegments | undefined;
  if (match !== null) {
    result = {
      encodedHeader: segmentAt(match, 1),
      encryptedKey: segmentAt(match, 2),
      iv: segmentAt(match, 3),
      ciphertext: segmentAt(match, 4),
      tag: segmentAt(match, 5),
    };
  }
  return result;
}

function segmentAt(segments: readonly string[], index: number): string {
  return segments[index] ?? "";
}

function hasCanonicalBase64UrlLength(
  value: string,
  byteLength: number,
): boolean {
  return Either.match(Encoding.decodeBase64Url(value), {
    onLeft: () => false,
    onRight: (decoded) =>
      decoded.byteLength === byteLength &&
      Encoding.encodeBase64Url(decoded) === value,
  });
}

function hasCanonicalCiphertext(ciphertext: string): boolean {
  return Either.match(Encoding.decodeBase64Url(ciphertext), {
    onLeft: () => false,
    onRight: (decoded) =>
      decoded.byteLength > 0 &&
      Encoding.encodeBase64Url(decoded) === ciphertext,
  });
}

function canonicalValue<const Name extends string>(
  name: Name,
  prefix: string,
  byteLength: number,
) {
  return Schema.String.pipe(
    Schema.filter(
      (value) => {
        return (
          value.startsWith(prefix) &&
          hasCanonicalBase64UrlLength(value.slice(prefix.length), byteLength)
        );
      },
      {
        identifier: name,
        description: `${name} canonical representation`,
      },
    ),
    Schema.brand(name),
    Schema.annotations({
      identifier: name,
      description: `${name} canonical representation`,
    }),
  );
}

/** Router processes and clients share these exact routes, representation limits, request and result schemas, cursor encodings, and HTTP error projection. */
export const routerContract = Object.freeze({
  calculateRouterRepresentationLimits,
  encodedPollCursorProtectedHeader,
  maximumPollCursorLength,
  PollCursor,
  pollCursorEncodedLength,
  pollCursorPrefix,
  pollCursorProtectedHeader,
  RawRouterSendRequest,
  routerHealthPath,
  routerHttpErrorEnvelope,
  RouterInstanceId,
  routerInstanceIdByteLength: INSTANCE_BYTE_LENGTH,
  routerJsonContentType,
  routerPollPath,
  RouterPollRequest,
  RouterPollResult,
  routerPollRoutePattern,
  routerRepresentationLimits,
  routerSendPath,
  RouterSendRequest,
  RouterSendResult,
  routerSendRoutePattern,
  SignedMessageDigest,
});
