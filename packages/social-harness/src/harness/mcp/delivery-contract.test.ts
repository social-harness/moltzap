/** @file Durable delivery behaviour through the loopback MCP tools and native endpoint. */

import { scopedLive as it } from "@effect/vitest";
import { Chunk, Effect, Schema, Scope, Stream } from "effect";
import { describe, expect } from "vitest";
import type { PostSender } from "../../communication/collectives/ports.js";
import type { EndpointEngine } from "../../communication/conversations/index.js";
import { digest } from "../../__tests__/agent-card-fixtures.js";
import { makeToolCallRequest } from "../../__tests__/daemon-runtime-harness.js";
import { loopbackMcpEndpoint } from "../../__tests__/mcp-http-fixtures.js";
import { pendingMessage } from "../../__tests__/pending-delivery-fixtures.js";
import { stateDirectory } from "../../__tests__/store-schema-fixtures.js";
import {
  CollectiveEmitError,
  CollectiveId,
} from "../../communication/collectives/forms.js";
import {
  type CollectiveOperations,
  makeCollectiveOperations,
} from "../../communication/collectives/index.js";
import { encodeCollectiveContent } from "../../communication/collectives/part/index.js";
import { DeliveryAcknowledgeError } from "../../communication/conversations/errors.js";
import { AgentAddress } from "../../communication/records/index.js";
import { openEndpointStore } from "../../communication/store/index.js";
import { LIVE_WIRE_VERSIONS } from "../../identity/wire-version.js";
import { acquireHarnessEndpoint } from "../endpoint/index.js";
import { type HostDelivery, makeHostDelivery } from "../inbox/host-delivery.js";
import { decodeHarnessReadInboxResult } from "../protocol/operations.js";
import { makeHarnessMcpHttpHandler } from "./tools.js";

const unreachable = () =>
  Effect.dieMessage("operation is outside the delivery contract");
const pending = pendingMessage(1);
const acknowledgingEngine: Pick<EndpointEngine, "acknowledgeMessage"> = {
  acknowledgeMessage: () => Effect.void,
};

/** Supplies committed deliveries and acknowledgment faults behind the real classifier. */
const deliverPending =
  (delivery: HostDelivery, collectives: CollectiveOperations) =>
  (messages = [pending], engine = acknowledgingEngine) =>
    delivery.runPass(() => ({
      readPending: Effect.succeed(messages),
      engine,
      classify: collectives.classify,
    }));

/** Only delivery operations are reachable from these MCP transcripts. */
const deliveryHandler = (
  operations: Parameters<typeof makeHarnessMcpHttpHandler>[0]["operations"],
) =>
  makeHarnessMcpHttpHandler({
    implementation: { name: "delivery-contract", version: "1" },
    operations,
  });

const callTool =
  (handler: Parameters<typeof loopbackMcpEndpoint>[0]) =>
  (name: string, args: Readonly<Record<string, unknown>> = {}) =>
    Effect.tryPromise(() =>
      handler.fetch(
        makeToolCallRequest({ id: "delivery", name, toolArguments: args }),
      ),
    ).pipe(
      Effect.flatMap((response) => Effect.tryPromise(() => response.json())),
      Effect.flatMap(
        Schema.decodeUnknown(
          Schema.Struct({
            result: Schema.Struct({ structuredContent: Schema.Unknown }),
          }),
        ),
      ),
      Effect.map((response) => response.result),
    );

/** Real delivery, collective classification and storage behind the MCP boundary. */
const deliveryFixture = (sendPost: PostSender = unreachable) =>
  Effect.gen(function* () {
    const store = yield* openEndpointStore(stateDirectory(), {
      liveWireVersions: LIVE_WIRE_VERSIONS,
    });
    const scope = yield* Scope.Scope;
    const slot: { active?: CollectiveOperations } = {};
    const delivery = yield* makeHostDelivery({
      store,
      scope,
      historyExport: { record: () => Effect.void },
      collectives: () => slot.active,
    });
    const collectives = yield* makeCollectiveOperations({
      store,
      observePost: unreachable,
      sendAdmitted: unreachable,
      reportStorageFault: () => Effect.void,
      self: Schema.decodeUnknownSync(AgentAddress)("agent:alice"),
      lookupMember: () => Effect.void,
      sendPost,
      emit: (item, provenance, terminal) =>
        delivery
          .queueLocalItem(item, provenance, terminal)
          .pipe(
            Effect.catchTag("EndpointStoreError", () =>
              Effect.fail(new CollectiveEmitError()),
            ),
          ),
      scope,
    });
    slot.active = collectives;
    const handler = yield* deliveryHandler({
      ...delivery.operations,
      protocolActive: () => true,
      readStatus: unreachable,
      register: unreachable,
      searchAgents: unreachable,
      searchConversations: unreachable,
      readConversation: unreachable,
    });
    const url = yield* loopbackMcpEndpoint(handler);
    const call = callTool(handler);
    const inbox = call("read_inbox").pipe(
      Effect.flatMap((result) =>
        decodeHarnessReadInboxResult(result.structuredContent),
      ),
    );
    const deliver = deliverPending(delivery, collectives);
    return { url, call, inbox, deliver };
  });

const fixture = deliveryFixture();

it("returns a collective layer success without advice through the MCP writer", () =>
  Effect.gen(function* () {
    const test = yield* deliveryFixture(() =>
      Effect.succeed({
        postId: pending.message.postId,
        recordHash: pending.recordHash,
      }),
    );
    const sent = yield* test.call("send_message", {
      input: { to: "agent:bob", text: "Hello" },
    });
    expect(sent.structuredContent).toEqual({
      kind: "multicast",
      postId: pending.message.postId,
      address: "agent:bob",
    });
  }));

const consumesAnswers = () =>
  Effect.gen(function* () {
    const test = yield* fixture;
    const answer = pendingMessage(2);
    const content = yield* encodeCollectiveContent({
      kind: "response",
      id: Schema.decodeUnknownSync(CollectiveId)(digest("col_", 2)),
      action: "decline",
    });
    yield* test.deliver([
      { ...answer, message: { ...answer.message, content } },
    ]);
    expect((yield* test.inbox).items).toEqual([]);
    yield* test.deliver();
    expect((yield* test.inbox).items).toEqual([
      {
        deliveryToken: pending.deliveryToken,
        item: { kind: "multicast", message: pending.message },
      },
    ]);
  });

const continuesAfterAnswerAcknowledgmentFails = () =>
  Effect.gen(function* () {
    const test = yield* fixture;
    const answer = pendingMessage(2);
    const content = yield* encodeCollectiveContent({
      kind: "response",
      id: Schema.decodeUnknownSync(CollectiveId)(digest("col_", 2)),
      action: "decline",
    });
    yield* test.deliver(
      [{ ...answer, message: { ...answer.message, content } }, pending],
      {
        acknowledgeMessage: () =>
          Effect.fail(
            new DeliveryAcknowledgeError({ reason: "persistence-failed" }),
          ),
      },
    );
    expect((yield* test.inbox).items).toEqual([
      {
        deliveryToken: pending.deliveryToken,
        item: { kind: "multicast", message: pending.message },
      },
    ]);
  });

const replaysUntilAcknowledged = () =>
  Effect.gen(function* () {
    const test = yield* fixture;
    yield* test.deliver();
    const page = yield* test.inbox;
    expect(page.items).toEqual([
      {
        deliveryToken: pending.deliveryToken,
        item: { kind: "multicast", message: pending.message },
      },
    ]);
    expect(yield* test.inbox).toEqual(page);
    yield* test.call("acknowledge_delivery", {
      deliveryToken: pending.deliveryToken,
    });
    expect((yield* test.inbox).items).toEqual([]);
  });

const returnsACollectiveRefusal = () =>
  Effect.gen(function* () {
    const test = yield* fixture;
    const endpoint = yield* acquireHarnessEndpoint(test.url);
    const failure = yield* Effect.flip(
      endpoint.send({
        to: Schema.decodeUnknownSync(AgentAddress)("agent:bob"),
        collectiveResponse: { action: "decline" },
      }),
    );
    expect(failure).toMatchObject({
      _tag: "CollectiveError",
      failure: { kind: "request-none" },
    });
    expect((yield* test.inbox).items).toEqual([]);
  });

const retainsEventReference = () =>
  Effect.gen(function* () {
    const test = yield* fixture;
    yield* test.deliver();
    const endpoint = yield* acquireHarnessEndpoint(test.url);
    const first = yield* endpoint.messages.pipe(
      Stream.take(1),
      Stream.runCollect,
      Effect.map(Chunk.unsafeHead),
    );
    yield* endpoint.messages.pipe(
      Stream.take(1),
      Stream.runForEach((delivery) =>
        Effect.gen(function* () {
          expect(delivery.eventId).toBe(first.eventId);
          yield* delivery.acknowledge;
          const retained = yield* test.call("read_event", {
            eventId: delivery.eventId,
          });
          expect(retained.structuredContent).toEqual({ item: first.item });
        }),
      ),
    );
    expect((yield* test.inbox).items).toEqual([]);
  });

const retainsFailedHandoff = () =>
  Effect.gen(function* () {
    const test = yield* fixture;
    const later = pendingMessage(2);
    yield* test.deliver([pending, later]);
    const endpoint = yield* acquireHarnessEndpoint(test.url);
    const failure = new Error("host refused handoff");
    const outcome = yield* endpoint.messages.pipe(
      Stream.mapEffect((entry) => Effect.fail({ failure, item: entry.item })),
      Stream.runDrain,
      Effect.flip,
    );
    expect(outcome).toEqual({
      failure,
      item: { kind: "multicast", message: pending.message },
    });
    const replay = yield* endpoint.messages.pipe(
      Stream.take(2),
      Stream.map((entry) => entry.item),
      Stream.runCollect,
    );
    expect(Chunk.toReadonlyArray(replay)).toEqual([
      { kind: "multicast", message: pending.message },
      { kind: "multicast", message: later.message },
    ]);
    expect((yield* test.inbox).items).toEqual([
      {
        deliveryToken: pending.deliveryToken,
        item: { kind: "multicast", message: pending.message },
      },
      {
        deliveryToken: later.deliveryToken,
        item: { kind: "multicast", message: later.message },
      },
    ]);
  });

// @agent-code-guard/regression-only: MCP conformance requires explicit delivery and failure transcripts.
describe("MCP delivery contract", () => {
  it(
    "keeps a native event reference stable across redelivery and readable after acknowledgment",
    retainsEventReference,
  );
  it(
    "delivers a later multicast when acknowledging a consumed answer fails",
    continuesAfterAnswerAcknowledgmentFails,
  );
  it(
    "consumes protocol answers without exposing them in the inbox",
    consumesAnswers,
  );
  it(
    "replays the same item until its token is acknowledged",
    replaysUntilAcknowledged,
  );
  it(
    "returns a collective refusal without creating an inbox outcome",
    returnsACollectiveRefusal,
  );
  it(
    "replays a refused item before later deliveries when the native handoff fails",
    retainsFailedHandoff,
  );
});
