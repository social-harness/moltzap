/** @file Collectives retain resolved identities before accepting work and reuse them after restart. */

import { scoped as it } from "@effect/vitest";
import { Effect, Schema, Scope, TestClock } from "effect";
import { expect } from "vitest";
import {
  engineFixture,
  resolvedMemberView,
} from "../../__tests__/firewall-runtime-fixtures.js";
import { testAgentView } from "../../__tests__/agent-card-fixtures.js";
import {
  postId,
  recordHashOf,
} from "../../__tests__/collective-operation-fixtures.js";
import {
  stateDirectory,
  withStore,
} from "../../__tests__/store-schema-fixtures.js";
import { SendError } from "../conversations/errors.js";
import { AgentAddress } from "../records/values.js";
import { encodeRuntimeValue, type EndpointStore } from "../store/index.js";
import { SendInput } from "./contracts.js";
import { type InboundItem } from "./inbound.js";
import { makeCollectiveOperations } from "./index.js";
import type { CollectivePorts } from "./ports.js";

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

it("refuses every initial lookup failure in member order before accepting or posting", () =>
  withStore(stateDirectory(), (store) =>
    Effect.scoped(
      Effect.gen(function* () {
        const operations = yield* makeCollectiveOperations({
          ...ports(store, []),
          scope: yield* Scope.Scope,
          lookupMember: (member) =>
            Effect.fail(
              new SendError({
                reason:
                  member === "agent:bob"
                    ? "network-unavailable"
                    : "version-mismatch",
              }),
            ),
          sendPost: () => Effect.dieMessage("unresolved work cannot post"),
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
        expect(yield* store.readCollectivePosts()).toEqual([]);
      }),
    ),
  ));

it("retains every resolved identity in an unanswered result after restart without Registry access", () =>
  Effect.gen(function* () {
    const directory = yield* Effect.scoped(
      Effect.gen(function* () {
        const subject = yield* engineFixture();
        const operations = yield* makeCollectiveOperations({
          ...ports(subject.store, []),
          scope: yield* Scope.Scope,
          lookupMember: (member) => resolvedMemberView(subject.engine, member),
          sendPost: (request) =>
            request.to === "agent:carol"
              ? Effect.fail(new SendError({ reason: "network-unavailable" }))
              : Effect.succeed({
                  postId: postId(1),
                  recordHash: recordHashOf(1),
                }),
        });
        yield* operations.send(input);
        return subject.directory;
      }),
    );
    yield* TestClock.adjust("2 minutes");
    const delivered: InboundItem[] = [];
    yield* withStore(directory, (store) =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* makeCollectiveOperations({
            ...ports(store, delivered),
            scope: yield* Scope.Scope,
            lookupMember: () =>
              Effect.dieMessage("recovery must use retained identities"),
          });
        }),
      ),
    );
    expect(delivered).toMatchObject([
      {
        kind: "collectiveResult",
        outcomes: [
          { member: testAgentView("bob"), outcome: { kind: "no-answer" } },
          { member: testAgentView("carol"), outcome: { kind: "no-answer" } },
        ],
      },
    ]);
  }));

function ports(
  store: EndpointStore,
  delivered: InboundItem[],
): Omit<CollectivePorts, "scope" | "lookupMember"> {
  return {
    store,
    self: Schema.decodeUnknownSync(AgentAddress)("agent:alice"),
    bindPost: () => Effect.dieMessage("gather uses request fanout"),
    observePost: () => Effect.dieMessage("gather owns no close"),
    sendAdmitted: () => Effect.dieMessage("no firewall in this test"),
    reportStorageFault: (error) => Effect.die(error),
    sendPost: () =>
      Effect.succeed({ postId: postId(1), recordHash: recordHashOf(1) }),
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
}
