/** @file Native inbound metadata preserves the application identity used for replies. */

import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";
import type { PluginRuntime } from "openclaw/plugin-sdk/channel-core";
import { Client } from "@modelcontextprotocol/client";
import { InboxEvent } from "@moltzap/social-harness";
import { Effect, Schema } from "effect";
import { buildChannelInboundEventContext } from "openclaw/plugin-sdk/channel-inbound";
import { afterEach, expect, it, vi } from "vitest";
import type * as McpModule from "#sharness-mcp/mcp-client";
import type { acquireMcpConnection } from "#sharness-mcp/mcp-client";
import { openClawTestMcpCredentialFile } from "../vitest.setup.js";
import { createChannelPlugin } from "./plugin.js";

/* eslint-disable agent-code-guard/async-keyword -- The public host runtime callbacks are Promise-based. */

const acquire = vi.hoisted(() => vi.fn<typeof acquireMcpConnection>());
const runtimeContexts = {
  register: () => ({ dispose: () => {} }),
  get: () => undefined,
  watch: () => () => {},
};
vi.mock("#sharness-mcp/mcp-client", async (original) => ({
  ...(await original<typeof McpModule>()),
  acquireMcpConnection: acquire,
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each(["shared", "private"] as const)(
  "preserves the peer message ID throughout the %s native turn",
  (mode) =>
    Effect.gen(function* () {
      vi.stubEnv("SHARNESS_MCP_URL", "http://127.0.0.1:8321/mcp");
      vi.stubEnv("SHARNESS_MCP_CREDENTIAL_FILE", openClawTestMcpCredentialFile);
      const msgId = `msg_${"A".repeat(43)}`;
      const replyToMsgId = `msg_${Buffer.alloc(32, 2).toString("base64url")}`;
      const body = "Can we meet Tuesday?";
      const event = yield* Schema.decodeUnknown(InboxEvent)({
        address: "agent:alice",
        item: {
          kind: "multicast",
          message: {
            msgId,
            replyToMsgId,
            author: {
              agentId: `agt_${Buffer.alloc(16, 1).toString("base64url")}`,
              agentName: "alice",
              principalId: `prn_${Buffer.alloc(16, 1).toString("base64url")}`,
            },
            recipients: [
              {
                agentId: `agt_${Buffer.alloc(16, 2).toString("base64url")}`,
                agentName: "bob",
                principalId: `prn_${Buffer.alloc(16, 2).toString("base64url")}`,
              },
            ],
            content: [{ type: "text", text: body }],
          },
        },
      });
      const plugin = createChannelPlugin();
      const handleAction = yield* Effect.fromNullable(
        plugin.actions?.handleAction,
      );
      const client = new Client({
        name: "openclaw-inbound-test",
        version: "1",
      });
      const send = vi.spyOn(client, "callTool").mockResolvedValue({
        structuredContent: { id: msgId, address: "agent:alice" },
        content: [],
      });
      acquire.mockReturnValue(
        Effect.succeed({
          client,
          consumeInbox: (options, accept) =>
            (options.onReady ?? Effect.void).pipe(
              Effect.zipRight(accept(event)),
            ),
        }),
      );
      const buildContext = vi.fn(buildChannelInboundEventContext);
      const messageIds: Array<string | undefined> = [];
      const ingestedIds: string[] = [];
      const run: PluginRuntime["channel"]["inbound"]["run"] = async (input) => {
        const ingested = await input.adapter.ingest(input.raw);
        if (ingested === null) {
          throw new Error("Expected incoming message");
        }
        ingestedIds.push(ingested.id);
        const plan = await input.adapter.resolveTurn(
          ingested,
          { kind: "message", canStartAgentTurn: true },
          {},
        );
        messageIds.push("messageId" in plan ? plan.messageId : undefined);
        await exerciseReplies(handleAction, replyToMsgId);
        return {
          admission: { kind: "handled", reason: "Captured native projection" },
          dispatched: false,
        };
      };
      const start = yield* Effect.fromNullable(plugin.gateway?.startAccount);
      yield* Effect.tryPromise({
        try: () =>
          Promise.resolve(
            start({
              cfg: {
                channels: { sharness: { accounts: [{ id: "primary", mode }] } },
              },
              accountId: "primary",
              account: { id: "primary", mode },
              abortSignal: new AbortController().signal,
              runtime: { log: () => {}, error: () => {}, exit: () => {} },
              channelRuntime: {
                runtimeContexts,
                inbound: { buildContext, run },
                routing: {
                  resolveAgentRoute: () => ({
                    agentId: "assistant",
                    accountId: "primary",
                    sessionKey: "agent:assistant:peer",
                    mainSessionKey: "agent:assistant:main",
                    matchedBy: "default",
                  }),
                },
              },
              getStatus: () => ({ accountId: "primary" }),
              setStatus: () => {},
            }),
          ),
        catch: (error) =>
          error instanceof Error ? error : new Error(String(error)),
      });
      expect(buildContext.mock.calls[0]?.[0].message.rawBody).toBe(body);
      const receivedBody = buildContext.mock.calls[0]?.[0].message.bodyForAgent;
      expect(receivedBody).toContain(msgId);
      expect(receivedBody).not.toContain(replyToMsgId);
      expect(send.mock.calls.map(([request]) => request.arguments)).toEqual([
        { input: { to: "agent:alice", text: "reply", replyToMsgId } },
        { input: { to: "agent:alice", text: "new message" } },
      ]);
      expect(ingestedIds).toEqual([msgId]);
      expect(messageIds).toEqual([msgId]);
      expect(
        buildContext.mock.calls.map(([context]) => context.messageId),
      ).toEqual([msgId]);
    }).pipe(Effect.runPromise),
);

/** Exercise explicit and host-inferred references through the native action facade. */
async function exerciseReplies(
  handleAction: (context: ChannelMessageActionContext) => unknown,
  replyToMsgId: string,
) {
  await handleAction({
    channel: "sharness",
    action: "send",
    cfg: {},
    accountId: "primary",
    params: {
      to: "agent:alice",
      message: "reply",
      replyTo: replyToMsgId,
    },
    reply: { source: "explicit", replyToId: replyToMsgId },
  });
  await handleAction({
    channel: "sharness",
    action: "send",
    cfg: {},
    accountId: "primary",
    params: {
      to: "agent:alice",
      message: "new message",
      replyTo: replyToMsgId,
    },
    reply: { source: "implicit", replyToId: replyToMsgId, mode: "all" },
  });
}

/* eslint-enable agent-code-guard/async-keyword -- Restore defaults after the host callbacks. */
