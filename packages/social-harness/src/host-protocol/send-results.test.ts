/** @file Send results describe complete successful cases across the host boundary. */

import { scoped as it } from "@effect/vitest";
import { Clock, Effect, Exit, Struct } from "effect";
import { describe, expect } from "vitest";
import type { CollectiveSendOutcome } from "../communication/collectives/contracts.js";
import { digest, testAgentView } from "../__tests__/agent-card-fixtures.js";
import { collectiveOperationId } from "../__tests__/collective-id-fixtures.js";
import {
  alice,
  bob,
  form,
  openCollectives,
  question,
  wireMessage,
} from "../__tests__/collective-service-fixtures.js";
import {
  checkHarnessSendResult,
  decodeHarnessSendResult,
} from "./operations.js";

const msgId = digest("msg_", 11);
const operationId = collectiveOperationId(
  testAgentView("agent:alice").agentId,
  12,
);
const address = "agent:bob";

const results = [
  { kind: "multicast", msgId, address },
  { kind: "response", operationId, msgId, address },
  { kind: "collective", operationId },
];

// @agent-code-guard/regression-only: Exact writer cases cover all finite success variants, rejected combinations, reader evolution, and absent optional fields.
describe("send results", () => {
  it(
    "accepts real response and gather successes without advice at the exact writer",
    acceptsProducedResults,
  );

  it.each(results)("decodes a complete $kind result", (result) =>
    Effect.gen(function* () {
      expect(yield* decodeHarnessSendResult(result)).toEqual(result);
    }),
  );

  it.each([
    {},
    { kind: "multicast", msgId },
    { kind: "response", msgId, address },
    { kind: "collective", operationId, msgId },
    { kind: "multicast", msgId, address, operationId },
  ])("rejects an incomplete or contradictory result: %j", (result) =>
    Effect.gen(function* () {
      const decoded = yield* Effect.either(decodeHarnessSendResult(result));
      expect(decoded).toMatchObject({ _tag: "Left" });
    }),
  );

  it("ignores a future result field at the reader and refuses it at the writer", () =>
    Effect.gen(function* () {
      const result = { kind: "multicast", msgId, address, future: true };
      expect(yield* decodeHarnessSendResult(result)).toEqual({
        kind: "multicast",
        msgId,
        address,
      });
      expect(
        Exit.isFailure(yield* Effect.exit(checkHarnessSendResult(result))),
      ).toBe(true);
    }));
});

function acceptsProducedResults() {
  return Effect.gen(function* () {
    const fixture = yield* openCollectives();
    const deadlineAt = (yield* Clock.currentTimeMillis) + 60_000;
    const remoteOperation = collectiveOperationId(bob.agentId, 12);
    const request = yield* wireMessage(
      bob,
      [alice],
      {
        kind: "operation",
        op: "gather",
        operationId: remoteOperation,
        requestedSchema: form,
        deadlineAt,
      },
      { byte: 13, text: "Which day works?" },
    );
    yield* fixture.service.receive(request);
    const message = yield* wireMessage(
      alice,
      [bob],
      {
        kind: "response",
        operationId: remoteOperation,
        action: "decline",
      },
      { byte: 14 },
    );
    yield* assertProducedResult(yield* fixture.service.answer(message));
    yield* assertProducedResult(
      yield* fixture.service.ask(question(deadlineAt)),
    );
  });
}

function assertProducedResult(result: CollectiveSendOutcome) {
  return Effect.gen(function* () {
    const publicResult = Struct.omit(result, "msgIds");
    expect(yield* checkHarnessSendResult(publicResult)).toEqual(publicResult);
    expect(Object.hasOwn(publicResult, "guidance")).toBe(false);
  });
}
