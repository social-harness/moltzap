/** @file Connects tests to an MCP handler, over the daemon's loopback HTTP server or in process. */

import type { McpHttpHandler } from "@modelcontextprotocol/server";
import {
  Client,
  type ClientOptions,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { Effect, type Scope } from "effect";
import { acquireHarnessMcpHttpServer } from "../daemon/mcp/http.js";

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

/**
 * A client with `options` connected to `handler` without a listener: each
 * request goes straight to the handler's `fetch`, carrying `headers`. A
 * refused connection fails with the SDK's error, and the client closes with
 * the caller's scope.
 */
export function connectInProcessClient(
  handler: McpHttpHandler,
  options: ClientOptions,
  headers: Readonly<Record<string, string>> = {},
): Effect.Effect<Client, unknown, Scope.Scope> {
  // eslint-disable-next-line agent-code-guard/acquire-release-requires-scope -- The returned effect requires Scope, so the caller's scope releases the client.
  return Effect.acquireRelease(
    Effect.suspend(() => {
      const client = new Client(
        { name: "in-process-test-client", version: "1" },
        options,
      );
      const transport = new StreamableHTTPClientTransport(
        new URL("http://127.0.0.1/mcp"),
        {
          fetch: (url, init) => handler.fetch(new Request(url, init)),
          requestInit: { headers },
        },
      );
      return Effect.tryPromise({
        try: () => client.connect(transport),
        catch: (cause) => cause,
      }).pipe(Effect.as(client));
    }),
    (client) => Effect.tryPromise(() => client.close()).pipe(Effect.ignore),
  );
}
