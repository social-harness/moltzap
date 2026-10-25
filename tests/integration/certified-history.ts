/** @file Operator-visible proof and membership assertions for process history. */
import { AgentCard } from "@moltzap/identity";
import { Schema } from "effect";
import { expect } from "vitest";

interface HistoryProof {
  readonly recordHash: string;
  readonly recordCore: unknown;
  readonly actionSignatures: ReadonlyArray<{
    readonly signerAgentId: string;
    readonly signature: string;
  }>;
  readonly durabilityVotes: ReadonlyArray<{
    readonly signerAgentId: string;
    readonly signature: string;
  }>;
}

/** Each record exposes independent action and storage evidence from fixed members. */
export function expectCertifiedHistory(
  records: readonly HistoryProof[],
  memberNames: readonly string[],
) {
  const members = historyMembers(records[0]?.recordCore);
  expect(
    members
      .map(({ agentName }) => agentName)
      .sort((left, right) => left.localeCompare(right)),
  ).toEqual([...memberNames].sort((left, right) => left.localeCompare(right)));
  const memberIds = members.map(({ agentId }) => agentId);
  expect(new Set(memberIds).size).toBe(memberNames.length);
  const threshold =
    memberNames.length < 4
      ? memberNames.length
      : memberNames.length - Math.floor((memberNames.length - 1) / 3);
  for (const record of records) {
    expect(record.recordHash).toMatch(/^rch_[A-Za-z0-9_-]+$/u);
    for (const evidence of [record.actionSignatures, record.durabilityVotes]) {
      const signers = evidence.map(({ signerAgentId }) => signerAgentId);
      expect(new Set(signers).size).toBeGreaterThanOrEqual(threshold);
      expect(new Set(signers).size).toBe(signers.length);
      for (const entry of evidence) {
        expect(memberIds).toContain(entry.signerAgentId);
        expect(entry.signature).toMatch(/^[A-Za-z0-9_-]+$/u);
      }
    }
  }
}

function historyMembers(recordCore: unknown) {
  const core = Schema.decodeUnknownSync(
    Schema.Struct({
      membership: Schema.optional(
        Schema.Struct({
          members: Schema.Array(AgentCard),
        }),
      ),
    }),
  )(recordCore ?? {});
  return core.membership?.members ?? [];
}
