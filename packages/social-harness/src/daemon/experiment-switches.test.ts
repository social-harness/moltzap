/** @file Hidden capabilities refuse sends before dispatch and retain their traffic-log outcome. */

import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { scopedLive as it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { join } from "node:path";
import { expect } from "vitest";
import { testAgentView } from "../__tests__/agent-card-fixtures.js";
import { collectiveOperationId } from "../__tests__/collective-id-fixtures.js";
import { conversationIdentityFixture } from "../__tests__/conversation-fixtures.js";
import { makeHostMessagingFixture } from "../__tests__/host-messaging-fixtures.js";
import { HistoryExportRecord, SendInput } from "../index.js";
import {
  makeHistoryExport,
  noHistoryExport,
} from "./inbox/host-traffic-log.js";

const requestId = collectiveOperationId(
  testAgentView("agent:alice").agentId,
  1,
);
const group = "group:alice,bob,carol";
const direct = "agent:bob";
const form = { type: "object", properties: {} };
const messages = [
  {
    name: "group message",
    feature: "groups",
    input: { to: group, text: "hello" },
  },
  {
    name: "gather",
    feature: "collectives",
    input: {
      to: direct,
      text: "Which day?",
      collective: { op: "gather", deadline: 60, requestedSchema: form },
    },
  },
  {
    name: "all_gather",
    feature: "collectives",
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
      collectiveResponse: {
        operationId: requestId,
        action: "accept",
        content: {},
      },
    },
  },
  {
    name: "decline answer",
    feature: "collectives",
    input: {
      to: direct,
      collectiveResponse: { operationId: requestId, action: "decline" },
    },
  },
] as const;
const sends = [...messages, ...answers];

function refusedSend(
  input: SendInput,
  experiments: {
    readonly hideGroups?: boolean;
    readonly hideCollectives?: boolean;
  },
  historyExport?: string,
) {
  return Effect.gen(function* () {
    const subject = yield* conversationIdentityFixture;
    const runtime = yield* makeHostMessagingFixture(subject, {
      experiments: {
        hideGroups: experiments.hideGroups ?? false,
        hideCollectives: experiments.hideCollectives ?? false,
      },
      historyExport:
        historyExport === undefined
          ? noHistoryExport
          : yield* makeHistoryExport(historyExport).pipe(
              Effect.provide(NodeFileSystem.layer),
            ),
    });
    return yield* runtime.messaging.send({ input }).pipe(Effect.flip);
  });
}

it.each(sends)("refuses hidden $name", ({ input, feature }) =>
  Effect.gen(function* () {
    const error = yield* refusedSend(
      yield* Schema.decodeUnknown(SendInput)(input),
      {
        hideGroups: feature === "groups",
        hideCollectives: feature === "collectives",
      },
    );
    expect(error).toMatchObject({ reason: "content-invalid" });
    expect(error.message).toContain(
      feature === "groups"
        ? "Send to an agent address"
        : "Send a plain message",
    );
  }),
);

it("reports the group restriction when both capabilities are hidden", () =>
  Effect.gen(function* () {
    const input = yield* Schema.decodeUnknown(SendInput)({
      to: group,
      text: "Which day?",
      collective: { op: "all_gather", deadline: 60, requestedSchema: form },
    });
    const error = yield* refusedSend(input, {
      hideGroups: true,
      hideCollectives: true,
    });
    // eslint-disable-next-line agent-code-guard/no-hardcoded-assertion-literals -- This integration case verifies which conflicting capability restriction is presented.
    expect(error.message).toContain("Group addresses are unavailable");
  }));

it("saves a hidden send's refusal in the traffic log", () =>
  Effect.gen(function* () {
    const filesystem = yield* FileSystem.FileSystem;
    const directory = yield* filesystem.makeTempDirectoryScoped();
    const path = join(directory, "history.ndjson");
    const input = yield* Schema.decodeUnknown(SendInput)({
      to: group,
      text: "hello",
    });
    const error = yield* refusedSend(input, { hideGroups: true }, path);
    const contents = yield* filesystem.readFileString(path);
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
          outcome: { kind: "failed", error: error.message },
        }),
      ]),
    );
  }).pipe(Effect.provide(NodeFileSystem.layer)));
