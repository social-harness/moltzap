/** @file Exact private MCP schemas for daemon management and history reads. */

import { Schema } from "effect";
import {
  AgentAddress,
  compareAgentIds,
  GroupAddress,
  RecordCore,
  RecordHash,
  RouterAnchor,
} from "../../communication/records/index.js";
import { exactParseOptions, exactStruct } from "../../encoding/exact.js";
import {
  compareAscii,
  decodeCanonicalBase64Url,
  isStrictlyAscending,
} from "../../encoding/identifier.js";
import { AgentId, AgentName, PrincipalId } from "../../identity/agents.js";
import { AgentCard, AgentView } from "../../identity/cards.js";
import {
  OperationId,
  RegistryLookupRequest,
} from "../../identity/registry/contract.js";

const encodedAgentCard = Schema.encodedSchema(AgentCard);

/**
 * The agent's view beside an encoded card or as a record's author. This
 * daemon always sends it; it is optional so that a reader also accepts a
 * daemon of the previous release, which does not, as tool results grow.
 */
const agentView = Schema.optional(AgentView);

const messageAddress = Schema.Union(AgentAddress, GroupAddress).annotations({
  identifier: "MessageAddress",
});

function addressesAreOrdered(addresses: readonly string[]): boolean {
  return isStrictlyAscending(addresses, compareAscii);
}

function canonicalBase64UrlBytes(value: string, byteLength: number): boolean {
  return decodeCanonicalBase64Url(value)?.byteLength === byteLength;
}

function agentIdsAreOrdered(agentIds: readonly AgentId[]): boolean {
  return isStrictlyAscending(agentIds, compareAgentIds);
}

const historyContinuation = Schema.String.pipe(
  Schema.pattern(/^[A-Za-z0-9_-]{43}$/u),
  Schema.filter((value) => canonicalBase64UrlBytes(value, 32)),
);

const ed25519Signature = Schema.String.pipe(
  Schema.pattern(/^[A-Za-z0-9_-]{86}$/u),
  Schema.filter((value) => canonicalBase64UrlBytes(value, 64)),
);

const signerEvidence = exactStruct({
  signerAgentId: AgentId,
  signature: ed25519Signature,
});

const orderedSignerEvidence = Schema.NonEmptyArray(signerEvidence).pipe(
  Schema.maxItems(32),
  Schema.filter((evidence) =>
    agentIdsAreOrdered(evidence.map((item) => item.signerAgentId)),
  ),
);

/** `author` is the view of the record's author from its conversation's verified membership, outside the signed bytes. */
const historyRecord = exactStruct({
  author: agentView,
  recordHash: RecordHash,
  recordCore: RecordCore,
  routerAnchor: RouterAnchor,
  actionSignatures: orderedSignerEvidence,
  durabilityVotes: orderedSignerEvidence,
});

/** Closed local registration input; configured secrets are never tool fields. */
export const managementRegisterRequestSchema = exactStruct({
  operationId: Schema.propertySignature(OperationId).annotations({
    description:
      "Registration retry identity (opn_ plus canonical base64url for 16 bytes); reuse it for the same registration attempt.",
  }),
  principalId: Schema.propertySignature(PrincipalId).annotations({
    description:
      "Principal represented by this agent (prn_ plus canonical base64url for 16 bytes).",
  }),
  agentName: Schema.propertySignature(AgentName).annotations({
    description:
      "Immutable Registry-wide handle: 3 to 32 lowercase letters, digits, or single separating hyphens.",
  }),
});

/** Exact Registry domain outcomes returned by daemon registration. */
export const managementRegisterResultSchema = Schema.Union(
  exactStruct({
    kind: Schema.Literal("registered"),
    agentCard: encodedAgentCard,
    agent: agentView,
  }),
  exactStruct({ kind: Schema.Literal("name_taken") }),
  exactStruct({ kind: Schema.Literal("key_already_registered") }),
  exactStruct({ kind: Schema.Literal("idempotency_conflict") }),
).annotations({ parseOptions: exactParseOptions });

/** Closed daemon lifecycle visible to the loopback operator. */
export const managementStatusResultSchema = Schema.Union(
  exactStruct({ kind: Schema.Literal("unregistered") }),
  exactStruct({
    kind: Schema.Literal("active"),
    agentCard: encodedAgentCard,
    agent: agentView,
  }),
).annotations({ parseOptions: exactParseOptions });

/** Exact Registry lookup selector accepted by `search_agents`. */
export const managementSearchAgentsRequestSchema = Schema.Union(
  ...RegistryLookupRequest.members,
).annotations({ parseOptions: exactParseOptions });

/** Direct projection of exact Registry lookup results. */
export const managementSearchAgentsResultSchema = Schema.Union(
  exactStruct({
    kind: Schema.Literal("found"),
    agentCard: encodedAgentCard,
    agent: agentView,
  }),
  exactStruct({ kind: Schema.Literal("not_found") }),
).annotations({ parseOptions: exactParseOptions });

/** Canonically ordered local-conversation page selector. */
export const managementSearchConversationsRequestSchema = exactStruct({
  afterAddress: Schema.optional(messageAddress).annotations({
    description:
      "Exclusive canonical address cursor from the previous page; omit to start at the first local conversation.",
  }),
});

/** Canonically ordered local-conversation address page. */
export const managementSearchConversationsResultSchema = exactStruct({
  kind: Schema.Literal("page"),
  addresses: Schema.Array(messageAddress).pipe(Schema.maxItems(50)),
  hasMore: Schema.Boolean,
}).pipe(
  Schema.filter(
    (page) =>
      addressesAreOrdered(page.addresses) &&
      (!page.hasMore || page.addresses.length > 0),
  ),
);

/** Frozen certified-history page selector or process-local continuation. */
export const managementReadConversationRequestSchema = Schema.Union(
  exactStruct({
    address: Schema.propertySignature(messageAddress).annotations({
      description:
        "Canonical agent:<name> or group:<sorted-members> address whose certified history to read.",
    }),
    afterRecordHash: Schema.optional(RecordHash).annotations({
      description:
        "Read strictly after this certified record hash; omit to start at genesis.",
    }),
  }),
  exactStruct({
    continuation: Schema.propertySignature(historyContinuation).annotations({
      description:
        "Single-use token from the previous history page; use alone and only within this daemon process.",
    }),
  }),
).annotations({ parseOptions: exactParseOptions });

/** Complete proof-bearing local certified-history page. */
export const managementReadConversationResultSchema = exactStruct({
  kind: Schema.Literal("page"),
  records: Schema.Array(historyRecord).pipe(Schema.maxItems(50)),
  continuation: Schema.NullOr(historyContinuation),
});

/** Decoded local registration request. */
export type ManagementRegisterRequest =
  typeof managementRegisterRequestSchema.Type;
/** Encoded Registry registration result crossing MCP. */
export type ManagementRegisterResult =
  typeof managementRegisterResultSchema.Type;
/** Encoded daemon status crossing MCP. */
export type ManagementStatusResult = typeof managementStatusResultSchema.Type;
/** Decoded exact Registry selector crossing MCP. */
export type ManagementSearchAgentsRequest =
  typeof managementSearchAgentsRequestSchema.Type;
/** Encoded exact Registry result crossing MCP. */
export type ManagementSearchAgentsResult =
  typeof managementSearchAgentsResultSchema.Type;
/** Decoded local conversation search request. */
export type ManagementSearchConversationsRequest =
  typeof managementSearchConversationsRequestSchema.Type;
/** Encoded local conversation search result. */
export type ManagementSearchConversationsResult =
  typeof managementSearchConversationsResultSchema.Type;
/** Decoded local certified-history request. */
export type ManagementReadConversationRequest =
  typeof managementReadConversationRequestSchema.Type;
/** Encoded proof-bearing local certified-history result. */
export type ManagementReadConversationResult =
  typeof managementReadConversationResultSchema.Type;
