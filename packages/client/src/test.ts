/**
 * @file Exact management request and reply schemas for process acceptance tests.
 * Resolution requires sharness-test; production consumers receive no entry.
 */
export {
  managementReadConversationResultSchema,
  managementRegisterRequestSchema,
  managementRegisterResultSchema,
  managementSearchConversationsResultSchema,
  managementStatusResultSchema,
} from "./harness/protocol/index.js";
