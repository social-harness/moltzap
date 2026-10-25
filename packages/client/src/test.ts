/** @file Test-only wire policy overrides. */

/** Injectable release policy is available only with the test condition. */
export { WireVersions } from "./identity/wire-version.js";

/** Management fixtures share the schemas used by the public daemon protocol. */
export {
  managementReadConversationResultSchema,
  managementRegisterRequestSchema,
  managementRegisterResultSchema,
  managementSearchConversationsResultSchema,
  managementStatusResultSchema,
} from "./harness/protocol/index.js";
