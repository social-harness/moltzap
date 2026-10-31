/** @file The daemon supplies conversation history to incoming and outgoing checks. */

import { scopedLive as it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Queue } from "effect";
import { expect } from "vitest";
import type { CertifiedRecord } from "../../communication/records/index.js";
import type { MiddlewareInput } from "../index.js";
import { appendCertifiedMessage } from "../../__tests__/certified-history-fixtures.js";
import {
  addConversation,
  fixture,
  type Fixture,
  seedIncoming,
} from "../../__tests__/conversation-fixtures.js";
import {
  auditChecks,
  destination,
  incomingFixture,
  outgoingFixture,
  pass,
  policy,
  settings,
} from "../../__tests__/daemon-delivery-fixtures.js";
import { bytes } from "../../__tests__/store-schema-fixtures.js";
import { EndpointStoreError } from "../../communication/store/index.js";
import { readFirewallEvidence } from "./evidence.js";

// @agent-code-guard/regression-only: Exercises conversation-window and byte-bound failures through real certified history.

function extendHistory(
  subject: Pick<Fixture, "store" | "local" | "remote" | "membership" | "run">,
  previous: CertifiedRecord,
  texts: readonly string[],
) {
  return Effect.reduce(texts, previous, (record, text) =>
    subject.run(appendCertifiedMessage(subject, record, text, true)),
  );
}

function recordInputs(seen: MiddlewareInput[]) {
  return policy((input) =>
    Effect.sync(() => {
      seen.push(input);
      return pass;
    }),
  );
}

function unrelatedHistory(subject: Fixture) {
  return Effect.gen(function* () {
    const other = yield* addConversation(subject, true);
    yield* extendHistory({ ...subject, ...other }, other.record, [
      "Earlier conversation",
      "Still another conversation",
    ]);
  });
}

const windowOptions = { maximumHistoryRecords: 2 };

function bindUnresolvedSend(subject: Fixture) {
  return subject.run(
    subject.store.bindMessageIntent({
      kind: "existing-conversation",
      intent: {
        conversationId: subject.membership.descriptor.conversationId,
        membershipHash: subject.membership.hash,
        authorAgentId: subject.local.card.agentId,
        msgId: "msg_unresolved",
        canonicalIntent: bytes("pending send"),
      },
    }),
  );
}

it("admits an incoming check despite an unresolved send in another conversation", () =>
  Effect.gen(function* () {
    const subject = yield* fixture;
    const other = yield* addConversation(subject, true);
    yield* bindUnresolvedSend({ ...subject, ...other });
    const seen: MiddlewareInput[] = [];
    const runtime = yield* incomingFixture(subject, recordInputs(seen));
    yield* runtime.runPass;
    yield* Queue.take(runtime.completed);

    expect(runtime.published).toHaveLength(1);
    expect(seen[0]?.context.gaps).toEqual([]);
    expect((yield* auditChecks(subject))[0]).toMatchObject({
      disposition: "admitted",
      result: { reason: "eligible" },
    });
  }));

it("withholds an incoming check with an unresolved send in its own conversation", () =>
  Effect.gen(function* () {
    const subject = yield* fixture;
    yield* seedIncoming(subject);
    yield* bindUnresolvedSend(subject);
    const runtime = yield* incomingFixture(
      subject,
      policy(() => Effect.succeed(pass)),
      {},
      false,
    );
    yield* runtime.runPass;
    yield* Queue.take(runtime.completed);

    expect(runtime.published).toHaveLength(0);
    expect((yield* auditChecks(subject))[0]).toMatchObject({
      disposition: "withheld",
      result: { reason: "unresolved-evidence" },
    });
  }));

it("admits an outgoing check despite an unresolved send in another conversation", () =>
  Effect.gen(function* () {
    const subject = yield* fixture;
    const other = yield* addConversation(subject, true);
    yield* bindUnresolvedSend({ ...subject, ...other });
    const seen: MiddlewareInput[] = [];
    const runtime = yield* outgoingFixture(subject, recordInputs(seen));
    const sending = yield* runtime.operations
      .send({ input: { to: destination, text: "Independent send" } })
      .pipe(Effect.forkScoped);
    yield* Deferred.await(subject.outbound);
    yield* Fiber.interrupt(sending);

    expect(seen[0]?.context.gaps).toEqual([]);
    expect((yield* auditChecks(subject))[0]).toMatchObject({
      disposition: "admitted",
      result: { reason: "eligible" },
    });
  }));

it("refuses an outgoing check with an unresolved send in its own conversation", () =>
  Effect.gen(function* () {
    const subject = yield* fixture;
    yield* seedIncoming(subject, true);
    yield* bindUnresolvedSend(subject);
    const runtime = yield* outgoingFixture(
      subject,
      policy(() => Effect.succeed(pass)),
    );
    const refusal = yield* Effect.flip(
      runtime.operations.send({
        input: { to: destination, text: "Concurrent send" },
      }),
    );

    expect(refusal).toMatchObject({ refusal: "unresolved-evidence" });
    expect((yield* auditChecks(subject))[0]).toMatchObject({
      disposition: "withheld",
      result: { reason: "unresolved-evidence" },
    });
  }));

it("admits a fresh incoming conversation despite another conversation exceeding the window", () =>
  Effect.gen(function* () {
    const subject = yield* fixture;
    yield* unrelatedHistory(subject);
    const seen: MiddlewareInput[] = [];
    const runtime = yield* incomingFixture(
      subject,
      recordInputs(seen),
      windowOptions,
    );
    yield* runtime.runPass;
    yield* Queue.take(runtime.completed);

    expect(runtime.published).toHaveLength(1);
    expect(seen[0]?.context).toMatchObject({
      history: [],
      facts: [],
      gaps: [],
    });
    expect((yield* auditChecks(subject))[0]?.result).toMatchObject({
      reason: "eligible",
    });
  }));

it("admits a fresh outgoing conversation despite another conversation exceeding the window", () =>
  Effect.gen(function* () {
    const subject = yield* fixture;
    yield* unrelatedHistory(subject);
    const seen: MiddlewareInput[] = [];
    const runtime = yield* outgoingFixture(
      subject,
      recordInputs(seen),
      windowOptions,
    );
    const sending = yield* runtime.operations
      .send({ input: { to: destination, text: "New conversation" } })
      .pipe(Effect.forkScoped);
    yield* Deferred.await(subject.outbound);
    yield* Fiber.interrupt(sending);

    expect(seen[0]?.context).toMatchObject({
      history: [],
      facts: [],
      gaps: [],
    });
    expect((yield* auditChecks(subject))[0]).toMatchObject({
      disposition: "admitted",
      result: { reason: "eligible" },
    });
  }));

it("assesses incoming messages with the recent conversation window at assessment time while excluding the candidate", () =>
  Effect.gen(function* () {
    const subject = yield* fixture;
    const previous = yield* extendHistory(
      subject,
      yield* seedIncoming(subject, true),
      ["Older than the window", "Recent first", "Recent second"],
    );
    const candidate = yield* subject.run(
      appendCertifiedMessage(subject, previous, "Incoming candidate"),
    );
    yield* extendHistory(subject, candidate, ["Certified after the candidate"]);
    const seen: MiddlewareInput[] = [];
    const runtime = yield* incomingFixture(
      subject,
      recordInputs(seen),
      windowOptions,
      false,
    );
    yield* runtime.runPass;
    yield* Queue.take(runtime.completed);

    expect(seen[0]?.context.history.map((entry) => entry.text)).toEqual([
      "Recent second",
      "Certified after the candidate",
    ]);
    expect(seen[0]?.context.earlierHistoryOmitted).toBe(true);
    expect(seen[0]?.context.gaps).toEqual([]);
    expect(runtime.published).toHaveLength(1);
    expect((yield* auditChecks(subject))[0]?.result).toMatchObject({
      reason: "eligible",
    });
  }));

it("assesses outgoing messages with the recent conversation window and a nonblocking omission", () =>
  Effect.gen(function* () {
    const subject = yield* fixture;
    yield* extendHistory(subject, yield* seedIncoming(subject, true), [
      "Older than the window",
      "Recent first",
      "Recent second",
    ]);
    const seen: MiddlewareInput[] = [];
    const runtime = yield* outgoingFixture(
      subject,
      recordInputs(seen),
      windowOptions,
    );
    const sending = yield* runtime.operations
      .send({ input: { to: destination, text: "Outgoing candidate" } })
      .pipe(Effect.forkScoped);
    yield* Deferred.await(subject.outbound);
    yield* Fiber.interrupt(sending);

    expect(seen[0]?.context.history.map((entry) => entry.text)).toEqual([
      "Recent first",
      "Recent second",
    ]);
    expect(seen[0]?.context.earlierHistoryOmitted).toBe(true);
    expect(seen[0]?.context.gaps).toEqual([]);
    expect((yield* auditChecks(subject))[0]).toMatchObject({
      disposition: "admitted",
      result: { reason: "eligible" },
    });
  }));

it(
  "holds a check when its conversation history exceeds the byte bound",
  () =>
    Effect.gen(function* () {
      const subject = yield* fixture;
      yield* extendHistory(
        subject,
        yield* seedIncoming(subject, true),
        Array.from({ length: 70 }, () => "x".repeat(32_000)),
      );
      const seen: MiddlewareInput[] = [];
      const runtime = yield* outgoingFixture(subject, recordInputs(seen), {
        maximumHistoryRecords: 100,
        settings: { ...settings, maximumInputBytes: 4 * 1024 * 1024 },
      });
      const intentCount = (yield* subject.run(subject.store.recover()))
        .messageIntents.length;
      const refusal = yield* Effect.flip(
        runtime.operations.send({
          input: { to: destination, text: "Candidate after large history" },
        }),
      );

      expect(refusal).toMatchObject({ refusal: "unresolved-evidence" });
      expect(seen[0]?.context.gaps).not.toEqual([]);
      expect(
        (yield* subject.run(subject.store.recover())).messageIntents,
      ).toHaveLength(intentCount);
    }),
  { timeout: 30_000 },
);

it("rejects history whose stored message no longer matches its certified content", () =>
  Effect.gen(function* () {
    const subject = yield* fixture;
    yield* seedIncoming(subject, true);
    yield* subject.sql.unsafe(
      "UPDATE staged_records SET canonical_record_core=CAST(json_set(CAST(canonical_record_core AS TEXT),'$.action.messageIntent.content[0].text','Altered content') AS BLOB)",
    );
    const failure = yield* subject
      .run(
        readFirewallEvidence({
          conversationId: subject.membership.descriptor.conversationId,
          registrySignerPublicKey: subject.signer,
          maximumRecords: 2,
        }),
      )
      .pipe(Effect.flip);
    expect(failure).toBeInstanceOf(EndpointStoreError);
  }));
