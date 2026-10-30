/** @file Isolated state directories and scoped endpoint store fixtures. */

import { Effect } from "effect";
// eslint-disable-next-line agent-code-guard/prefer-effect-platform -- Store tests create and remove real SQLite state directories around independent Effect scopes.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished } from "vitest";
import {
  type CertifiedRecord,
  type ConversationFoundation,
  type EndpointStore,
  type EndpointStoreError,
  openEndpointStore,
  type OutboxTooOldError,
} from "../communication/store/index.js";
import { LIVE_WIRE_VERSIONS } from "../identity/wire-version.js";
import { digest } from "./agent-card-fixtures.js";

/**
 * A new empty state directory, removed when the running test finishes; only a
 * test body may call it.
 */
export function stateDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "sharness-store-"));
  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

/** Run `use` against the store in `directory`, opened for that call alone and closed before the result returns. */
export function withStore<Value, Failure>(
  directory: string,
  use: (store: EndpointStore) => Effect.Effect<Value, Failure>,
): Effect.Effect<Value, Failure | EndpointStoreError | OutboxTooOldError> {
  return Effect.scoped(
    openEndpointStore(directory, { liveWireVersions: LIVE_WIRE_VERSIONS }).pipe(
      Effect.flatMap(use),
    ),
  );
}

/** The SQLite file the endpoint store keeps inside a state directory. */
export function databasePath(directory: string): string {
  return join(directory, "sharnessd.sqlite3");
}

/** A conversation foundation and one certified record in it. */
export interface StoredConversation {
  readonly foundation: ConversationFoundation;
  readonly record: CertifiedRecord;
}

/**
 * One conversation and a certified record Bob authored in it, carrying
 * placeholder bytes the store keeps without interpreting them.
 * @param label Distinguishes the conversation and its hashes.
 * @returns The foundation and the record.
 */
export function storedConversation(label: string): StoredConversation {
  const foundation = {
    conversationId: `conversation:${label}`,
    membershipHash: `mbr_${label}`,
    canonicalMembership: bytes("members"),
    anchorHash: `anc_${label}`,
    canonicalAnchor: bytes("anchor"),
  };
  const recordHash = digest("rch_", 3);
  return {
    foundation,
    record: {
      ...foundation,
      recordHash,
      actionHash: `ach_${label}`,
      authorAgentId: "agent:bob",
      msgId: digest("msg_", 1),
      canonicalRecordCore: bytes("record"),
      actionEvidence: [
        {
          conversationId: foundation.conversationId,
          kind: "action",
          subjectId: `ach_${label}`,
          evidenceKey: "agent:bob",
          canonicalEvidence: bytes("action"),
        },
      ],
      durabilityEvidence: [
        {
          conversationId: foundation.conversationId,
          kind: "durability",
          subjectId: recordHash,
          evidenceKey: "agent:bob",
          canonicalEvidence: bytes("durability"),
        },
      ],
    },
  };
}

/** UTF-8 bytes of `value`, the form the store's canonical columns hold. */
export function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}
