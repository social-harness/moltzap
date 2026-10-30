/** @file Retained judgments preserve decisions without storing provider traces. */

import { scopedLive as it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { expect } from "vitest";
import { makeRetainedCheckFixture } from "../../__tests__/firewall-retained-fixtures.js";
import {
  destination,
  fixture,
  outgoingFixture,
} from "../../__tests__/firewall-runtime-fixtures.js";
import {
  decodeRuntimeValue,
  encodeRuntimeValue,
} from "../../communication/store/index.js";
import { decodeFirewallAuditEntry } from "./audit-records.js";

it("retains a completed judgment without the provider trace", () =>
  Effect.gen(function* () {
    const subject = yield* fixture;
    const runtime = yield* outgoingFixture(subject, {
      id: "privacy",
      revision: "v1",
      rules: [{ id: "privacy" }],
      check: () =>
        Effect.succeed({
          findings: [{ ruleId: "privacy", outcome: "violation" as const }],
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
      findings: [{ ruleId: "privacy", outcome: "violation" }],
    });
  }));

it("decodes an older retained trace while projecting only the judgment", () =>
  Effect.gen(function* () {
    const subject = yield* fixture;
    const retained = yield* makeRetainedCheckFixture;
    expect(retained.result.checks[0]?.trace).toBeDefined();
    const checkId = "historical-provider-trace";
    yield* subject.store.beginFirewallAttempt({
      checkId,
      direction: "outgoing",
      canonicalCandidate: retained.canonicalCandidate,
      canonicalInput: yield* encodeRuntimeValue(retained.input),
    });
    yield* subject.store.completeFirewallAttempt(
      {
        checkId,
        admit: false,
        canonicalResult: yield* encodeRuntimeValue(retained.result),
      },
      "outgoing",
      retained.canonicalCandidate,
    );

    const [entry] = yield* subject.store.readFirewallDecisions();
    expect(entry).toBeDefined();
    if (entry === undefined) {
      return yield* Effect.dieMessage("missing retained check");
    }
    const decoded = yield* decodeFirewallAuditEntry(entry);
    expect(decoded.result).toMatchObject({
      judgment: "reject",
      reason: "rule-violation",
      checks: [{ findings: [{ ruleId: "privacy", outcome: "violation" }] }],
    });
    expect(decoded.result?.checks[0]).not.toHaveProperty("trace");
  }));
