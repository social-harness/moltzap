/** @file Evaluation switches share Effect's boolean config semantics across native channels. */

import { ConfigProvider, Effect, Either, Schema } from "effect";
import { expect, it } from "vitest";
import {
  ChannelFeatureUnavailableError,
  MessageAddressInput,
  readChannelMessage,
} from "../../index.js";

const GROUP = Schema.decodeUnknownSync(MessageAddressInput)(
  "group:alice,bob,carol",
);
const DIRECT = Schema.decodeUnknownSync(MessageAddressInput)("agent:alice");
const ANSWER = '{"action":"decline"}';

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
])("reads both switches set to $value as $expected", ({ value, expected }) => {
  const env =
    value === undefined
      ? new Map<string, string>()
      : new Map([
          ["SHARNESS_EXPERIMENT_HIDE_GROUPS", value],
          ["SHARNESS_EXPERIMENT_HIDE_COLLECTIVES", value],
        ]);
  const read = (to: MessageAddressInput, text: string) =>
    Effect.runSync(
      readChannelMessage(to, text).pipe(
        Effect.either,
        Effect.withConfigProvider(ConfigProvider.fromMap(env)),
      ),
    );
  const outcome = (result: ReturnType<typeof read>) =>
    Either.match(result, {
      onLeft: (error) =>
        error instanceof ChannelFeatureUnavailableError ? "hidden" : "invalid",
      onRight: () => "allowed",
    });
  expect(outcome(read(GROUP, "hello"))).toBe(expected);
  expect(outcome(read(DIRECT, ANSWER))).toBe(expected);
  expect(read(DIRECT, "hello")).toEqual(
    Either.right({ to: DIRECT, text: "hello" }),
  );
});
