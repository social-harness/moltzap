/** @file Host sends assess one captured draft before accepting protocol custody. */

import { scopedLive as it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";
import { expect } from "vitest";
import type { MiddlewareInput } from "../../firewall/check.js";
import { collectiveOperationId } from "../../__tests__/collective-id-fixtures.js";
import {
  block,
  destination,
  fixture,
  outgoingFixture,
  pass,
  policy,
  seedIncoming,
} from "../../__tests__/firewall-runtime-fixtures.js";

// @agent-code-guard/regression-only: Real SQLite and the protocol engine verify admission and host-visible publication.

it(
  "does not accept a cancelled draft and releases its check permit",
  interruptedSend,
);

function interruptedSend() {
  return Effect.gen(function* () {
    const subject = yield* fixture;
    const entered = yield* Deferred.make<undefined>();
    let calls = 0;
    const delivery = yield* outgoingFixture(
      subject,
      policy(() =>
        Effect.suspend(() => {
          calls += 1;
          return calls === 1
            ? Deferred.succeed(entered, undefined).pipe(
                Effect.zipRight(Effect.never),
              )
            : Effect.succeed(block);
        }),
      ),
      { maximumConcurrentChecks: 1 },
    );
    const sending = yield* delivery.operations
      .send({ input: { to: destination, text: "Cancelled draft" } })
      .pipe(Effect.forkScoped);
    yield* Deferred.await(entered);
    yield* Fiber.interrupt(sending);
    expect(
      (yield* subject.run(subject.store.recover())).messageIntents,
    ).toEqual([]);
    expect(
      yield* Effect.flip(
        delivery.operations.send({
          input: { to: destination, text: "Another draft" },
        }),
      ),
    ).toMatchObject({ refusal: "rule-violation" });
  });
}

it("keeps one captured assessment and exact draft while retained visibility changes", () =>
  Effect.gen(function* () {
    const subject = yield* fixture;
    yield* seedIncoming(subject, true);
    const entered = yield* Deferred.make<undefined>();
    const release = yield* Deferred.make<undefined>();
    const seen: MiddlewareInput[] = [];
    const delivery = yield* outgoingFixture(
      subject,
      policy(captureAndWait(seen, entered, release)),
    );
    const originalText = "Captured original draft";
    const changedText = "Caller changed the draft";
    const draft = { to: destination, text: originalText };
    const sending = yield* delivery.operations
      .send({ input: draft })
      .pipe(Effect.forkScoped);
    yield* Deferred.await(entered);
    draft.text = changedText;
    yield* delivery.queueLocalItem({
      kind: "operationFailed",
      operationId: collectiveOperationId(subject.local.card.agentId),
      to: destination,
      error: "A later local result",
    });
    yield* Deferred.succeed(release, undefined);
    yield* Deferred.await(subject.outbound);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.event.message?.text).toBe(originalText);
    const pending = (yield* subject.run(
      subject.store.recover(),
    )).messageIntents.filter(
      (intent) => intent.completedRecordHash === undefined,
    );
    expect(pending).toHaveLength(1);
    const retained = yield* Effect.fromNullable(pending[0]);
    expect(new TextDecoder().decode(retained.canonicalIntent)).toContain(
      originalText,
    );
    expect(new TextDecoder().decode(retained.canonicalIntent)).not.toContain(
      changedText,
    );
    yield* Fiber.interrupt(sending);
  }));

function captureAndWait(
  seen: MiddlewareInput[],
  entered: Deferred.Deferred<undefined>,
  release: Deferred.Deferred<undefined>,
) {
  return (input: MiddlewareInput) =>
    Effect.gen(function* () {
      seen.push(input);
      yield* Deferred.succeed(entered, undefined);
      yield* Deferred.await(release);
      return pass;
    });
}
