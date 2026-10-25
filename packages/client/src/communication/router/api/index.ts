/** @file Router API domain: opaque envelopes, send and poll codecs, and HTTP client capabilities. Conversation, membership, certification and recovery semantics belong to communication/conversations. */

/** Canonical Router-owned refined values. */
export {
  PollCursor,
  RouterInstanceId,
  SignedMessageDigest,
} from "./contract.js";
/** Closed operation Schemas and their decoded domain types. */
export {
  RouterPollRequest,
  RouterPollResult,
  RouterSendRequest,
  RouterSendResult,
} from "./contract.js";
/** Public Router client capability. */
export { Router } from "./client.js";
/** Closed failures raised by the Router client transport. */
export {
  RouterConnectionError,
  RouterInvalidResponseError,
  RouterRequestTimeoutError,
} from "./contract.js";
