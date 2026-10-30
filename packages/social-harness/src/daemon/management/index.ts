/** @file Registration, status and saved conversation reads for the daemon MCP interface. */

import { SqlClient } from "@effect/sql";
import * as Store from "../../communication/store/index.js";
import { type Context, Data, Effect, Schema } from "effect";
import type { SendError } from "../../communication/conversations/errors.js";
import type {
  EndpointRecovery,
  EndpointStoreError,
  HistoryPage,
} from "../../communication/store/index.js";
import type {
  DaemonBootstrap,
  DaemonConfigurationError,
} from "../bootstrap.js";
import type { DaemonActivationError } from "../errors.js";
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
import { compareAscii } from "../../encoding/identifier.js";
import {
  AgentCard,
  agentViewOf,
  type VerifiedAgentCard,
} from "../../identity/cards.js";
import { decodeRuntimeValue } from "../../communication/store/runtime-codec.js";
import { InboundItem } from "../../host-protocol/items.js";
import { localGuidanceSchema } from "../../host-protocol/advice.js";
import { readHistoryViews } from "../inbox/store.js";
import {
  type RegistryRegisterResult,
} from "../../identity/registry/contract.js";
import { Registry } from "../../identity/registry/index.js";
import {
  type DaemonRegistrationPersistenceError,
  type DaemonRegistrationRefusedError,
  type DaemonRegistrationRepresentationError,
  type DaemonRegistrationState,
  type DaemonRegistrationUpstreamError,
  registerDaemonIdentity,
} from "../registration/index.js";

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

/** The daemon's registration state and the activation a registration starts. */
interface RegistrationPort {
  readonly readRegistration: () => DaemonRegistrationState;
  readonly activateRegistered: (
    agentCard: VerifiedAgentCard,
  ) => Effect.Effect<void, DaemonActivationError>;
}

interface ManagementInput {
  readonly bootstrap: DaemonBootstrap;
  readonly registration: RegistrationPort;
}

interface SearchConversationAddressesInput {
  readonly recovery: EndpointRecovery;
  readonly request: ManagementSearchConversationsRequest;
  readonly bootstrap: DaemonBootstrap;
  readonly localAgentCard: VerifiedAgentCard;
}

class DaemonManagementError extends Data.TaggedError("DaemonManagementError")<{
  readonly reason: ManagementFailure;
}> {}

/** Closed management-only projection consumed by the MCP presentation. */
export type DaemonManagementOperations = Pick<
  HarnessMcpOperations,
  ManagementOperation
>;

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

/**
 * The register tool's closed reason for an activation failure: a local
 * storage fault is persistence-failed; an upstream or representation fault
 * is dependency-unavailable.
 */
const activationFailureReasons = {
  persistence: "persistence-failed",
  upstream: "dependency-unavailable",
  representation: "dependency-unavailable",
  "outbox-too-old": "persistence-failed",
} as const satisfies Readonly<
  Record<DaemonActivationError["reason"], ManagementFailure>
>;

function encodeRegisterResult(
  result: RegistryRegisterResult,
): Effect.Effect<ManagementRegisterResult, DaemonManagementError> {
  if (result.kind !== "registered") {
    return Effect.succeed(result);
  }
  return encodeAgentCard(result.agentCard).pipe(
    Effect.map((agentCard) =>
      Object.freeze({
        kind: "registered",
        agentCard,
        agent: agentViewOf(result.agentCard),
      }),
    ),
  );
}

function encodeStatus(
  state: DaemonRegistrationState,
): Effect.Effect<ManagementStatusResult, DaemonManagementError> {
  if (state.kind === "unregistered") {
    return Effect.succeed(state);
  }
  return encodeAgentCard(state.agentCard).pipe(
    Effect.map((agentCard) =>
      Object.freeze({
        kind: "active",
        agentCard,
        agent: agentViewOf(state.agentCard),
      }),
    ),
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
  registration: RegistrationPort,
): Effect.Effect<VerifiedAgentCard, DaemonManagementError> {
  return Effect.suspend(() => {
    const state = registration.readRegistration();
    return state.kind === "active"
      ? Effect.succeed(state.agentCard)
      : Effect.fail(managementFailure("not-registered"));
  });
}

function mapRegistrationFailure(
  error:
    | DaemonRegistrationPersistenceError
    | DaemonRegistrationRepresentationError
    | DaemonRegistrationRefusedError
    | DaemonRegistrationUpstreamError
    | DaemonConfigurationError,
): DaemonManagementError {
  switch (error._tag) {
    case "DaemonConfigurationError":
      return incompatibleDaemon();
    case "DaemonRegistrationPersistenceError":
      return persistenceFailure();
    case "DaemonRegistrationRepresentationError":
      return incompatibleDaemon();
    case "DaemonRegistrationRefusedError":
      return managementFailure(error.reason);
    case "DaemonRegistrationUpstreamError":
      return managementFailure("dependency-unavailable");
    default: {
      const exhaustive: never = error;
      return exhaustive;
    }
  }
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
  stored: EndpointRecovery["memberships"][number],
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
    const memberships = new Map(
      input.recovery.memberships.map((membership) => [
        membership.conversationId,
        membership,
      ]),
    );
    const certifiedConversationIds = input.recovery.positions
      .filter((position) => position.headRecordHash !== undefined)
      .map((position) => position.conversationId);
    const addresses = yield* Effect.forEach(
      certifiedConversationIds,
      (conversationId) => {
        const membership = memberships.get(conversationId);
        return membership === undefined
          ? Effect.fail(persistenceFailure())
          : decodeStoredMembership(membership, input);
      },
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
  readonly recovery: EndpointRecovery;
  readonly bootstrap: DaemonBootstrap;
  readonly agentCard: VerifiedAgentCard;
}): Effect.Effect<ManagementReadConversationResult, DaemonManagementError, SqlClient.SqlClient> {
  return Effect.gen(function* () {
    const verified = yield* readStoredHistory(
      input.bootstrap.configuration.registrySignerPublicKey,
      input.recovery,
      input.page.records,
    ).pipe(Effect.mapError(persistenceFailure));
    const views = yield* readHistoryViews(input.page.records).pipe(
      Effect.mapError(persistenceFailure),
    );
    const records: HistoryRecord[] = [];
    for (const { record, author } of verified) {
      const certified = record.actionCertifiedRecord;
      const recordHash = certified.recordHash;
      const intent = input.recovery.messageIntents.find(
        (candidate) => candidate.completedRecordHash === recordHash &&
          candidate.authorAgentId === input.agentCard.agentId,
      );
      if (intent !== undefined && author.agentId === input.agentCard.agentId) {
        records.push({
          kind: "sent",
          author: agentViewOf(author),
          recordHash,
          content: certified.recordCore.action.messageIntent.content,
        });
      }
      const view = views.find((candidate) => candidate.recordHash === recordHash);
      if (view !== undefined) {
        const item = yield* decodeRuntimeValue(InboundItem, view.canonicalItem).pipe(
          Effect.mapError(persistenceFailure),
        );
        const guidance = view.canonicalGuidance === undefined ? undefined :
          yield* decodeRuntimeValue(localGuidanceSchema, view.canonicalGuidance).pipe(
            Effect.mapError(persistenceFailure),
          );
        records.push({kind: "received", recordHash, item,
          ...(guidance === undefined ? {} : {guidance}),
        });
      }
    }
    return {kind: "page", records, continuation: input.page.continuation};
  });
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

const readStatusOperation =
  (registration: RegistrationPort): DaemonManagementOperations["readStatus"] =>
  () =>
    Effect.suspend(() => encodeStatus(registration.readRegistration()));

/**
 * Registration and the activation it starts run as one uninterruptible step,
 * so a cancelled MCP request still lets the Registry call, the binding commit,
 * the daemon's switch to active and the protocol activation finish. The
 * Registry call still ends at its own deadline, because
 * `registerDaemonIdentity` runs it in a detached interruptible fiber.
 * @param input Exclusive store, fixed bootstrap, and registration activation port.
 * @param registry Captured immutable Registry capability used for registration.
 * @returns The cancellation-safe registration operation.
 */
const registerOperation =
  (
    input: ManagementInput,
    registry: RegistryService,
    sql: SqlClient.SqlClient,
  ): DaemonManagementOperations["register"] =>
  (request) =>
    Effect.uninterruptible(
      registerDaemonIdentity({
        request,
          bootstrap: input.bootstrap,
      }).pipe(
        Effect.provideService(Registry, registry),
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.mapError(mapRegistrationFailure),
        Effect.tap((result) =>
          result.kind === "registered"
            ? input.registration.activateRegistered(result.agentCard)
            : Effect.void,
        ),
        Effect.catchTag("DaemonActivationError", (error) =>
          Effect.fail({ reason: activationFailureReasons[error.reason] }),
        ),
        Effect.flatMap(encodeRegisterResult),
      ),
    );

const searchConversationsOperation =
  (input: ManagementInput, sql: SqlClient.SqlClient): DaemonManagementOperations["searchConversations"] =>
  (request) =>
    Effect.gen(function* () {
      const localAgentCard = yield* readActiveCard(input.registration);
      const recovery = yield* Store.recover()
        .pipe(Effect.mapError(persistenceFailure));
      return yield* searchConversationAddresses({
        recovery,
        request,
        bootstrap: input.bootstrap,
        localAgentCard,
      });
    }).pipe(Effect.provideService(SqlClient.SqlClient, sql));

const readConversationOperation =
  (
    input: ManagementInput,
    registry: RegistryService,
    sql: SqlClient.SqlClient,
  ): DaemonManagementOperations["readConversation"] =>
  (request) =>
    Effect.gen(function* () {
      const localAgentCard = yield* readActiveCard(input.registration);
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
      const page = yield* Store.readConversation(storeRequest)
        .pipe(Effect.mapError(mapHistoryStoreFailure));
      const recovery = yield* Store.recover()
        .pipe(Effect.mapError(persistenceFailure));
      return yield* readHistoryPage({
        page,
        recovery,
        bootstrap: input.bootstrap,
        agentCard: localAgentCard,
      });
    }).pipe(Effect.provideService(SqlClient.SqlClient, sql));

/**
 * Builds management operations with one captured Registry service. Status
 * and the registered check read the daemon's registration state, never the
 * store.
 *
 * @param input The daemon's exclusively owned store, its fixed identity and
 *   service configuration, and its registration port.
 * @returns Closed operations ready for the loopback MCP presentation.
 */
export const makeDaemonManagementOperations = (
  input: ManagementInput,
): Effect.Effect<DaemonManagementOperations, never, Registry | SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const registry = yield* Registry;
    const sql = yield* SqlClient.SqlClient;
    const operations: DaemonManagementOperations = {
      readStatus: readStatusOperation(input.registration),
      register: registerOperation(input, registry, sql),
      searchConversations: searchConversationsOperation(input, sql),
      readConversation: readConversationOperation(input, registry, sql),
    };
    return Object.freeze(operations);
  }).pipe(Effect.withSpan("makeDaemonManagementOperations"));
