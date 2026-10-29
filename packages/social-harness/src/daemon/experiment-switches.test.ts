/** @file Every daemon send route observes startup experiment configuration. */

import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { scopedLive as it } from "@effect/vitest";
import { Deferred, Effect, Schema } from "effect";
import { join } from "node:path";
import { expect } from "vitest";
import { makeFixture } from "../__tests__/daemon-runtime-fixtures.js";
import {
  awaitStage,
  makeHarness,
  makeStore,
  makeToolCallRequest,
  requireHandler,
  run,
} from "../__tests__/daemon-runtime-harness.js";
import { HistoryExportRecord, SendInput } from "../index.js";
import { hiddenFeatureRefusal } from "./runtime/index.js";

// @agent-code-guard/regression-only: These regressions pin daemon-owned experiment refusals, switched-off behavior and history exports through MCP.

const group = "group:alice,bob,carol";
const direct = "agent:bob";
const form = { type: "object", properties: {} };
const messages = [
  {
    name: "group message",
    feature: "groups",
    resultField: "postId",
    input: { to: group, text: "hello" },
  },
  {
    name: "gather",
    feature: "collectives",
    resultField: "operationId",
    input: {
      to: direct,
      text: "Which day?",
      collective: { op: "gather", deadline: 60, requestedSchema: form },
    },
  },
  {
    name: "all_gather",
    feature: "collectives",
    resultField: "operationId",
    input: {
      to: group,
      text: "Which day?",
      collective: { op: "all_gather", deadline: 60, requestedSchema: form },
    },
  },
] as const;
const answers = [
  {
    name: "accept answer",
    feature: "collectives",
    input: {
      to: direct,
      collectiveResponse: { action: "accept", content: {} },
    },
  },
  {
    name: "decline answer",
    feature: "collectives",
    input: { to: direct, collectiveResponse: { action: "decline" } },
  },
] as const;
const sends = [...messages, ...answers];

const reply = Schema.decodeUnknown(
  Schema.Struct({
    error: Schema.optional(
      Schema.Struct({
        message: Schema.String,
        data: Schema.Unknown,
      }),
    ),
    result: Schema.optional(
      Schema.Struct({
        structuredContent: Schema.Struct({
          postId: Schema.optional(Schema.String),
          operationId: Schema.optional(Schema.String),
        }),
      }),
    ),
  }),
);

function call(
  input: SendInput,
  switches: {
    readonly hideGroups?: boolean;
    readonly hideCollectives?: boolean;
    readonly historyExport?: string;
  },
) {
  return Effect.gen(function* () {
    const base = yield* makeFixture;
    const fixture = {
      ...base,
      bootstrap: {
        ...base.bootstrap,
        configuration: { ...base.bootstrap.configuration, ...switches },
      },
    };
    const harness = yield* makeHarness(fixture, "none");
    yield* Effect.forkScoped(
      run(fixture, makeStore(fixture, true, harness.delivery), harness),
    );
    yield* awaitStage(Deferred.await(harness.listenerReady), "listener");
    const request = makeToolCallRequest({
      id: "experiment-send",
      name: "send_message",
      toolArguments: { input },
    });
    const response = yield* Effect.tryPromise(() =>
      requireHandler(harness).fetch(request),
    );
    return yield* Effect.tryPromise(() => response.json()).pipe(
      Effect.flatMap(reply),
    );
  });
}

it.each(sends)("refuses hidden $name on send_message", ({ input, feature }) =>
  Effect.gen(function* () {
    const response = yield* call(
      yield* Schema.decodeUnknown(SendInput)(input),
      {
        hideGroups: feature === "groups",
        hideCollectives: feature === "collectives",
      },
    );
    expect(response.error).toMatchObject({
      message: hiddenFeatureRefusal(feature).message,
      data: { reason: "content-invalid" },
    });
  }),
);

it("refuses groups before collectives on a send", () =>
  Effect.gen(function* () {
    const input = yield* Schema.decodeUnknown(SendInput)({
      to: group,
      text: "Which day?",
      collective: { op: "all_gather", deadline: 60, requestedSchema: form },
    });
    const response = yield* call(input, {
      hideGroups: true,
      hideCollectives: true,
    });
    expect(response.error?.message).toBe(
      hiddenFeatureRefusal("groups").message,
    );
  }));

it.each(messages)(
  "preserves $name behavior with both switches off",
  ({ input, resultField }) =>
    Effect.gen(function* () {
      const response = yield* call(
        yield* Schema.decodeUnknown(SendInput)(input),
        {},
      );
      expect(response).toHaveProperty([
        "result",
        "structuredContent",
        resultField,
      ]);
    }),
);

it.each(answers)(
  "preserves $name behavior with both switches off",
  ({ input }) =>
    Effect.gen(function* () {
      const response = yield* call(
        yield* Schema.decodeUnknown(SendInput)(input),
        {},
      );
      expect(response.error).toMatchObject({
        data: {
          reason: "collective-failed",
          failure: { kind: "request-none" },
        },
      });
    }),
);

it("keeps explicit multicast available while collectives are hidden", () =>
  Effect.gen(function* () {
    const input = yield* Schema.decodeUnknown(SendInput)({
      to: direct,
      text: "hello",
      collective: { op: "multicast" },
    });
    const response = yield* call(input, {
      hideGroups: true,
      hideCollectives: true,
    });
    expect(response.result?.structuredContent.postId).toBeDefined();
  }));

it("exports a hidden send's refusal in the configured history file", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped();
    const historyExport = join(directory, "history.ndjson");
    const input = yield* Schema.decodeUnknown(SendInput)({
      to: group,
      text: "hello",
    });
    const response = yield* call(input, { hideGroups: true, historyExport });
    const contents = yield* fs.readFileString(historyExport);
    const records = yield* Effect.forEach(
      contents.trim().split("\n"),
      (line) =>
        Schema.decodeUnknown(Schema.parseJson(HistoryExportRecord))(line),
      { concurrency: 1 },
    );
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "outbound",
          input,
          outcome: { kind: "failed", error: response.error?.message },
        }),
      ]),
    );
  }).pipe(Effect.provide(NodeFileSystem.layer)));
