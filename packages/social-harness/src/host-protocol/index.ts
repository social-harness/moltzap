/** @file Daemon MCP schemas and ports; hosts use the names and operations entrypoints. */
/** Daemon event transport schemas and callback ports. */
export {
  callbackReasons,
  type ConsumerMetadata,
  decodeConsumerMetadata,
  decodePollResult,
  eventListInput,
  type EventPollInput,
  eventPollInput,
  type EventStreamInput,
  eventStreamInput,
  type EventSubscribeInput,
  eventSubscribeInput,
  type EventUnsubscribeInput,
  eventUnsubscribeInput,
  type HarnessWebhookEvents,
  itemEventDataJsonSchema,
  maximumEventBytes,
  type PollResult,
  type WebhookStatus,
  webhookStatusResult,
} from "./event-schemas.js";
/** Management request and result schemas. */
export {
  type ManagementReadConversationRequest,
  managementReadConversationRequestSchema,
  type ManagementReadConversationResult,
  managementReadConversationResultSchema,
  type ManagementRegisterRequest,
  managementRegisterRequestSchema,
  type ManagementRegisterResult,
  managementRegisterResultSchema,
  type ManagementSearchConversationsRequest,
  managementSearchConversationsRequestSchema,
  type ManagementSearchConversationsResult,
  managementSearchConversationsResultSchema,
  type ManagementStatusResult,
  managementStatusResultSchema,
} from "./daemon-tools.js";
/** MCP projections keep semantic operations separate from transport framing. */
export {
  decodeHarnessSendCall,
  type HarnessEmptyResult,
  harnessEmptyResultSchema,
  harnessFailureReasons,
  registrationAdmissionRefusalMessage,
} from "./schemas.js";
/** Field diagnostics expose schema expectations without submitted values. */
export { validationIssues } from "./validation-errors.js";
