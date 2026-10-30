/** @file Storage stops preserve send responses and report closed diagnostic causes. */

import { scopedLive as it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Logger, Schema } from "effect";
import { generateKeyPairSync } from "node:crypto";
import { expect } from "vitest";
import {
  identifier,
  issueTestCard,
  makeTestAuthority,
} from "../../__tests__/agent-card-fixtures.js";
import { makeFixture } from "../../__tests__/daemon-runtime-fixtures.js";
import {
  makeHarness,
  makeToolCallRequest,
  requireOperations,
  run,
  type RuntimeHarness,
} from "../../__tests__/daemon-runtime-harness.js";
import { pollCursor } from "../../__tests__/router-worker-fixtures.js";
import { stateDirectory } from "../../__tests__/store-schema-fixtures.js";
import { makeEndpointEngine } from "../../communication/conversations/index.js";
import { RouterInstanceId } from "../../communication/router/api/contract.js";
import { EndpointStoreError } from "../../communication/store/index.js";
import { encodeCanonical } from "../../encoding/canonical-json.js";
import { AgentCard } from "../../identity/cards.js";
import { Ed25519PublicKey } from "../../identity/keys.js";
import { LIVE_WIRE_VERSIONS } from "../../identity/wire-version.js";
import { SendInput } from "../../index.js";
import { acquireHarnessMcpHttpServer } from "../mcp/index.js";
import { openDaemonStore } from "../store.js";

/* eslint-disable agent-code-guard/no-hardcoded-assertion-literals -- Exact HTTP statuses and closed diagnostic reasons are boundary contracts; secret sentinels verify redaction. */
// @agent-code-guard/regression-only: failure injection pins send replies and secret-safe storage diagnostics during daemon shutdown.

const httpListener =
  (listening: Deferred.Deferred<number>) =>
  ({
    handler,
  }: Parameters<RuntimeHarness["dependencies"]["acquireListener"]>[0]) =>
    Effect.gen(function* () {
      const server = yield* acquireHarnessMcpHttpServer({ port: 0, handler });
      const address = server.address();
      if (address === null || typeof address === "string") {
        return yield* Effect.dieMessage("missing loopback address");
      }
      yield* Deferred.succeed(listening, address.port);
    });

const proposalIdentities = Effect.gen(function* () {
  const base = yield* makeFixture;
  const registryKeys = generateKeyPairSync("ed25519");
  const signer = Schema.decodeUnknownSync(Ed25519PublicKey)(
    registryKeys.publicKey.export({ format: "jwk" }),
  );
  const localCard = yield* issueTestCard({
    byte: 1,
    name: "alice",
    authority: base.bootstrap.signingAuthority,
    registryKeys,
  });
  const remoteCard = yield* issueTestCard({
    byte: 2,
    name: "bob",
    authority: yield* makeTestAuthority(),
    registryKeys,
  });
  const fixture = {
    ...base,
    localCard,
    canonicalLocalCard: yield* encodeCanonical(AgentCard, localCard),
    bootstrap: {
      ...base.bootstrap,
      configuration: {
        ...base.bootstrap.configuration,
        registrySignerPublicKey: signer,
      },
    },
  };
  return { fixture, remoteCard };
});

const proposalAnchor = {
  routerInstanceId: Schema.decodeUnknownSync(RouterInstanceId)(
    identifier("rti_", 10),
  ),
  pollCursor: pollCursor(11),
};

const proposalFailureFixture = Effect.gen(function* () {
  const { fixture, remoteCard } = yield* proposalIdentities;
  const original = yield* makeHarness(fixture, "none");
  const store = yield* openDaemonStore(stateDirectory(), {
    liveWireVersions: LIVE_WIRE_VERSIONS,
  });
  yield* store.bindIdentity({
    agentId: fixture.localCard.agentId,
    canonicalAgentCard: fixture.canonicalLocalCard,
  });
  const harness: RuntimeHarness = {
    ...original,
    dependencies: {
      ...original.dependencies,
      makeWorker: (input) =>
        original.dependencies.makeWorker(input).pipe(
          Effect.map((worker) => ({
            ...worker,
            currentAnchor: Effect.succeed(proposalAnchor),
            awaitAnchor: Effect.succeed(proposalAnchor),
          })),
        ),
      makeEngine: (input) =>
        makeEndpointEngine({
          ...input,
          registry: {
            lookup: () =>
              Effect.succeed({ kind: "found", agentCard: remoteCard }),
          },
        }),
    },
  };
  return {
    fixture,
    harness,
    store: {
      ...store,
      enqueueOutbound: () =>
        Effect.fail(
          new EndpointStoreError({
            reason: "persistence",
            commitOutcome: "not-committed",
          }),
        ),
    },
  };
});

it(
  "returns delivery-pending over HTTP when queueing a bound proposal fails",
  () =>
    Effect.gen(function* () {
      const { fixture, harness, store } = yield* proposalFailureFixture;
      const listening = yield* Deferred.make<number>();
      const daemon = yield* Effect.forkScoped(
        run(fixture, store, {
          ...harness,
          dependencies: {
            ...harness.dependencies,
            acquireListener: httpListener(listening),
          },
        }),
      );
      const port = yield* Deferred.await(listening).pipe(
        Effect.raceFirst(Fiber.join(daemon)),
      );
      const request = makeToolCallRequest({
        id: "proposal-failure",
        name: "send_message",
        toolArguments: { input: { to: "agent:bob", text: "secret content" } },
      });
      const body = yield* Effect.tryPromise(() => request.text());
      const response = yield* Effect.tryPromise(() =>
        // eslint-disable-next-line agent-code-guard/prefer-effect-platform -- Real MCP HTTP requests exercise the Node listener drain and SDK response ordering.
        fetch(`http://127.0.0.1:${port}/mcp`, {
          method: "POST",
          headers: request.headers,
          body,
        }),
      );
      const result: unknown = yield* Effect.tryPromise(() => response.json());
      expect(response.status).toBe(200);
      expect(result).toMatchObject({
        error: { data: { reason: "delivery-pending" } },
      });
      expect(yield* Fiber.join(daemon).pipe(Effect.flip)).toMatchObject({
        phase: "storage",
      });
    }),
  30_000,
);

it("logs a proposal storage cause and preserves delivery-pending", () => {
  const messages: unknown[] = [];
  return Effect.gen(function* () {
    const { fixture, harness, store } = yield* proposalFailureFixture;
    const daemon = yield* Effect.forkScoped(run(fixture, store, harness));
    yield* Deferred.await(harness.listenerReady).pipe(
      Effect.raceFirst(Fiber.join(daemon)),
    );
    expect(
      yield* requireOperations(harness)
        .send({
          input: Schema.decodeUnknownSync(SendInput)({
            to: "agent:bob",
            text: "secret content",
          }),
        })
        .pipe(Effect.flip),
    ).toMatchObject({ reason: "delivery-pending" });
    yield* Fiber.join(daemon).pipe(Effect.flip);
    expect(JSON.stringify(messages)).toContain('"reason":"persistence"');
    expect(JSON.stringify(messages)).not.toContain("secret content");
  }).pipe(
    Effect.provide(
      Logger.replace(
        Logger.defaultLogger,
        Logger.make(({ message, annotations }) => {
          messages.push({
            message,
            annotations: Object.fromEntries(annotations),
          });
        }),
      ),
    ),
  );
});

/* eslint-enable agent-code-guard/no-hardcoded-assertion-literals -- Restore the default after the closed error contract tests. */
