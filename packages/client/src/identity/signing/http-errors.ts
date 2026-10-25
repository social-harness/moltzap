/** @file Closed HTTP envelope failures and their exact response projections. */

import { Schema } from "effect";
import { LIVE_WIRE_VERSIONS, WIRE_VERSION_PATTERN } from "../wire-version.js";

/** The request representation is not valid for the selected operation. */
export class MalformedRequestError extends Schema.TaggedError<MalformedRequestError>()(
  "MalformedRequestError",
  {},
) {}

/** The request does not prove the required identity or admission authority. */
export class AuthenticationFailedError extends Schema.TaggedError<AuthenticationFailedError>()(
  "AuthenticationFailedError",
  {},
) {}

/** No exact HTTP route owns the request target. */
export class RouteNotFoundError extends Schema.TaggedError<RouteNotFoundError>()(
  "RouteNotFoundError",
  {},
) {}

/** The selected route does not accept the request method. */
export class MethodNotAllowedError extends Schema.TaggedError<MethodNotAllowedError>()(
  "MethodNotAllowedError",
  {},
) {}

/** The request carries a different wire compatibility value. */
export class VersionMismatchError extends Schema.TaggedError<VersionMismatchError>()(
  "VersionMismatchError",
  {
    supported: Schema.optionalWith(Schema.Array(Schema.String), {
      default: () => LIVE_WIRE_VERSIONS,
    }),
  },
) {
  /** A mismatch response advertises at least one calendar wire version. */
  static readonly supportedSchema = Schema.NonEmptyArray(
    Schema.String.pipe(Schema.pattern(WIRE_VERSION_PATTERN)),
  );
}

/** The received body exceeds the selected route's derived representation cap. */
export class PayloadTooLargeError extends Schema.TaggedError<PayloadTooLargeError>()(
  "PayloadTooLargeError",
  {},
) {}

/** The selected route cannot consume the request content framing. */
export class UnsupportedMediaTypeError extends Schema.TaggedError<UnsupportedMediaTypeError>()(
  "UnsupportedMediaTypeError",
  {},
) {}

/** A finite immediate resource permit is unavailable. */
export class OverloadedError extends Schema.TaggedError<OverloadedError>()(
  "OverloadedError",
  {},
) {}

/** A required service or durable operation cannot currently complete. */
export class UnavailableError extends Schema.TaggedError<UnavailableError>()(
  "UnavailableError",
  {},
) {}

/** An unexpected implementation failure prevented a closed result. */
export class InternalServerError extends Schema.TaggedError<InternalServerError>()(
  "InternalServerError",
  {},
) {}

/** Closed failures represented by the shared HTTP error envelope. */
export type HttpEnvelopeError =
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

/** Service adapters construct and decode the same closed HTTP envelope failures as their clients. */
export const httpErrors = Object.freeze({
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
});
