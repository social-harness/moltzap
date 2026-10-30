/** @file The loopback MCP edge the daemon service composes. */

/** The daemon authenticates all MCP clients with one private credential. */
export { credentialMatches } from "./auth.js";
/** The loopback Streamable HTTP listener. */
export { acquireHarnessMcpHttpServer, LOOPBACK_HOST } from "./http.js";
/** Management results the service returns through the catalog. */
export type {
  ManagementReadConversationResult,
  ManagementRegisterRequest,
  ManagementRegisterResult,
  ManagementSearchConversationsRequest,
  ManagementSearchConversationsResult,
  ManagementStatusResult,
} from "../../host-protocol/index.js";
/** The tool catalog that projects daemon operations. */
export {
  type HarnessMcpEventHandler,
  type HarnessMcpOperations,
  makeHarnessMcpHttpHandler,
} from "./tools.js";
