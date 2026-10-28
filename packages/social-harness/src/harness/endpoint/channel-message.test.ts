/** @file Native channels read the experiment switches with Effect's boolean config semantics. */

import { ConfigProvider, Effect, Either, Schema } from "effect";
import { expect, it } from "vitest";
import {
  ChannelFeatureUnavailableError,
  ExperimentSwitchInvalidError,
  MessageAddressInput,
  readChannelMessage,
} from "../../index.js";

const HIDE_GROUPS = "SHARNESS_EXPERIMENT_HIDE_GROUPS";
const HIDE_COLLECTIVES = "SHARNESS_EXPERIMENT_HIDE_COLLECTIVES";
const GROUP = Schema.decodeUnknownSync(MessageAddressInput)(
  "group:alice,bob,carol",
);
const DIRECT = Schema.decodeUnknownSync(MessageAddressInput)("agent:alice");
const ANSWER = '{"action":"decline"}';
const GATHER = JSON.stringify({
  gather: "Which day?",
  deadline: 60,
  requestedSchema: { type: "object", properties: {} },
});

/** What a group plain-text send and a direct answer read as under each switch value. */
const OUTCOMES = {
  allowed: {
    group: Either.right({ to: GROUP, text: "hello" }),
    answer: Either.right({
      to: DIRECT,
      collectiveResponse: { action: "decline" },
    }),
  },
  hidden: {
    group: Either.left(
      new ChannelFeatureUnavailableError({ feature: "groups" }),
    ),
    answer: Either.left(
      new ChannelFeatureUnavailableError({ feature: "collectives" }),
    ),
  },
  invalid: {
    group: Either.left(
      new ExperimentSwitchInvalidError({ variable: HIDE_GROUPS }),
    ),
    answer: Either.left(
      new ExperimentSwitchInvalidError({ variable: HIDE_COLLECTIVES }),
    ),
  },
} as const;

function read(env: Map<string, string>, to: MessageAddressInput, text: string) {
  return Effect.runSync(
    readChannelMessage(to, text).pipe(
      Effect.either,
      Effect.withConfigProvider(ConfigProvider.fromMap(env)),
    ),
  );
}

it.each([
  { value: undefined, expected: "allowed" },
  { value: "false", expected: "allowed" },
  { value: "no", expected: "allowed" },
  { value: "off", expected: "allowed" },
  { value: "0", expected: "allowed" },
  { value: "true", expected: "hidden" },
  { value: "yes", expected: "hidden" },
  { value: "on", expected: "hidden" },
  { value: "1", expected: "hidden" },
  { value: "", expected: "invalid" },
  { value: "TRUE", expected: "invalid" },
  { value: "sometimes", expected: "invalid" },
] as const)(
  "reads both switches set to $value as $expected",
  ({ value, expected }) => {
    const env =
      value === undefined
        ? new Map<string, string>()
        : new Map<string, string>([
            [HIDE_GROUPS, value],
            [HIDE_COLLECTIVES, value],
          ]);

    expect(read(env, GROUP, "hello")).toEqual(OUTCOMES[expected].group);
    expect(read(env, DIRECT, ANSWER)).toEqual(OUTCOMES[expected].answer);
    expect(read(env, DIRECT, "hello")).toEqual(
      Either.right({ to: DIRECT, text: "hello" }),
    );
  },
);

it("refuses a group gather for groups when both switches are on", () => {
  const env = new Map<string, string>([
    [HIDE_GROUPS, "true"],
    [HIDE_COLLECTIVES, "true"],
  ]);

  expect(read(env, GROUP, GATHER)).toEqual(OUTCOMES.hidden.group);
});
