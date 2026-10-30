/**
 * @file Condition-only process-test composition surface: management fixture schemas, the WireVersions override, and the request-signing capability and history window process tests compose with.
 */

/** Injectable release policy is available only with the test condition. */
export { WireVersions } from "./identity/wire-version.js";

/** Management fixtures share the schemas used by the public daemon protocol. */
export {
  managementReadConversationResultSchema,
  managementRegisterRequestSchema,
  managementRegisterResultSchema,
  managementSearchConversationsResultSchema,
  managementStatusResultSchema,
} from "./host-protocol/index.js";

/** Process tests sign registered requests through the production capability. */
export { AuthenticatedHttp } from "./identity/request-authentication.js";
/** Mixed-release process tests compose the installed history compatibility window. */
export { HISTORY_WIRE_VERSIONS } from "./identity/wire-version.js";

/** Offline evaluation for tests without a running daemon or database. */
export { checkMessage } from "./firewall/check.js";
