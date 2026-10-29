/** @file Accepted gather admission and fanout keep their owner after caller interruption. */

import { scoped as it } from "@effect/vitest";
import {
  Deferred,
  Effect,
  Exit,
  Fiber,
  Schema,
  Scope,
  TestClock,
} from "effect";
import { expect } from "vitest";
import type { EndpointStore, EndpointStoreError } from "../store/index.js";
import type { InboundItem } from "./inbound.js";
import { untilLive } from "../../__tests__/advance-clock.js";
import {
  engineFixture,
  type Fixture,
  installation,
  pass,
  policy,
} from "../../__tests__/firewall-runtime-fixtures.js";
import { collectiveAdmission } from "../../firewall/admission/index.js";
import { AgentAddress } from "../records/index.js";
import { makeCollectiveOperations } from "./index.js";

it.each(["plain", "firewall"] as const)(
  "finalizes %s gather admission after its caller is interrupted",
  (mode) =>
    Effect.gen(function* () {
      const fixture = yield* admissionFixture(mode);
      const sending = yield* fixture.collective
        .send({
          to: Schema.decodeUnknownSync(AgentAddress)("agent:bob"),
          text: "Can you attend?",
          collective: {
            op: "gather",
            deadline: 60,
            requestedSchema: { type: "object", properties: {} },
          },
        })
        .pipe(Effect.fork);
      yield* Deferred.await(fixture.committed);
      expect(yield* fixture.store.readCollectiveOperations()).toMatchObject([
        { phase: "collecting" },
      ]);
      yield* Fiber.interruptFork(sending);
      yield* Deferred.succeed(fixture.release, undefined);
      expect(Exit.isInterrupted(yield* Fiber.await(sending))).toBe(true);
      yield* mode === "plain"
        ? Deferred.await(fixture.started)
        : waitForRequest(fixture.store);
      yield* TestClock.adjust("2 minutes");
      expect(fixture.emitted).toMatchObject([
        {
          kind: "collectiveResult",
          outcomes: [{ member: "agent:bob", outcome: { kind: "no-answer" } }],
        },
      ]);
    }),
);

function admissionFixture(mode: "plain" | "firewall") {
  return Effect.gen(function* () {
    const subject = yield* engineFixture();
    const committed = yield* Deferred.make<undefined>();
    const release = yield* Deferred.make<undefined>();
    const started = yield* Deferred.make<undefined>();
    const emitted: InboundItem[] = [];
    const store: EndpointStore = {
      ...subject.store,
      putCollectiveOperation: (operation) =>
        pauseCommit(
          subject.store.putCollectiveOperation(operation),
          committed,
          release,
        ),
      admitFirewallOperation: (completion, candidate, operation) =>
        pauseCommit(
          subject.store.admitFirewallOperation(
            completion,
            candidate,
            operation,
          ),
          committed,
          release,
        ),
    };
    const admission = yield* installedAdmission(subject, store, mode);
    const collective = yield* makeCollectiveOperations({
      store,
      self: Schema.decodeUnknownSync(AgentAddress)("agent:alice"),
      scope: yield* Scope.Scope,
      lookupMember: () => Effect.void,
      sendPost: () =>
        Deferred.succeed(started, undefined).pipe(
          Effect.zipRight(Effect.never),
        ),
      bindPost: () => Effect.dieMessage("gather uses request fanout"),
      sendAdmitted: () => Effect.never,
      observePost: () => Effect.never,
      reportStorageFault: () => Effect.dieMessage("unexpected storage fault"),
      emit: (item) =>
        Effect.sync(() => {
          emitted.push(item);
        }),
      ...(admission === undefined ? {} : { admission }),
    });
    return { store, collective, committed, release, started, emitted };
  });
}

function pauseCommit<A>(
  write: Effect.Effect<A, EndpointStoreError>,
  committed: Deferred.Deferred<undefined>,
  release: Deferred.Deferred<undefined>,
) {
  return write.pipe(
    Effect.tap(() => Deferred.succeed(committed, undefined)),
    Effect.tap(() => Deferred.await(release)),
  );
}

function installedAdmission(
  subject: Fixture,
  store: EndpointStore,
  mode: "plain" | "firewall",
) {
  return mode === "plain"
    ? Effect.succeed(undefined)
    : installation(
        store,
        policy(() => Effect.succeed(pass)),
      ).pipe(
        Effect.map((installed) =>
          collectiveAdmission(
            { installed, store, localAgentCard: subject.local.card },
            subject.engine,
          ),
        ),
      );
}

function waitForRequest(store: EndpointStore) {
  return untilLive(
    store.readCollectivePosts().pipe(
      Effect.map((posts) => posts.some((post) => post.role === "request")),
      Effect.orDie,
    ),
  );
}
