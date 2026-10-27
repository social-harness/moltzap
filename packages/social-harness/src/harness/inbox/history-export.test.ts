/** @file The history export appends decodable lines and stops explicitly. */

import { FileSystem, Error as PlatformError } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { live as it } from "@effect/vitest";
import { DateTime, Effect, Schema } from "effect";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { digest } from "../../__tests__/agent-card-fixtures.js";
import { SendInput } from "../../communication/collectives/forms.js";
import { InboundItem } from "../../communication/collectives/inbound.js";
import { PostId } from "../../communication/records/index.js";
import { HistoryExportRecord, makeHistoryExport } from "./history-export.js";

const decodeLine = Schema.decodeUnknownSync(
  Schema.parseJson(HistoryExportRecord),
);
const POST_ID = Schema.decodeUnknownSync(PostId)(digest("pst_", 5));
const AT = DateTime.unsafeMake("2026-09-01T12:00:00.000Z");
const NO_SPACE = "ENOSPC: no space left on device";

function inbound(): HistoryExportRecord {
  return {
    kind: "inbound",
    item: Schema.decodeUnknownSync(InboundItem)({
      kind: "multicast",
      message: {
        kind: "direct",
        postId: POST_ID,
        address: "agent:bob",
        sender: "agent:bob",
        content: [{ type: "text", text: "hello" }],
      },
    }),
    at: AT,
  };
}

function outbound(): HistoryExportRecord {
  const input = Schema.decodeUnknownSync(SendInput)({
    to: "agent:bob",
    text: "hi",
    collective: { op: "multicast" },
  });
  return {
    kind: "outbound",
    input,
    outcome: { kind: "sent", postIds: [POST_ID] },
    at: AT,
  };
}

function decodeFile(text: string): readonly HistoryExportRecord[] {
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => decodeLine(line));
}

/**
 * A file system whose first append fails and whose later appends are kept,
 * so the one failure line the export writes afterwards can be observed.
 * @param writes Where every append that the file system accepted lands.
 * @returns The layer, failing exactly once.
 */
function failingOnce(writes: string[]) {
  let failuresLeft = 1;
  return FileSystem.layerNoop({
    writeFileString: (...[, data]) =>
      Effect.suspend(() => {
        if (failuresLeft > 0) {
          failuresLeft -= 1;
          return Effect.fail(
            new PlatformError.SystemError({
              reason: "Unknown",
              module: "FileSystem",
              method: "writeFileString",
              description: NO_SPACE,
            }),
          );
        }
        writes.push(data);
        return Effect.void;
      }),
  });
}

const appendsDecodableLines = () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const directory = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "sharness-history-export-",
    });
    const path = join(directory, "history.ndjson");
    const sink = yield* makeHistoryExport(path);
    yield* sink.record(inbound());
    yield* sink.record(outbound());
    const text = yield* fileSystem.readFileString(path);

    expect(text.endsWith("\n")).toBe(true);
    expect(decodeFile(text)).toEqual([inbound(), outbound()]);
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer));

const stopsAfterOneFailureLine = () =>
  Effect.gen(function* () {
    const writes: string[] = [];
    yield* Effect.gen(function* () {
      const sink = yield* makeHistoryExport("/var/run/sharness/history.ndjson");
      yield* sink.record(inbound());
      yield* sink.record(outbound());
      yield* sink.record(outbound());
    }).pipe(Effect.provide(failingOnce(writes)));

    const lines = decodeFile(writes.join(""));
    const namesTheWriteFailure: unknown = expect.stringContaining(NO_SPACE);
    expect(lines).toMatchObject([
      { kind: "export-failed", reason: namesTheWriteFailure },
    ]);
  });

describe("history export", () => {
  it("appends one decodable line per record", appendsDecodableLines);
  it(
    "records one failure line, then stops exporting and keeps serving",
    stopsAfterOneFailureLine,
  );
});

it("reads historical withheld results and encodes current refusal values", () =>
  Effect.gen(function* () {
    const historical = {
      kind: "inbound",
      at: DateTime.formatIso(AT),
      item: {
        kind: "collectiveResult",
        op: "gather",
        id: digest("col_", 1),
        to: "agent:bob",
        question: {
          kind: "withheld",
          checkId: `chk_${"a".repeat(64)}`,
          reason: "approval-required",
        },
        outcomes: [{ member: "agent:bob", outcome: { kind: "declined" } }],
      },
    };
    const decoded = decodeLine(JSON.stringify(historical));
    const current = {
      ...historical,
      item: {
        ...historical.item,
        question: {
          ...historical.item.question,
          reason: "unresolved-evidence",
        },
      },
    };
    expect(decoded).toMatchObject({ item: current.item });
    const encoded = yield* Schema.encode(Schema.parseJson(HistoryExportRecord))(
      decoded,
    );
    expect(JSON.parse(encoded)).toEqual(current);
  }));
