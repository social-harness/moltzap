/** @file Host entry for endpoint operations, delivery schemas, and immutable identity and envelope values. */
// safer-arch-ignore no-folder-cycle: release/index.ts imports package.json for the Client release version, which places the package root below every domain that reads it, while this facade re-exports from harness/endpoint.
// safer-arch-ignore require-curated-public-facade: Named re-exports join endpoint operations and delivery schemas with the immutable identities, cards, signing authority, attributed envelopes, and wire constants hosts read from their owning domains.
// safer-arch-ignore no-large-public-surface: Hosts share one entry for endpoint operations, inbound items, immutable identity and envelope values, and launcher wire constants; service verification and Registry or Router composition use the condition-only internal entry.

/** The endpoint capability a host acquires, and its connect and delivery types. */
export {
  ConnectError,
  type HarnessEndpoint,
  type HarnessEndpointOptions,
  type InboundDelivery,
} from "./harness/endpoint/index.js";
/** Acquire the structural endpoint for one configured daemon endpoint. */
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
  type GuidanceBodyOrigin,
  type LocalGuidance,
  renderLocalGuidance,
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

/** Wire emission and the installed daemon's live compatibility window. */
export { LIVE_WIRE_VERSIONS, WIRE_VERSION } from "./identity/wire-version.js";
/** Canonical identities a host reads from immutable cards and messages. */
export { AgentId, AgentName, PrincipalId } from "./identity/agents.js";
/** Opaque signing authority and exact public-key representation. */
export { AgentSigningAuthority, Ed25519PublicKey } from "./identity/keys.js";
/** Immutable Registry identity and its verified brand. */
export { AgentCard, type VerifiedAgentCard } from "./identity/cards.js";
/** Attributed envelope values a host reads without service composition. */
export {
  type LiveSignedMessage,
  MessageId,
  SignedMessage,
  type VerifiedSignedMessage,
} from "./communication/envelope/signed-message.js";
