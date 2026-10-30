/** @file Collectives retain resolved identities before accepting work and reuse them after restart. */

import { scoped as it } from "@effect/vitest";
import { Effect, Fiber, Schema, Scope, TestClock } from "effect";
import { expect } from "vitest";
import { SqlClient } from "@effect/sql";
import type { InboundItem } from "./inbound.js";
import type { CollectivePorts } from "./ports.js";
import { testAgentView } from "../../__tests__/agent-card-fixtures.js";
import {
  msgId,
  recordHashOf,
} from "../../__tests__/collective-operation-fixtures.js";
import { makeCollectiveOperations } from "../../__tests__/collective-send.js";
import {
  engineFixture,
  type Fixture,
} from "../../__tests__/firewall-runtime-fixtures.js";
import { withDaemonStore } from "../../__tests__/store-schema-fixtures.js";
import { SendError } from "../conversations/errors.js";
import { encodeRuntimeValue } from "../store/index.js";
import { SendInput } from "./contracts.js";

const input = Schema.decodeUnknownSync(SendInput)({
  to: "group:carol,bob",
  text: "Which day?",
  collective: {
    op: "gather",
    deadline: 60,
    requestedSchema: {
      type: "object",
      properties: { day: { type: "string" } },
    },
  },
});

it("refuses every initial lookup failure in member order before accepting or sending", () =>
  Effect.gen(function* () {
    const subject = yield* engineFixture();
    return yield* subject.run(
      Effect.gen(function* () {
        const operations = yield* makeCollectiveOperations({
          ...(yield* ports(subject, [])),
          scope: yield* Scope.Scope,
          prepareMessage: (input) =>
            Effect.fail(
              new SendError({
                reason:
                  input.to === "agent:bob"
                    ? "network-unavailable"
                    : "version-mismatch",
              }),
            ),
          sendMessage: () =>
            Effect.dieMessage("unresolved work cannot message"),
        });
        expect(yield* Effect.flip(operations.send(input))).toMatchObject({
          failure: {
            kind: "members-unreachable",
            members: [
              { member: "agent:bob", reason: "network-unavailable" },
              { member: "agent:carol", reason: "version-mismatch" },
            ],
          },
        });
        expect(yield* subject.store.readCollectiveOperations()).toEqual([]);
        expect(yield* subject.store.readCollectiveMessages()).toEqual([]);
      }),
    );
  }));

it("retains every resolved identity in an unanswered result after restart without Registry access", () =>
  Effect.gen(function* () {
    const subject = yield* retainedGatherDirectory();
    yield* TestClock.adjust("2 minutes");
    const delivered: InboundItem[] = [];
    yield* withDaemonStore(subject.directory, () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* makeCollectiveOperations({
            ...(yield* ports(subject, delivered)),
            scope: yield* Scope.Scope,
            prepareMessage: () =>
              Effect.dieMessage("recovery must use retained identities"),
          });
        }),
      ),
    );
    expect(delivered).toMatchObject([
      {
        kind: "collectiveResult",
        closedAt: 140_000,
        closedBy: "deadline",
        outcomes: [
          { member: testAgentView("bob"), outcome: { kind: "no-answer" } },
          { member: testAgentView("carol"), outcome: { kind: "no-answer" } },
        ],
      },
    ]);
  }));

function ports(
  subject: Fixture,
  delivered: InboundItem[],
): Effect.Effect<Omit<CollectivePorts, "scope">, never, SqlClient.SqlClient> {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    return {
      prepareMessage: subject.engine.prepare,
      acceptMessage: subject.engine.accept,
      self: testAgentView("agent:alice"),
      observeMessage: () => Effect.dieMessage("gather owns no close"),
      reportStorageFault: (error) => Effect.die(error),
      sendMessage: () =>
        Effect.succeed({ msgId: msgId(1), recordHash: recordHashOf(1) }),
      emit: (item, ...[, terminal]) =>
        Effect.gen(function* () {
          if (terminal === undefined || item.kind !== "collectiveResult") {
            return yield* Effect.dieMessage(
              "expected a retained terminal result",
            );
          }
          yield* subject.store.publishCollectiveItem({
            ...terminal,
            canonicalItem: yield* encodeRuntimeValue(item),
            conversation: item.to,
            firewall: false,
          });
          delivered.push(item);
        }).pipe(Effect.provideService(SqlClient.SqlClient, sql), Effect.orDie),
    };
  });
}

it("refuses retained operations belonging to another identity", () =>
  Effect.gen(function* () {
    const subject = yield* retainedGatherDirectory();
    const failure = yield* restoreForOtherIdentity(subject);
    expect(failure).toMatchObject({ reason: "corrupt" });
  }));

function retainedGatherDirectory() {
  return Effect.scoped(
    Effect.gen(function* () {
      const subject = yield* engineFixture();
      const operations = yield* subject.run(
        makeCollectiveOperations({
          ...(yield* subject.run(ports(subject, []))),
          scope: yield* Scope.Scope,
          prepareMessage: subject.engine.prepare,
        }),
      );
      const sending = yield* operations.send(input).pipe(Effect.fork);
      yield* TestClock.adjust("20 seconds");
      yield* Fiber.join(sending);
      return subject;
    }),
  );
}

function recoveryPreparation() {
  return Effect.dieMessage("recovery uses retained identities");
}

function restoreForOtherIdentity(subject: Fixture) {
  return withDaemonStore(subject.directory, () =>
    Effect.gen(function* () {
      const basePorts = yield* ports(subject, []);
      return yield* Effect.flip(
        makeCollectiveOperations({
          ...basePorts,
          scope: yield* Scope.Scope,
          self: testAgentView("bob"),
          prepareMessage: recoveryPreparation,
        }),
      );
    }),
  );
}
