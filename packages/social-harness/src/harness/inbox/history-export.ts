/** @file The record of endpoint traffic: what the daemon delivered to its host and what the host sent. */

import { FileSystem } from "@effect/platform";
import { DateTime, Effect, Schema } from "effect";
import {
  CollectiveId,
  SendInput,
} from "../../communication/collectives/forms.js";
import { historyExportItem } from "../../communication/collectives/inbound.js";
import { PostId } from "../../communication/records/values.js";
import { exactStruct } from "../../encoding/exact.js";

/* eslint-disable @typescript-eslint/naming-convention, @typescript-eslint/no-redeclare -- Effect Schemas share their domain names with the nominal values they decode. */

/**
 * How one send ended in the history export: the posts certified by the time
 * it returned, with the operation id of a gather or all_gather, or the
 * error it returned.
 */
const historyExportSendOutcome = Schema.Union(
  exactStruct({
    kind: Schema.Literal("sent"),
    operationId: Schema.optionalWith(CollectiveId, { exact: true }),
    postIds: Schema.Array(PostId),
  }),
  exactStruct({ kind: Schema.Literal("failed"), error: Schema.String }),
);

/**
 * One line of the daemon's optional history export: an item as the daemon
 * published it, a completed `send` invocation with its input and outcome, or
 * the one line that says the export stopped. Readers decode the file line by
 * line with this schema rather than copying its shape.
 */
export const HistoryExportRecord = Schema.Union(
  exactStruct({
    kind: Schema.Literal("inbound"),
    item: historyExportItem,
    at: Schema.DateTimeUtc,
  }),
  exactStruct({
    kind: Schema.Literal("outbound"),
    input: SendInput,
    outcome: historyExportSendOutcome,
    at: Schema.DateTimeUtc,
  }),
  exactStruct({
    kind: Schema.Literal("export-failed"),
    reason: Schema.String,
    at: Schema.DateTimeUtc,
  }),
).annotations({ identifier: "HistoryExportRecord" });
/** A validated line of the daemon's history export. */
export type HistoryExportRecord = typeof HistoryExportRecord.Type;

/* eslint-enable @typescript-eslint/naming-convention, @typescript-eslint/no-redeclare -- Restore the package naming rules after the Schema/type pairs. */

const encodeLine = Schema.encode(Schema.parseJson(HistoryExportRecord));

/**
 * Sink for the daemon's optional history export. Recording never fails and
 * never blocks the daemon on its own outcome: an export that stops is the
 * sink's business, recorded in the file.
 */
export interface HistoryExportPort {
  readonly record: (record: HistoryExportRecord) => Effect.Effect<void>;
}

/** The export in place when the operator configured none: records vanish. */
export const noHistoryExport: HistoryExportPort = Object.freeze({
  record: () => Effect.void,
});

/**
 * Open the daemon's history export against one file.
 *
 * Recording completes only once the line is on disk: an inbound record lands
 * before its message becomes visible to the agent and an outbound record
 * before the send returns, so a transcript harvested the moment a program
 * ends holds every delivery and send that program could have observed. That
 * costs one append inside the delivery path, accepted for an opt-in evidence
 * file whose worth is its completeness. Lines are appended one at a time
 * under a gate, so two records never interleave. The first append that fails
 * ends the export: one `export-failed` line is written on a best-effort
 * basis, every later record is dropped, and the daemon goes on serving the
 * agent. An experiment must not die because its transcript file did, and the
 * truncation is explicit in the file rather than silent.
 *
 * The file is created on the first write.
 */
export function makeHistoryExport(
  path: string,
): Effect.Effect<HistoryExportPort, never, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const gate = yield* Effect.makeSemaphore(1);
    let enabled = true;
    const append = (record: HistoryExportRecord) =>
      encodeLine(record).pipe(
        Effect.flatMap((line) =>
          fileSystem.writeFileString(path, `${line}\n`, { flag: "a" }),
        ),
      );
    const disable = (cause: { readonly message: string }) =>
      Effect.gen(function* () {
        enabled = false;
        yield* Effect.logWarning(`history export stopped: ${cause.message}`);
        const at = yield* DateTime.now;
        yield* append({
          kind: "export-failed",
          reason: cause.message,
          at,
        }).pipe(Effect.ignore);
      });
    return {
      record: (record: HistoryExportRecord) =>
        gate.withPermits(1)(
          Effect.suspend(() =>
            enabled
              ? append(record).pipe(Effect.catchAll(disable))
              : Effect.void,
          ),
        ),
    };
  }).pipe(Effect.withSpan("makeHistoryExport"));
}
