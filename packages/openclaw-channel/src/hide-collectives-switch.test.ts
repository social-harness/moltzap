/**
 * @file Experiment switches refuse collective message text and group targets
 * before endpoint dispatch.
 */

import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { Data, Effect, FastCheck as fc } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createChannelPlugin } from "./plugin.js";

const HIDE_COLLECTIVES = "SHARNESS_EXPERIMENT_HIDE_COLLECTIVES";
const HIDE_GROUPS = "SHARNESS_EXPERIMENT_HIDE_GROUPS";
const GROUP_REFUSAL = "group addresses are not available";
const DIRECT_GUIDANCE = "message each agent at its agent: address";
const GROUP_ADDRESS = "group:nova,sol";
const REFUSAL = "gather, all_gather and answers are not available";
const CONFIG: OpenClawConfig = {
  channels: { sharness: { accounts: [{ id: "primary" }] } },
};
const SLOT_SCHEMA = {
  type: "object",
  properties: { slot: { type: "string", enum: ["mon", "tue"] } },
};

/** Texts that state an operation, one of them invalidly. */
const OPERATION_TEXTS = [
  { gather: "Which day?", deadline: 60, requestedSchema: SLOT_SCHEMA },
  { all_gather: "Which day?", deadline: 60, requestedSchema: SLOT_SCHEMA },
  { action: "accept", content: { slot: "mon" } },
  { action: "decline" },
  { action: "cancel" },
  { gather: "Which day?", deadline: 0 },
].map((value) => JSON.stringify(value));

class SwitchTestError extends Data.TaggedError("SwitchTestError")<{
  readonly detail: string;
}> {}

describe("OpenClaw experiment switches", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(["MOLTZAP_MCP_URL", "MOLTZAP_EXPERIMENT_HIDE_COLLECTIVES"])(
    "refuses startup with retired key %s without printing its value",
    (key) => {
      vi.stubEnv(key, "private-retired-value");
      expect(() => createChannelPlugin()).toThrow(key);
      expect(() => createChannelPlugin()).not.toThrow("private-retired-value");
    },
  );
  it("refuses an empty retired key", () => {
    vi.stubEnv("MOLTZAP_MCP_URL", "");
    expect(() => createChannelPlugin()).toThrow("MOLTZAP_MCP_URL");
  });

  it(
    "offers the same send and reply actions whether or not the switch is set",
    switchLeavesActionsUnchanged,
  );
  it(
    "passes plain text on to the account when the switch is true",
    switchOnPassesPlainText,
  );
  it(
    "passes JSON text without an operation key on to the account when the switch is true",
    switchOnPassesJsonProse,
  );
  it(
    "refuses every operation text on send and reply when the switch is true",
    switchOnRefusesOperationText,
  );
  it(
    "fails an operation text naming the switch when its value is not a boolean",
    invalidSwitchFailsOperationText,
  );

  describe.each(["send", "reply"] as const)(
    "group switch on %s",
    groupSwitchTests,
  );
});

function groupSwitchTests(action: "send" | "reply") {
  it("refuses group targets for every enabled value and message text", () =>
    switchOnRefusesGroups(action));
  it.each([undefined, "false", "no", "off", "0"])(
    "passes group targets on to the account when set to %s",
    (value) => {
      vi.stubEnv(HIDE_GROUPS, value);

      return reachesAccount("hello", GROUP_ADDRESS, action);
    },
  );
  it("passes direct targets on to the account when enabled", () => {
    vi.stubEnv(HIDE_GROUPS, "true");
    vi.stubEnv(HIDE_COLLECTIVES, "true");

    return reachesAccount("hello", "agent:nova", action);
  });
  it.each(["sometimes", "", "TRUE"])(
    "fails a group target naming the switch for invalid value %s",
    (value) => invalidGroupSwitchFails(action, value),
  );
}

function switchOnRefusesGroups(action: "send" | "reply") {
  return fc.assert(
    fc.asyncProperty(
      fc.constantFrom("true", "yes", "on", "1"),
      fc.string(),
      (value, message) => {
        vi.stubEnv(HIDE_GROUPS, value);

        return Effect.runPromise(
          messageAction(action, { to: GROUP_ADDRESS, message }).pipe(
            Effect.flip,
            Effect.tap((failure) => {
              expect(failure.detail).toContain(GROUP_REFUSAL);
              expect(failure.detail).toContain(DIRECT_GUIDANCE);
            }),
            Effect.as(true),
          ),
        );
      },
    ),
  );
}

function invalidGroupSwitchFails(action: "send" | "reply", value: string) {
  vi.stubEnv(HIDE_GROUPS, value);

  return Effect.runPromise(
    messageAction(action, { to: GROUP_ADDRESS, message: "hello" }).pipe(
      Effect.flip,
      Effect.tap((failure) => {
        expect(failure.detail).toContain(HIDE_GROUPS);
      }),
      Effect.asVoid,
    ),
  );
}

function switchLeavesActionsUnchanged() {
  vi.stubEnv(HIDE_COLLECTIVES, "true");
  const hidden = describeTool();
  vi.stubEnv(HIDE_COLLECTIVES, undefined);

  expect(hidden).toEqual({ actions: ["send", "reply"] });
  expect(describeTool()).toEqual(hidden);
}

function describeTool() {
  return createChannelPlugin().actions?.describeMessageTool({
    cfg: CONFIG,
  });
}

/** No account is connected, so a send the switch admits fails as not connected. */
function switchOnPassesPlainText() {
  vi.stubEnv(HIDE_COLLECTIVES, "true");

  return reachesAccount("hello");
}

function switchOnPassesJsonProse() {
  vi.stubEnv(HIDE_COLLECTIVES, "true");

  return reachesAccount('{"note": "mon or tue"}');
}

function reachesAccount(
  message: string,
  to = "agent:nova",
  action: "send" | "reply" = "send",
) {
  return Effect.runPromise(
    messageAction(action, { to, message }).pipe(
      Effect.flip,
      Effect.tap((failure) => {
        // eslint-disable-next-line agent-code-guard/no-hardcoded-assertion-literals -- Only a send past the switch reaches the account lookup.
        expect(failure.detail).toContain("not connected to Social Harness");
      }),
      Effect.asVoid,
    ),
  );
}

function switchOnRefusesOperationText() {
  vi.stubEnv(HIDE_COLLECTIVES, "true");

  return fc.assert(
    fc.asyncProperty(
      fc.constantFrom("send" as const, "reply" as const),
      fc.constantFrom(...OPERATION_TEXTS),
      (action, message) =>
        Effect.runPromise(
          messageAction(action, { to: "agent:nova", message }).pipe(
            Effect.flip,
            Effect.tap((failure) => {
              expect(failure.detail).toContain(REFUSAL);
            }),
            Effect.as(true),
          ),
        ),
    ),
  );
}

function invalidSwitchFailsOperationText() {
  vi.stubEnv(HIDE_COLLECTIVES, "sometimes");

  return Effect.runPromise(
    messageAction("send", {
      to: "agent:nova",
      message: '{"action":"decline"}',
    }).pipe(
      Effect.flip,
      Effect.tap((failure) => {
        expect(failure.detail).toContain(HIDE_COLLECTIVES);
      }),
    ),
  );
}

/**
 * The plugin checks the switch before it looks up the account, so a refusal
 * needs no connected account.
 */
function messageAction(
  action: "send" | "reply",
  params: ChannelMessageActionContext["params"],
) {
  const handleAction = createChannelPlugin().actions?.handleAction;
  return Effect.tryPromise({
    try: () =>
      handleAction?.({
        channel: "sharness",
        action,
        cfg: CONFIG,
        accountId: "primary",
        params,
      }) ?? Promise.reject(new Error("missing action handler")),
    catch: (cause) => new SwitchTestError({ detail: String(cause) }),
  });
}
