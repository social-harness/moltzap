/** @file The loopback MCP edge the daemon service composes. */

/** Credential roles for tunneled runtime and owner requests. */
export { credentialMatches, type HarnessMcpCredentials } from "./auth.js";
/** The loopback Streamable HTTP listener. */
export { acquireHarnessMcpHttpServer, LOOPBACK_HOST } from "./http.js";
/** Owner-tool results the service returns through the catalog. */
export type {
  ManagementReadConversationResult,
  ManagementRegisterRequest,
  ManagementRegisterResult,
  ManagementSearchAgentsResult,
  ManagementSearchConversationsRequest,
  ManagementSearchConversationsResult,
  ManagementStatusResult,
} from "../../host-protocol/index.js";
/** The tool catalog that projects Harness operations and owner tools. */
export {
  type HarnessMcpEventHandler,
  type HarnessMcpOperations,
  makeHarnessMcpHttpHandler,
} from "./tools.js";
