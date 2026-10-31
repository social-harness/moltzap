/** @file Registration, status and saved conversation reads for the daemon MCP interface. */

import { SqlClient } from "@effect/sql";
import { type Context, Data, Effect, Option, Ref, Schema } from "effect";
import type { SendError } from "../../communication/conversations/errors.js";
import type { DaemonBootstrap } from "../bootstrap.js";
import type {
  HarnessMcpOperations,
  ManagementReadConversationResult,
  ManagementRegisterResult,
  ManagementSearchConversationsRequest,
  ManagementSearchConversationsResult,
  ManagementStatusResult,
} from "../mcp/index.js";
import {
  renderGroupAddress,
  resolveMessageAddress,
} from "../../communication/conversations/address.js";
import {
  readStoredHistory,
  verifyStoredMembership,
} from "../../communication/conversations/index.js";
import {
  deriveConversationId,
  type VerifiedMembership,
} from "../../communication/records/index.js";
import { AgentAddress } from "../../communication/records/values.js";
import {
  decodeRuntimeValue,
  type EndpointStoreError,
  type HistoryPage,
  type StoredMembership,
} from "../../communication/store/index.js";
import * as Store from "../../communication/store/index.js";
import { compareAscii } from "../../encoding/identifier.js";
import { localGuidanceSchema } from "../../host-protocol/advice.js";
import { InboundItem } from "../../host-protocol/items.js";
import {
  AgentCard,
  agentViewOf,
  type VerifiedAgentCard,
} from "../../identity/cards.js";
import { Identity, LocalIdentity } from "../../identity/local.js";
import { Registry } from "../../identity/registry/index.js";
import { readHistoryViews } from "../inbox/store.js";

type ManagementOperation =
  | "readStatus"
  | "register"
  | "searchConversations"
  | "readConversation";

type ManagementFailure =
  | "admission-refused"
  | "dependency-unavailable"
  | "history-gap"
  | "incompatible-daemon"
  | "invalid-address"
  | "invalid-continuation"
  | "not-registered"
  | "persistence-failed"
  | "unknown-agent";

type RegistryService = Context.Tag.Service<typeof Registry>;
type MessageAddress = ManagementSearchConversationsResult["addresses"][number];
type HistoryRecord = ManagementReadConversationResult["records"][number];

interface ManagementInput {
  readonly bootstrap: DaemonBootstrap;
}

interface ActiveManagementInput extends ManagementInput {
  readonly identity: Context.Tag.Service<typeof Identity>;
  readonly current: Context.Tag.Service<typeof LocalIdentity>;
}

interface SearchConversationAddressesInput {
  readonly memberships: readonly StoredMembership[];
  readonly request: ManagementSearchConversationsRequest;
  readonly bootstrap: DaemonBootstrap;
  readonly localAgentCard: VerifiedAgentCard;
}

class DaemonManagementError extends Data.TaggedError("DaemonManagementError")<{
  readonly reason: ManagementFailure;
}> {}

/** Registration and history operations presented through MCP. */
export type DaemonManagementOperations = Pick<
  HarnessMcpOperations,
  ManagementOperation
>;

/** Captures Registry and database dependencies for registration and saved history reads. */
export const makeDaemonManagementOperations = (
  input: ManagementInput,
): Effect.Effect<
  DaemonManagementOperations,
  never,
  Identity | LocalIdentity | Registry | SqlClient.SqlClient
> =>
  Effect.gen(function* () {
    const registry = yield* Registry;
    const sql = yield* SqlClient.SqlClient;
    const active: ActiveManagementInput = {
      ...input,
      identity: yield* Identity,
      current: yield* LocalIdentity,
    };
    const operations: DaemonManagementOperations = {
      readStatus: readStatusOperation(active.current),
      register: registerOperation(active),
      searchConversations: searchConversationsOperation(active, sql),
      readConversation: readConversationOperation(active, registry, sql),
    };
    return Object.freeze(operations);
  }).pipe(Effect.withSpan("makeDaemonManagementOperations"));

const historyFailureReasons = {
  "invalid-continuation": "invalid-continuation",
  "invalid-input": "history-gap",
  "not-found": "history-gap",
  closed: "persistence-failed",
  conflict: "persistence-failed",
  corrupt: "persistence-failed",
  incompatible: "persistence-failed",
  persistence: "persistence-failed",
} as const satisfies Readonly<
  Record<EndpointStoreError["reason"], ManagementFailure>
>;

function encodeStatus(
  card: Option.Option<VerifiedAgentCard>,
): Effect.Effect<ManagementStatusResult, DaemonManagementError> {
  if (Option.isNone(card)) {
    return Effect.succeed({ kind: "unregistered" });
  }
  return encodeAgentCard(card.value).pipe(
    Effect.map((agentCard) => ({
      kind: "active",
      agentCard,
      agent: agentViewOf(card.value),
    })),
  );
}

function encodeAgentCard(
  agentCard: VerifiedAgentCard,
): Effect.Effect<unknown, DaemonManagementError> {
  return Schema.encode(AgentCard)(agentCard).pipe(
    Effect.mapError(incompatibleDaemon),
  );
}

function readActiveCard(
  current: Context.Tag.Service<typeof LocalIdentity>,
): Effect.Effect<VerifiedAgentCard, DaemonManagementError> {
  return Ref.get(current).pipe(
    Effect.flatMap((card) =>
      Option.isSome(card)
        ? Effect.succeed(card.value)
        : Effect.fail(managementFailure("not-registered")),
    ),
  );
}

function validateAddressForLocalAgent(
  address: MessageAddress,
  localAgentCard: VerifiedAgentCard,
): Effect.Effect<void, DaemonManagementError> {
  const names = addressNames(address);
  const valid = address.startsWith("agent:")
    ? names[0] !== localAgentCard.agentName
    : names.includes(localAgentCard.agentName);
  return valid
    ? Effect.void
    : Effect.fail(managementFailure("invalid-address"));
}

function addressNames(address: string): readonly string[] {
  const separator = address.indexOf(":");
  return address.slice(separator + 1).split(",");
}

function renderMembershipAddress(
  membership: VerifiedMembership,
  localAgentCard: VerifiedAgentCard,
): Effect.Effect<MessageAddress, DaemonManagementError> {
  const localMember = membership.members.find(
    (member) => member.agentId === localAgentCard.agentId,
  );
  if (localMember?.agentName !== localAgentCard.agentName) {
    return Effect.fail(persistenceFailure());
  }
  if (membership.members.length === 2) {
    const remote = membership.members.find(
      (member) => member.agentId !== localAgentCard.agentId,
    );
    return remote === undefined
      ? Effect.fail(persistenceFailure())
      : Schema.decodeUnknown(AgentAddress)(`agent:${remote.agentName}`).pipe(
          Effect.mapError(persistenceFailure),
        );
  }
  return renderGroupAddress(
    membership.members.map((member) => member.agentName),
  ).pipe(
    Effect.map((group) => group.address),
    Effect.mapError(persistenceFailure),
  );
}

function decodeStoredMembership(
  stored: StoredMembership,
  input: {
    readonly bootstrap: DaemonBootstrap;
    readonly localAgentCard: VerifiedAgentCard;
  },
): Effect.Effect<MessageAddress, DaemonManagementError> {
  return verifyStoredMembership(
    stored,
    input.bootstrap.configuration.registrySignerPublicKey,
  ).pipe(
    Effect.mapError(persistenceFailure),
    Effect.flatMap((membership) =>
      renderMembershipAddress(membership, input.localAgentCard),
    ),
  );
}

function searchConversationAddresses(
  input: SearchConversationAddressesInput,
): Effect.Effect<ManagementSearchConversationsResult, DaemonManagementError> {
  return Effect.gen(function* () {
    if (input.request.afterAddress !== undefined) {
      yield* validateAddressForLocalAgent(
        input.request.afterAddress,
        input.localAgentCard,
      );
    }
    const addresses = yield* Effect.forEach(
      input.memberships,
      (membership) => decodeStoredMembership(membership, input),
      { concurrency: 1 },
    );
    addresses.sort(compareAscii);
    for (let index = 1; index < addresses.length; index += 1) {
      if (addresses[index - 1] === addresses[index]) {
        return yield* Effect.fail(persistenceFailure());
      }
    }
    const after = input.request.afterAddress;
    const remaining =
      after === undefined
        ? addresses
        : addresses.filter((address) => compareAscii(address, after) > 0);
    const page = remaining.slice(0, 50);
    return Object.freeze({
      kind: "page" as const,
      addresses: Object.freeze(page),
      hasMore: remaining.length > page.length,
    });
  });
}

function mapAddressResolutionFailure(error: SendError): DaemonManagementError {
  return error.reason === "invalid-address" ||
    error.reason === "membership-invalid"
    ? managementFailure("invalid-address")
    : managementFailure("unknown-agent");
}

function resolvedConversationId(input: {
  readonly address: MessageAddress;
  readonly localAgentCard: VerifiedAgentCard;
  readonly registry: RegistryService;
}): Effect.Effect<string, DaemonManagementError> {
  return Effect.gen(function* () {
    yield* validateAddressForLocalAgent(input.address, input.localAgentCard);
    const resolved = yield* resolveMessageAddress({
      localAgentCard: input.localAgentCard,
      registry: input.registry,
      to: input.address,
    }).pipe(Effect.mapError(mapAddressResolutionFailure));
    const [first, second, ...rest] = resolved.memberCards;
    return yield* deriveConversationId([
      first.agentId,
      second.agentId,
      ...rest.map((card) => card.agentId),
    ]).pipe(Effect.mapError(persistenceFailure));
  });
}

function mapHistoryStoreFailure(
  error: EndpointStoreError,
): DaemonManagementError {
  return managementFailure(historyFailureReasons[error.reason]);
}

function readHistoryPage(input: {
  readonly page: HistoryPage;
  readonly bootstrap: DaemonBootstrap;
  readonly agentCard: VerifiedAgentCard;
}): Effect.Effect<
  ManagementReadConversationResult,
  DaemonManagementError,
  SqlClient.SqlClient
> {
  return Effect.gen(function* () {
    const verified = yield* readStoredHistory(
      input.bootstrap.configuration.registrySignerPublicKey,
      input.page,
      input.page.records,
    ).pipe(Effect.mapError(persistenceFailure));
    const views = yield* readHistoryViews(input.page.records).pipe(
      Effect.mapError(persistenceFailure),
    );
    const records: HistoryRecord[] = [];
    for (const { recordHash, message } of verified) {
      const view = views.find(
        (candidate) => candidate.recordHash === recordHash,
      );
      if (
        view === undefined &&
        input.page.authoredRecordHashes.includes(recordHash) &&
        message.author.agentId === input.agentCard.agentId
      ) {
        records.push({
          kind: "sent",
          recordHash,
          message,
        });
      }
      if (view !== undefined) {
        records.push(yield* receivedHistoryRecord(view, recordHash));
      }
    }
    return { kind: "page", records, continuation: input.page.continuation };
  });
}

function receivedHistoryRecord(
  view: Effect.Effect.Success<ReturnType<typeof readHistoryViews>>[number],
  recordHash: HistoryRecord["recordHash"],
): Effect.Effect<HistoryRecord, DaemonManagementError> {
  return Effect.gen(function* () {
    const item = yield* decodeRuntimeValue(InboundItem, view.canonicalItem);
    const guidance =
      view.canonicalGuidance === undefined
        ? undefined
        : yield* decodeRuntimeValue(
            localGuidanceSchema,
            view.canonicalGuidance,
          );
    return {
      kind: "received" as const,
      recordHash,
      item,
      ...(guidance === undefined ? {} : { guidance }),
    };
  }).pipe(Effect.mapError(persistenceFailure));
}

function persistenceFailure(): DaemonManagementError {
  return managementFailure("persistence-failed");
}

function incompatibleDaemon(): DaemonManagementError {
  return managementFailure("incompatible-daemon");
}

function managementFailure(reason: ManagementFailure): DaemonManagementError {
  return new DaemonManagementError({ reason });
}

function readStatusOperation(
  current: Context.Tag.Service<typeof LocalIdentity>,
): DaemonManagementOperations["readStatus"] {
  return () => Ref.get(current).pipe(Effect.flatMap(encodeStatus));
}

/** Wire adapters preserve Registry refusal outcomes while Identity owns the durable binding. */
function registerOperation(
  input: ActiveManagementInput,
): DaemonManagementOperations["register"] {
  return (request) =>
    input.identity.register(request).pipe(
      Effect.flatMap(() => readActiveCard(input.current)),
      Effect.flatMap((card) =>
        encodeAgentCard(card).pipe(
          Effect.map(
            (agentCard): ManagementRegisterResult => ({
              kind: "registered",
              agentCard,
              agent: agentViewOf(card),
            }),
          ),
        ),
      ),
      Effect.catchTag("RegistrationError", (error) => {
        switch (error.reason) {
          case "name_taken":
            return Effect.succeed<ManagementRegisterResult>({
              kind: "name_taken",
            });
          case "key_already_registered":
            return Effect.succeed<ManagementRegisterResult>({
              kind: "key_already_registered",
            });
          case "idempotency_conflict":
            return Effect.succeed<ManagementRegisterResult>({
              kind: "idempotency_conflict",
            });
          case "admission-refused":
          case "dependency-unavailable":
          case "persistence-failed":
          case "incompatible-daemon":
            return Effect.fail(managementFailure(error.reason));
          default: {
            const exhaustive: never = error.reason;
            return exhaustive;
          }
        }
      }),
    );
}

function searchConversationsOperation(
  input: ActiveManagementInput,
  sql: SqlClient.SqlClient,
): DaemonManagementOperations["searchConversations"] {
  return (request) =>
    Effect.gen(function* () {
      const localAgentCard = yield* readActiveCard(input.current);
      const memberships = yield* Store.readCertifiedMemberships.pipe(
        Effect.mapError(persistenceFailure),
      );
      return yield* searchConversationAddresses({
        memberships,
        request,
        bootstrap: input.bootstrap,
        localAgentCard,
      });
    }).pipe(Effect.provideService(SqlClient.SqlClient, sql));
}

function readConversationOperation(
  input: ActiveManagementInput,
  registry: RegistryService,
  sql: SqlClient.SqlClient,
): DaemonManagementOperations["readConversation"] {
  return (request) =>
    Effect.gen(function* () {
      const localAgentCard = yield* readActiveCard(input.current);
      const storeRequest =
        "continuation" in request
          ? request
          : {
              conversationId: yield* resolvedConversationId({
                address: request.address,
                localAgentCard,
                registry,
              }),
              ...(request.afterRecordHash === undefined
                ? {}
                : { afterRecordHash: request.afterRecordHash }),
            };
      const page = yield* Store.readConversation(storeRequest).pipe(
        Effect.mapError(mapHistoryStoreFailure),
      );
      return yield* readHistoryPage({
        page,
        bootstrap: input.bootstrap,
        agentCard: localAgentCard,
      });
    }).pipe(Effect.provideService(SqlClient.SqlClient, sql));
}
