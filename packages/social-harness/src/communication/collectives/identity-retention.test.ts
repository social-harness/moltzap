/** @file Collectives retain resolved identities before accepting work and reuse them after restart. */

import { scoped as it } from "@effect/vitest";
import { Effect, Schema, Scope, TestClock } from "effect";
import { expect } from "vitest";
import type { DaemonStore } from "../../daemon/store.js";
import type { InboundItem } from "./inbound.js";
import type { CollectivePorts } from "./ports.js";
import { testAgentView } from "../../__tests__/agent-card-fixtures.js";
import {
  msgId,
  recordHashOf,
} from "../../__tests__/collective-operation-fixtures.js";
import { makeCollectiveOperations } from "../../__tests__/collective-send.js";
import { collectivePersistencePorts } from "../../__tests__/collective-storage-stub.js";
import { engineFixture } from "../../__tests__/firewall-runtime-fixtures.js";
import {
  stateDirectory,
  withDaemonStore,
} from "../../__tests__/store-schema-fixtures.js";
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
  withDaemonStore(stateDirectory(), (store) =>
    Effect.scoped(
      Effect.gen(function* () {
        const operations = yield* makeCollectiveOperations({
          ...(yield* ports(store, [])),
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
        expect(yield* store.readCollectiveOperations()).toEqual([]);
        expect(yield* store.readCollectiveMessages()).toEqual([]);
      }),
    ),
  ));

it("retains every resolved identity in an unanswered result after restart without Registry access", () =>
  Effect.gen(function* () {
    const directory = yield* Effect.scoped(
      Effect.gen(function* () {
        const subject = yield* engineFixture();
        const operations = yield* makeCollectiveOperations({
          ...(yield* ports(subject.store, [])),
          scope: yield* Scope.Scope,
          prepareMessage: subject.engine.prepare,
          sendMessage: (request) =>
            request.to === "agent:carol"
              ? Effect.fail(new SendError({ reason: "network-unavailable" }))
              : Effect.succeed({
                  msgId: msgId(1),
                  recordHash: recordHashOf(1),
                }),
        });
        yield* operations.send(input);
        return subject.directory;
      }),
    );
    yield* TestClock.adjust("2 minutes");
    const delivered: InboundItem[] = [];
    yield* withDaemonStore(directory, (store) =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* makeCollectiveOperations({
            ...(yield* ports(store, delivered)),
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
        closedAt: 120_000,
        closedBy: "deadline",
        outcomes: [
          { member: testAgentView("bob"), outcome: { kind: "no-answer" } },
          { member: testAgentView("carol"), outcome: { kind: "no-answer" } },
        ],
      },
    ]);
  }));

function ports(
  store: DaemonStore,
  delivered: InboundItem[],
): Effect.Effect<Omit<CollectivePorts, "scope">> {
  return Effect.gen(function* () {
    const persistence = yield* collectivePersistencePorts(() =>
      Effect.succeed({ msgId: msgId(1), recordHash: recordHashOf(1) }),
    );
    return {
      ...persistence,
      store,
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
          yield* store.publishCollectiveItem({
            ...terminal,
            canonicalItem: yield* encodeRuntimeValue(item),
            conversation: item.to,
            firewall: false,
          });
          delivered.push(item);
        }).pipe(Effect.orDie),
    };
  });
}

it.each(["identity", "creator"] as const)(
  "refuses retained operations belonging to another %s",
  refusesForeignOperation,
);

function refusesForeignOperation(changed: "identity" | "creator") {
  return Effect.gen(function* () {
    const directory = yield* retainedGatherDirectory();
    const scope = yield* Scope.Scope;
    const failure = yield* withDaemonStore(directory, (store) =>
      Effect.gen(function* () {
        const basePorts = yield* ports(store, []);
        return yield* Effect.flip(
          makeCollectiveOperations({
            ...basePorts,
            scope,
            self: testAgentView(changed === "identity" ? "bob" : "alice"),
            store:
              changed === "creator" ? misattributedOperations(store) : store,
            prepareMessage: recoveryPreparation,
          }),
        );
      }),
    );
    expect(failure).toMatchObject({ reason: "corrupt" });
  });
}

function retainedGatherDirectory() {
  return Effect.scoped(
    Effect.gen(function* () {
      const subject = yield* engineFixture();
      const operations = yield* makeCollectiveOperations({
        ...(yield* ports(subject.store, [])),
        scope: yield* Scope.Scope,
        prepareMessage: subject.engine.prepare,
      });
      yield* operations.send(input);
      return subject.directory;
    }),
  );
}

function misattributedOperations(store: DaemonStore): DaemonStore {
  return {
    ...store,
    readCollectiveOperations: () =>
      store.readCollectiveOperations().pipe(
        Effect.map((operations) =>
          operations.map((operation) => ({
            ...operation,
            creatorAgentId: testAgentView("bob").agentId,
          })),
        ),
      ),
  };
}

function recoveryPreparation() {
  return Effect.dieMessage("recovery uses retained identities");
}
