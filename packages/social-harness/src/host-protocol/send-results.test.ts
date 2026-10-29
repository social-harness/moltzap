/** @file Send results describe complete successful cases across the host boundary. */

import { effect as it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { describe, expect } from "vitest";
import { digest } from "../__tests__/agent-card-fixtures.js";
import {
  checkHarnessSendResult,
  decodeHarnessSendResult,
} from "./operations.js";

const postId = digest("pst_", 11);
const operationId = digest("col_", 12);
const address = "agent:bob";

const results = [
  { kind: "multicast", postId, address },
  { kind: "response", operationId, postId, address },
  { kind: "collective", operationId },
];

describe("send results", () => {
  it.each(results)("decodes a complete $kind result", (result) =>
    Effect.gen(function* () {
      expect(yield* decodeHarnessSendResult(result)).toEqual(result);
    }),
  );

  it.each([
    {},
    { kind: "multicast", postId },
    { kind: "response", postId, address },
    { kind: "collective", operationId, postId },
    { kind: "multicast", postId, address, operationId },
  ])("rejects an incomplete or contradictory result: %j", (result) =>
    Effect.gen(function* () {
      const decoded = yield* Effect.either(decodeHarnessSendResult(result));
      expect(decoded).toMatchObject({ _tag: "Left" });
    }),
  );

  it("ignores a future result field at the reader and refuses it at the writer", () =>
    Effect.gen(function* () {
      const result = { kind: "multicast", postId, address, future: true };
      expect(yield* decodeHarnessSendResult(result)).toEqual({
        kind: "multicast",
        postId,
        address,
      });
      expect(
        Exit.isFailure(yield* Effect.exit(checkHarnessSendResult(result))),
      ).toBe(true);
    }));
});
