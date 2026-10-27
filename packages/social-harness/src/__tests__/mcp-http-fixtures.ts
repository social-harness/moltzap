/** @file Serves an MCP handler through the daemon's loopback HTTP server for tests that connect over real HTTP. */

import type { McpHttpHandler } from "@modelcontextprotocol/server";
import { Effect, type Scope } from "effect";
import { acquireHarnessMcpHttpServer } from "../harness/mcp/http.js";

/**
 * Serve `handler` on an ephemeral loopback port and return the server's `/mcp`
 * URL. The listener and the handler close with the caller's scope.
 */
export function loopbackMcpEndpoint(
  handler: McpHttpHandler,
): Effect.Effect<URL, Error, Scope.Scope> {
  return acquireHarnessMcpHttpServer({ port: 0, handler }).pipe(
    Effect.flatMap((server) => {
      const address = server.address();
      return address === null || typeof address === "string"
        ? Effect.dieMessage("Expected a TCP listener")
        : Effect.succeed(new URL(`http://127.0.0.1:${address.port}/mcp`));
    }),
  );
}
