/** @file Member signature coverage assertions for process history. */
import { AgentCard } from "@moltzap/identity";
import { Schema } from "effect";
import { expect } from "vitest";

interface MemberSignedRecord {
  readonly recordCore: unknown;
  readonly actionSignatures: ReadonlyArray<{
    readonly signerAgentId: string;
  }>;
  readonly durabilityVotes: ReadonlyArray<{
    readonly signerAgentId: string;
  }>;
}

/** Each two-member history record lists every member in both action signatures and durability votes. */
export function expectEveryMemberSigned(
  records: readonly MemberSignedRecord[],
  memberNames: readonly string[],
) {
  const members = historyMembers(records[0]?.recordCore);
  expect(
    members
      .map(({ agentName }) => agentName)
      .sort((left, right) => left.localeCompare(right)),
  ).toEqual([...memberNames].sort((left, right) => left.localeCompare(right)));
  const memberIds = members
    .map(({ agentId }) => agentId)
    .sort((left, right) => left.localeCompare(right));
  for (const record of records) {
    expect(
      record.actionSignatures
        .map(({ signerAgentId }) => signerAgentId)
        .sort((left, right) => left.localeCompare(right)),
    ).toEqual(memberIds);
    expect(
      record.durabilityVotes
        .map(({ signerAgentId }) => signerAgentId)
        .sort((left, right) => left.localeCompare(right)),
    ).toEqual(memberIds);
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
