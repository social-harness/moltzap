/** @file The native message tool preserves daemon refusal text for the agent. */

import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import {
  ChannelFeatureUnavailableError,
  type HarnessEndpoint,
  SendError,
} from "@moltzap/social-harness";
import { Effect, Stream } from "effect";
import { expect, it, vi } from "vitest";
import { ACCOUNT_ID, makeObservedRuntime } from "./__tests__/runtime.js";
import { createChannelPlugin } from "./plugin.js";

/* eslint-disable agent-code-guard/async-keyword -- The test exercises OpenClaw's Promise-native tool and gateway callbacks. */

const cfg: OpenClawConfig = {
  channels: { sharness: { accounts: [{ id: ACCOUNT_ID }] } },
};

it("returns the daemon's experiment refusal unchanged to the message tool", async () => {
  const refusal = new SendError({
    reason: "content-invalid",
    detail: new ChannelFeatureUnavailableError({ feature: "groups" }).detail,
  });
  const endpoint: HarnessEndpoint = {
    send: () => Effect.fail(refusal),
    messages: Stream.never,
  };
  const plugin = createChannelPlugin({
    harnessEndpointForAccount: () => endpoint,
  });
  const start = plugin.gateway?.startAccount;
  const send = plugin.actions?.handleAction;
  if (start === undefined || send === undefined) {
    throw new Error("Missing native channel callbacks");
  }
  const controller = new AbortController();
  const status = vi.fn<(next: ChannelAccountSnapshot) => void>();
  const running = start(gatewayContext(controller.signal, status));
  try {
    await vi.waitFor(() => {
      expect(status).toHaveBeenCalledWith(
        expect.objectContaining({ connected: true }),
      );
    });
    await expect(
      send({
        channel: "sharness",
        action: "send",
        cfg,
        accountId: ACCOUNT_ID,
        params: { to: "group:alice,bob,carol", message: "hello" },
      }),
    ).rejects.toMatchObject({ message: refusal.message });
  } finally {
    controller.abort();
    await running;
  }
});

function gatewayContext(
  abortSignal: AbortSignal,
  setStatus: (next: ChannelAccountSnapshot) => void,
) {
  return {
    cfg,
    accountId: ACCOUNT_ID,
    account: { id: ACCOUNT_ID },
    abortSignal,
    runtime: {
      log: () => undefined,
      error: () => undefined,
      exit: () => undefined,
    },
    channelRuntime: makeObservedRuntime({
      events: [],
      calls: [],
      routePeers: [],
    }),
    getStatus: () => ({ accountId: ACCOUNT_ID }),
    setStatus,
  };
}

/* eslint-enable agent-code-guard/async-keyword -- Restore repository defaults after the native callback test. */
