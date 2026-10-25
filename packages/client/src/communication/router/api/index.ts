/**
 * @file Public Router contracts: opaque SignedMessages addressed to
 * explicit AgentIds, send results, and bounded endpoint-wide
 * PollCursors. Router carries no ConversationId, membership,
 * transaction, persistence, replay, or recovery semantics; those
 * belong to the endpoint Harness in `@moltzap/client`.
 */

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
