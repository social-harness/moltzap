/** @file Retained judgments preserve decisions without storing provider traces. */

import { scopedLive as it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { expect } from "vitest";
import {
  destination,
  fixture,
  outgoingFixture,
} from "../../__tests__/firewall-runtime-fixtures.js";
import { decodeRuntimeValue } from "../../communication/store/index.js";

it("retains a completed judgment without the provider trace", () =>
  Effect.gen(function* () {
    const subject = yield* fixture;
    const runtime = yield* outgoingFixture(subject, {
      id: "privacy",
      revision: "v1",
      rules: [{ id: "privacy", kind: "safety" }],
      check: () =>
        Effect.succeed({
          findings: [{ ruleId: "privacy", outcome: "block" as const }],
          expectations: [],
          trace: { format: "test-provider/v1", data: "private response" },
        }),
    });

    yield* Effect.flip(
      runtime.operations.send({ input: { to: destination, text: "Hello" } }),
    );

    const [entry] = yield* subject.store.readFirewallDecisions();
    expect(entry).toMatchObject({ disposition: "withheld" });
    const stored = yield* decodeRuntimeValue(
      Schema.Struct({ checks: Schema.Array(Schema.Unknown) }),
      entry?.canonicalResult ?? new Uint8Array(),
    );
    expect(stored.checks).toHaveLength(1);
    expect(stored.checks[0]).not.toHaveProperty("trace");
    expect(stored.checks[0]).toMatchObject({
      findings: [{ ruleId: "privacy", outcome: "block" }],
    });
  }));
