/** @file Public barrel for the final endpoint runtime capability. */
// safer-arch-ignore no-folder-cycle: release/index.ts imports package.json for the Client release version, which places the package root below every domain that reads it, while this facade re-exports from harness/endpoint.
// safer-arch-ignore require-curated-public-facade: Each re-export names one domain's adapter-facing values; the root re-exports them from their owners instead of from a shared contract module.
// safer-arch-ignore no-large-public-surface: The root is the one adapter-facing boundary, and each operation and inbound item is a closed schema its adapters decode; splitting them behind narrower entrypoints would give adapters a second import path for one contract.

/** The endpoint capability a host acquires, and its connect and delivery types. */
export {
  ConnectError,
  type HarnessEndpoint,
  type InboundDelivery,
} from "./harness/endpoint/index.js";
/** Acquire the structural endpoint for one loopback daemon endpoint. */
// safer-arch-ignore no-public-vendor-type-leak: URL is the platform-standard endpoint locator required by the public acquisition contract.
export { acquireHarnessEndpoint } from "./harness/endpoint/index.js";
/**
 * Decoders of the daemon's MCP tool results, refusal data and
 * pending-delivery event. They ignore fields they do not name, so a newer
 * daemon can add one without breaking a host on the previous release.
 */
export {
  decodeHarnessMessageReadyEvent,
  decodeHarnessReadInboxResult,
  decodeHarnessSendErrorData,
  decodeHarnessSendResult,
} from "./harness/protocol/operations.js";
/** One line of the daemon's optional history export. */
export { HistoryExportRecord } from "./harness/inbox/history-export.js";
/** Local message refusal and advice expose no private assessment evidence. */
export {
  type CheckedGuidance,
  FirewallSendError,
  type LocalGuidance,
} from "./firewall/outcome/index.js";
/** Send input and the closed error of a refused collective send. */
export {
  CollectiveError,
  SendInput,
  type SendResult,
} from "./communication/collectives/forms.js";
/** The items an endpoint delivers to its host. */
export { InboundItem } from "./communication/collectives/inbound.js";
/** The text a host's model reads for each delivered message, question and result. */
export {
  groupMembers,
  renderCollectiveRequest,
  renderCollectiveResult,
  renderContent,
} from "./communication/collectives/render.js";
/** The operation a native host's message text states. */
export {
  MessageTextError,
  parseMessageText,
} from "./communication/collectives/message-text.js";
/** Explicit direct and group addresses. */
export {
  AgentAddress,
  GroupAddress,
  MessageAddressInput,
} from "./communication/records/values.js";
/** The closed errors of sending, listening, and acknowledging delivery. */
export {
  DeliveryAcknowledgeError,
  ListenError,
  SendError,
} from "./communication/conversations/errors.js";
/** Certified inbound messages, direct or to a fixed group. */
export {
  type DirectMessage,
  type GroupMessage,
  InboundMessage,
} from "./communication/conversations/message.js";
/** Post ids and the closed semantic content of a message. */
export {
  Content,
  ContentPart,
  JsonValue,
  PostId,
} from "./communication/records/values.js";

/** Host adapters reject retired environment keys before acquiring an endpoint. */
export { legacyKeys } from "./environment.js";

/** Emission and admission share one wire namespace, independent of npm and MCP. */
export {
  HISTORY_WIRE_VERSIONS,
  LIVE_WIRE_VERSIONS,
  WIRE_VERSION,
  type WireVersion,
} from "./identity/wire-version.js";
/** Compatibility operations have no injectable context tag in the published API. */
export { wireVersions } from "./identity/wire-version.js";

/** Canonical refined values shared by identity and its consumers. */
export { AgentId, AgentName, PrincipalId } from "./identity/agents.js";
/** Exact immutable public-key representation used by identity artifacts. */
export {
  AgentSigningAuthority,
  Ed25519PublicKey,
  InvalidAgentPrivateKeyError,
} from "./identity/keys.js";
/** Immutable Registry attestation and its pinned verification boundary. */
export {
  AgentCard,
  AgentCardDigest,
  AgentCardVerificationError,
  type VerifiedAgentCard,
} from "./identity/cards.js";
/** Opaque attributed payload and endpoint-owned signing operations. */
export {
  type LiveSignedMessage,
  MessageId,
  SignedMessage,
  SignedMessageSigningError,
  SignedMessageVerificationError,
  type VerifiedSignedMessage,
} from "./communication/envelope/signed-message.js";
/** End-to-end sealed SignedMessage bodies and their closed failures. */
export {
  SealedBody,
  SealedBodyOpeningError,
  SealedBodySealingError,
} from "./communication/envelope/sealed-body.js";
/** Registered-agent HTTP authentication and its opaque verified proof. */
export {
  AuthenticatedHttp,
  type VerifiedAgentRequest,
} from "./identity/signing/authenticated-http.js";
/** Shared closed HTTP-envelope failures. */
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
} from "./identity/signing/http-errors.js";
/** HTTP request signing failure without implementation detail. */
export { AgentSigningError } from "./identity/signing/http-signature.js";
