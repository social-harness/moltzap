/** @file Identity request authentication and immutable Registry resolution for communication. */

/** Registered requests resolve immutable cards through the Registry capability. */
export { AuthenticatedHttp } from "./request-authentication.js";
/** Signature proofs remain typed inside authenticated service admission. */
export { AgentSigningError } from "./signing/http-signature.js";
/** Immutable resolution supplies pinned cards to communication workers. */
export { Registry } from "./registry/index.js";
/** Request refusals retain distinct authentication, framing, and availability channels. */
export {
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
} from "./signing/http-errors.js";
