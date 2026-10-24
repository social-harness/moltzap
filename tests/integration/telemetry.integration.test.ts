/** @file Real daemons export their spans, and mark collectives and retries, over OTLP/HTTP protobuf. */

import { CollectiveError, type InboundItem } from "@moltzap/client";
import { Duration, Effect, Fiber } from "effect";
import { expect, it } from "vitest";
import {
  acquireProcessInfrastructure,
  type DaemonProcessFixture,
  makeDaemonProcessFixture,
  processTrace,
} from "./daemon-process-harness.js";
import {
  acquireOtlpReceiver,
  awaitSpans,
  type ExportedSpan,
  type OtlpReceiver,
} from "./otlp-receiver.js";
import {
  groupAddress,
  nextItem,
  type Participant,
  send,
  startParticipants,
} from "./participants.js";
import { acquireRouterHoldProxy } from "./router-hold-proxy.js";

/**
 * Each test starts PGlite, the Registry, the Router and two or three
 * daemons; the marker trace also waits out one all_gather's 20 s request
 * wait, a proposal's next resend and a Router restart's recovery. Beside it
 * the waits are bounded by the receiver's own span-wait limit.
 */
const TELEMETRY_TEST_TIMEOUT_MS = 300_000;

/** An operation's deadline when only its answers should close it: the test's own limit. */
const ANSWERED_DEADLINE_SECONDS = TELEMETRY_TEST_TIMEOUT_MS / 1000;

/** The standard batch delay, shortened from 5 s so spans reach the receiver sooner. */
const BATCH_DELAY = Duration.millis(100);

/**
 * How long a daemon without an endpoint must stay silent after the exporting
 * daemon's spans arrive.
 */
const SILENCE_WINDOW = Duration.times(BATCH_DELAY, 20);

const question = "Which day works for the review?";
const slotSchema = {
  type: "object",
  properties: { slot: { type: "string", enum: ["mon", "tue"] } },
  required: ["slot"],
} as const;

function withEnvironment(
  fixture: DaemonProcessFixture,
  environment: Readonly<Record<string, string>>,
): DaemonProcessFixture {
  return {
    ...fixture,
    environment: { ...fixture.environment, ...environment },
  };
}

/**
 * The standard variables that point one daemon's spans at `receiver`. The
 * protocol is left to its http/protobuf default.
 */
function exportingTo(
  fixture: DaemonProcessFixture,
  receiver: OtlpReceiver,
): DaemonProcessFixture {
  return withEnvironment(fixture, {
    OTEL_EXPORTER_OTLP_ENDPOINT: receiver.endpoint.origin,
    OTEL_RESOURCE_ATTRIBUTES: `sharness.agent=${fixture.agentName}`,
    OTEL_BSP_SCHEDULE_DELAY: String(Duration.toMillis(BATCH_DELAY)),
  });
}

function named(
  spans: readonly ExportedSpan[],
  name: string,
): readonly ExportedSpan[] {
  return spans.filter((span) => span.name === name);
}

/** Every marker span `name` that carries `attributes.key === value`. */
function markers(
  spans: readonly ExportedSpan[],
  name: string,
  key: string,
  value: string,
): readonly ExportedSpan[] {
  return named(spans, name).filter((span) => span.attributes[key] === value);
}

function attributesOf(spans: readonly ExportedSpan[]) {
  return spans.map(({ attributes }) => attributes);
}

/**
 * Every `retry.pending` span still unsettled. Each settled span settles one
 * pending span with its kind and id, from the same daemon: a re-proposed post
 * starts a second schedule under the same id, and every daemon's outbox
 * drains under one id.
 */
function unsettledRetries(spans: readonly ExportedSpan[]): ExportedSpan[] {
  const key = (span: ExportedSpan) =>
    [
      span.resource["sharness.agent"],
      span.attributes["kind"],
      span.attributes["id"],
    ].join(" ");
  const settled = named(spans, "retry.settled").map(key);
  return named(spans, "retry.pending").filter((span) => {
    const match = settled.indexOf(key(span));
    if (match === -1) {
      return true;
    }
    settled.splice(match, 1);
    return false;
  });
}

/**
 * Expect the operation `id` marked open once, with the deadline its request
 * carried, then closed once as completed.
 */
function expectMarked(
  spans: readonly ExportedSpan[],
  id: string,
  request: InboundItem,
  op: "gather" | "all_gather",
): void {
  const opened = markers(spans, "collective.opened", "operationId", id);
  const closed = markers(spans, "collective.closed", "operationId", id);
  expect(attributesOf(opened)).toEqual([
    { operationId: id, op, deadlineAt: expect.any(Number) },
  ]);
  expect(attributesOf(closed)).toEqual([
    { operationId: id, outcome: "completed" },
  ]);
  expect(request).toMatchObject({
    kind: "collectiveRequest",
    id,
    deadlineAt: opened[0]?.attributes["deadlineAt"],
  });
  expect(opened[0]?.startTimeUnixNano).toBeLessThan(
    closed[0]?.startTimeUnixNano ?? 0n,
  );
}

/** The exporting daemon runs `sharnessd`, which is `Daemon.layer`. */
const exportBehavior = Effect.gen(function* () {
  const infrastructure = yield* acquireProcessInfrastructure;
  const receiver = yield* acquireOtlpReceiver;
  const silentReceiver = yield* acquireOtlpReceiver;
  const exporting = exportingTo(
    yield* makeDaemonProcessFixture(infrastructure, "otel-exporting"),
    receiver,
  );
  /**
   * Every exporter setting but a non-empty `OTEL_EXPORTER_OTLP_ENDPOINT`: an
   * empty endpoint is unset, and a traces-only endpoint opts nothing in.
   */
  const silent = withEnvironment(
    yield* makeDaemonProcessFixture(infrastructure, "otel-silent"),
    {
      OTEL_EXPORTER_OTLP_ENDPOINT: "",
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: new URL(
        "/v1/traces",
        silentReceiver.endpoint,
      ).href,
      OTEL_BSP_SCHEDULE_DELAY: String(Duration.toMillis(BATCH_DELAY)),
    },
  );
  const [sender, target] = yield* startParticipants([exporting, silent]);
  if (sender === undefined || target === undefined) {
    return yield* Effect.dieMessage("expected two participants");
  }

  yield* send(sender, { to: target.address, text: "sent by the exporter" });
  yield* nextItem(target);
  yield* send(target, { to: sender.address, text: "received by the exporter" });
  yield* nextItem(sender);

  const spans = yield* awaitSpans(
    receiver,
    (received) =>
      named(received, "EndpointEngine.send").length > 0 &&
      named(received, "persistInboxItem").length > 0,
  );
  expect(named(spans, "persistInboxItem")[0]?.resource).toMatchObject({
    "service.name": "sharnessd",
    "sharness.agent": "otel-exporting",
  });
  yield* Effect.sleep(SILENCE_WINDOW);
  expect(yield* silentReceiver.connections).toBe(0);
}).pipe(Effect.scoped);

const gatherFrom = (
  requester: Participant,
  to: string,
  op: "gather" | "all_gather",
) =>
  send(requester, {
    to,
    text: question,
    collective: {
      op,
      deadline: ANSWERED_DEADLINE_SECONDS,
      requestedSchema: slotSchema,
    },
  });

/**
 * The requester exports and installs a firewall that passes every message,
 * so it runs `Daemon.withFirewall` and the firewall's checks admit its
 * collectives. It names its service through `OTEL_RESOURCE_ATTRIBUTES`. The
 * third daemon reaches the Router through a hold proxy. In a three-member
 * group every post needs every member, so holding that member keeps the
 * requester's proposals uncertified. A restarted Router is a new instance, so
 * afterwards every conversation catches up.
 */
const markerBehavior = Effect.gen(function* () {
  const infrastructure = yield* acquireProcessInfrastructure;
  const receiver = yield* acquireOtlpReceiver;
  const proxy = yield* acquireRouterHoldProxy(infrastructure.routerOrigin);
  const fixtures = [
    withEnvironment(
      exportingTo(
        yield* makeDaemonProcessFixture(
          infrastructure,
          "otel-requester",
          "guidance",
        ),
        receiver,
      ),
      {
        OTEL_RESOURCE_ATTRIBUTES:
          "service.name=otel-requester-service,sharness.agent=otel-requester",
      },
    ),
    yield* makeDaemonProcessFixture(infrastructure, "otel-member-a"),
    withEnvironment(
      yield* makeDaemonProcessFixture(infrastructure, "otel-member-b"),
      { SHARNESS_ROUTER_ORIGIN: proxy.origin.origin },
    ),
  ];
  const [requester, member, held] = yield* startParticipants(fixtures);
  if (requester === undefined || member === undefined || held === undefined) {
    return yield* Effect.dieMessage("expected three participants");
  }
  const group = groupAddress([requester, member, held]);

  const gathered = yield* gatherFrom(requester, group, "gather");
  const gatherRequest = yield* nextItem(member);
  yield* nextItem(held);
  yield* send(member, {
    to: requester.address,
    collectiveResponse: { action: "accept", content: { slot: "mon" } },
  });
  yield* send(held, {
    to: requester.address,
    collectiveResponse: { action: "decline" },
  });
  yield* nextItem(requester);

  const allGathered = yield* gatherFrom(requester, group, "all_gather");
  const allGatherRequest = yield* nextItem(member);
  yield* nextItem(held);
  yield* send(member, {
    to: group,
    collectiveResponse: { action: "accept", content: { slot: "tue" } },
  });
  yield* send(held, {
    to: group,
    collectiveResponse: { action: "decline" },
  });
  yield* Effect.forEach([requester, member, held], nextItem);

  const gatherId = gathered.operationId ?? "";
  const allGatherId = allGathered.operationId ?? "";
  /** Every earlier proposal settles too, so the held send's is the one left pending. */
  const completed = yield* awaitSpans(
    receiver,
    (received) =>
      markers(received, "collective.closed", "operationId", gatherId).length >
        0 &&
      markers(received, "collective.closed", "operationId", allGatherId)
        .length > 0 &&
      unsettledRetries(received).length === 0,
  );
  expectMarked(completed, gatherId, gatherRequest, "gather");
  expectMarked(completed, allGatherId, allGatherRequest, "all_gather");
  expect(
    markers(completed, "collective.opened", "operationId", gatherId)[0]
      ?.resource,
  ).toMatchObject({
    "service.name": "otel-requester-service",
    "sharness.agent": "otel-requester",
  });
  expect(
    attributesOf(markers(completed, "retry.settled", "kind", "firewall-check")),
  ).toContainEqual({
    kind: "firewall-check",
    id: "outgoing",
    outcome: "checked",
  });
  expect(
    attributesOf(markers(completed, "retry.settled", "kind", "outbound")),
  ).toContainEqual({ kind: "outbound", id: "outbox", outcome: "sent" });

  yield* proxy.hold;
  yield* Effect.addFinalizer(() => proxy.release);
  const heldSend = yield* Effect.fork(
    send(requester, {
      to: held.address,
      text: "sent while the member is held",
    }),
  );
  const unsettledProposals = (received: readonly ExportedSpan[]) =>
    unsettledRetries(received).filter(
      (span) => span.attributes["kind"] === "proposal",
    );
  const [pending] = unsettledProposals(
    yield* awaitSpans(
      receiver,
      (received) => unsettledProposals(received).length > 0,
    ),
  );
  expect(pending?.attributes).toEqual({
    kind: "proposal",
    id: expect.any(String),
  });
  const pendingId = String(pending?.attributes["id"]);

  const refused = yield* gatherFrom(requester, group, "all_gather").pipe(
    Effect.flip,
    Effect.filterOrDieMessage(
      (error) => error instanceof CollectiveError,
      "the all_gather to the held group was not refused",
    ),
  );
  expect(refused.failure).toMatchObject({ kind: "members-unreachable" });
  expect(
    markers(yield* receiver.spans, "retry.settled", "id", pendingId),
  ).toEqual([]);

  yield* proxy.release;
  yield* Fiber.join(heldSend);
  const settled = yield* awaitSpans(
    receiver,
    (received) =>
      markers(received, "retry.settled", "id", pendingId).length > 0 &&
      markers(received, "collective.closed", "operationId", refused.id).length >
        0,
  );
  expect(
    attributesOf(markers(settled, "retry.settled", "id", pendingId)),
  ).toEqual([{ kind: "proposal", id: pendingId, outcome: "certified" }]);
  expect(
    attributesOf(
      markers(settled, "collective.opened", "operationId", refused.id),
    ),
  ).toEqual([
    {
      operationId: refused.id,
      op: "all_gather",
      deadlineAt: expect.any(Number),
    },
  ]);
  expect(
    attributesOf(
      markers(settled, "collective.closed", "operationId", refused.id),
    ),
  ).toEqual([{ operationId: refused.id, outcome: "refused" }]);

  yield* infrastructure.restartRouter;
  const caughtUp = yield* awaitSpans(
    receiver,
    (received) =>
      markers(received, "retry.pending", "kind", "catch-up").length > 0 &&
      unsettledRetries(received).length === 0,
  );
  expect(
    attributesOf(markers(caughtUp, "retry.settled", "kind", "catch-up")),
  ).toContainEqual({
    kind: "catch-up",
    id: expect.any(String),
    outcome: "recovered",
  });
  expect(
    attributesOf(markers(caughtUp, "retry.settled", "kind", "reanchor")),
  ).toContainEqual({
    kind: "reanchor",
    id: expect.any(String),
    outcome: "recovered",
  });
}).pipe(Effect.scoped);

it(
  "exports send and receive spans only from the daemon given an OTLP endpoint",
  processTrace(exportBehavior),
  TELEMETRY_TEST_TIMEOUT_MS,
);

it(
  "marks collective operations open until they close, checks and outbox drains until they end, proposals pending until a held member returns, and catch-up and re-anchor pending until recovery",
  processTrace(markerBehavior),
  TELEMETRY_TEST_TIMEOUT_MS,
);
