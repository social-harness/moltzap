/** @file Detached staged and completed re-anchor projections. */

import * as SqlClient from "@effect/sql/SqlClient";
import { Effect } from "effect";
import type { RecoveredReanchor, StagedReanchor } from "../types.js";

import {
  type EndpointStoreError,
  readBytes,
  readOptionalBytes,
  readText,
  requireEqual,
  requireSameBytes,
  storeOperation,
} from "../database/index.js";
/**
 * Projects one staged or completed recoverable re-anchor.
 *
 * @param row SQLite result row.
 * @returns The detached recoverable re-anchor.
 */
export function readRecoveredReanchor(
  row: Readonly<Record<string, unknown>>,
): RecoveredReanchor {
  const canonicalCompletedReanchor = readOptionalBytes(
    row,
    "canonical_completed_reanchor",
  );
  return Object.freeze({
    ...readStagedReanchor(row),
    ...(canonicalCompletedReanchor === undefined
      ? {}
      : { canonicalCompletedReanchor }),
  });
}
/**
 * Reads an optional staged re-anchor by stable body hash.
 *
 * @param conversationId Opaque conversation identity.
 * @param anchorHash Stable private anchor hash.
 * @returns The detached staged re-anchor when present.
 */
export function findStagedReanchor(
  conversationId: string,
  anchorHash: string,
): Effect.Effect<
  StagedReanchor | undefined,
  EndpointStoreError,
  SqlClient.SqlClient
> {
  return Effect.gen(function* () {
    const database = yield* SqlClient.SqlClient;
    const row = (yield* database.unsafe<Readonly<Record<string, unknown>>>(
      `SELECT conversation_id, anchor_hash, previous_anchor_hash,
              router_instance_id, selected_record_hash, canonical_body
       FROM reanchors WHERE conversation_id = ? AND anchor_hash = ?`,
      [conversationId, anchorHash],
    ))[0];
    return row === undefined ? undefined : readStagedReanchor(row);
  }).pipe(storeOperation, Effect.withSpan("findStagedReanchor"));
}
/**
 * Requires two re-anchors with one hash to have identical body bindings.
 *
 * @param left Previously retained re-anchor.
 * @param right Candidate re-anchor with the same private hash.
 */
export function requireSameReanchor(
  left: StagedReanchor,
  right: StagedReanchor,
): void {
  requireEqual(left.conversationId, right.conversationId);
  requireEqual(left.anchorHash, right.anchorHash);
  requireEqual(left.previousAnchorHash, right.previousAnchorHash);
  requireEqual(left.routerInstanceId, right.routerInstanceId);
  requireEqual(left.selectedRecordHash, right.selectedRecordHash);
  requireSameBytes(left.canonicalBody, right.canonicalBody);
}
/**
 * Projects one staged re-anchor body.
 *
 * @param row SQLite result row.
 * @returns The detached staged re-anchor.
 */
function readStagedReanchor(
  row: Readonly<Record<string, unknown>>,
): StagedReanchor {
  return Object.freeze({
    conversationId: readText(row, "conversation_id"),
    anchorHash: readText(row, "anchor_hash"),
    previousAnchorHash: readText(row, "previous_anchor_hash"),
    routerInstanceId: readText(row, "router_instance_id"),
    selectedRecordHash: readText(row, "selected_record_hash"),
    canonicalBody: readBytes(row, "canonical_body"),
  });
}
