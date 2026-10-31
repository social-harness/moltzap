/** @file Connects tests to an MCP handler, over the daemon's loopback HTTP server or in process. */

import {
  Client,
  type ClientOptions,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  type McpHttpHandler,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import { Effect, Redacted, type Scope } from "effect";
import { acquireHarnessMcpHttpServer } from "../daemon/mcp/http.js";

/** Authenticated MCP fixtures use the same opaque token on both ends. */
export const mcpTestCredential = Redacted.make(
  "mcp-test-credential-0000000000000001",
);
/** Request headers for the shared authenticated MCP fixtures. */
export const mcpTestHeaders = {
  Authorization: `Bearer ${Redacted.value(mcpTestCredential)}`,
};

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
  headers: Readonly<Record<string, string>> = mcpTestHeaders,
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

/** Builds one authenticated modern MCP tool request without a client connection. */
export function makeToolCallRequest(input: {
  readonly id: string;
  readonly name: string;
  readonly toolArguments: Readonly<Record<string, unknown>>;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly signal?: AbortSignal;
}): Request {
  return new Request("http://127.0.0.1/mcp", {
    method: "POST",
    headers: {
      ...mcpTestHeaders,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-method": "tools/call",
      "mcp-name": input.name,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: input.id,
      method: "tools/call",
      params: {
        name: input.name,
        arguments: input.toolArguments,
        _meta: {
          ...input.metadata,
          [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
          [CLIENT_INFO_META_KEY]: { name: "daemon-test-client", version: "1" },
          [CLIENT_CAPABILITIES_META_KEY]: {},
        },
      },
    }),
    signal: input.signal,
  });
}
