/** @file Official MCP tool catalog and private Harness operation projection. */

import {
  createMcpHandler,
  type Implementation,
  type McpHttpHandler,
  McpServer,
  ProtocolError,
  ProtocolErrorCode,
  type StandardSchemaV1,
  type StandardSchemaWithJSON,
  type ToolAnnotations,
} from "@modelcontextprotocol/server";
import {
  Cause,
  Effect,
  Either,
  Exit,
  Layer,
  Option,
  type ParseResult,
  type Runtime,
  Schema,
  Scope,
} from "effect";
import type { CollectiveError } from "../../communication/collectives/forms.js";
import type { SendError } from "../../communication/conversations/errors.js";
import type { FirewallSendError } from "../../firewall/outcome/index.js";
import {
  firewallDecisionsRequestSchema,
  firewallDecisionsSchema,
  type FirewallPolicyOperations,
  policyReadSchema,
  policyUpdateResultSchema,
  policyUpdateSchema,
} from "../../firewall/index.js";
import {
  decodeHarnessSendCall,
  type HarnessEmptyResult,
  harnessEmptyResultSchema,
  harnessFailureReasons,
  type ManagementReadConversationRequest,
  managementReadConversationRequestSchema,
  type ManagementReadConversationResult,
  managementReadConversationResultSchema,
  type ManagementRegisterRequest,
  managementRegisterRequestSchema,
  type ManagementRegisterResult,
  managementRegisterResultSchema,
  type ManagementSearchAgentsRequest,
  managementSearchAgentsRequestSchema,
  type ManagementSearchAgentsResult,
  managementSearchAgentsResultSchema,
  type ManagementSearchConversationsRequest,
  managementSearchConversationsRequestSchema,
  type ManagementSearchConversationsResult,
  managementSearchConversationsResultSchema,
  type ManagementStatusResult,
  managementStatusResultSchema,
  registrationAdmissionRefusalMessage,
  requestSchema,
  type ResultSchema,
  resultSchema,
  validationIssues,
  webhookStatusResult,
} from "../protocol/index.js";
import {
  HARNESS_ACKNOWLEDGE_DELIVERY_TOOL,
  HARNESS_CONSUMER_META_KEY,
  HARNESS_READ_EVENT_TOOL,
  HARNESS_READ_INBOX_TOOL,
  HARNESS_SEND_TOOL,
} from "../protocol/names.js";
import {
  checkHarnessSendResult,
  type DeliveryOperations,
  type EventStore,
  harnessAcknowledgeDeliveryRequestSchema,
  harnessSendArgumentsSchema,
  type HarnessSendErrorData,
  type HarnessSendResult,
  harnessSendResultSchema,
  inboxRequestSchema,
  inboxResultSchema,
  readEventRequestSchema,
  readEventResultSchema,
  sendErrorData,
} from "../protocol/operations.js";
import {
  authenticateHarnessRequest,
  type HarnessMcpCredentials,
  type HarnessMcpRole,
} from "./auth.js";
import {
  type HarnessEvents,
  makeHarnessEvents,
  makeHarnessPollEvents,
  makeWebhookEvents,
  runEventOperation,
  runRequest,
  webhookHttpClientLayer,
} from "./events.js";

/* eslint-disable agent-code-guard/async-keyword -- Official MCP factories and callbacks are Promise-native. */

const REGISTER_TOOL = "register";
const STATUS_TOOL = "status";
const SEARCH_AGENTS_TOOL = "search_agents";
const SEARCH_CONVERSATIONS_TOOL = "search_conversations";
const READ_CONVERSATION_TOOL = "read_conversation";

type ClosedOperationError = Readonly<{ readonly reason: string }>;

/** Structural daemon operations projected onto the loopback MCP boundary. */
export interface HarnessMcpOperations extends DeliveryOperations {
  readonly policy?: FirewallPolicyOperations;
  /**
   * Whether the daemon's protocol is up. The catalog lists the
   * post-registration tools, and admits their calls and the inbox
   * subscription, only while it is.
   */
  readonly protocolActive: () => boolean;
  readonly readStatus: () => Effect.Effect<
    ManagementStatusResult,
    ClosedOperationError
  >;
  readonly register: (
    input: ManagementRegisterRequest,
  ) => Effect.Effect<ManagementRegisterResult, ClosedOperationError>;
  readonly searchAgents: (
    input: ManagementSearchAgentsRequest,
  ) => Effect.Effect<ManagementSearchAgentsResult, ClosedOperationError>;
  readonly searchConversations: (
    input: ManagementSearchConversationsRequest,
  ) => Effect.Effect<ManagementSearchConversationsResult, ClosedOperationError>;
  readonly readConversation: (
    input: ManagementReadConversationRequest,
  ) => Effect.Effect<ManagementReadConversationResult, ClosedOperationError>;
}

/** Official handler with one content-free daemon notification edge. */
export interface HarnessMcpEventHandler extends McpHttpHandler {
  readonly hasActiveSubscription: () => boolean;
  readonly notifyPending: () => boolean;
}

interface HarnessMcpHandlerOptions {
  readonly eventStore?: EventStore;
  readonly credentials?: HarnessMcpCredentials;
  readonly implementation: Implementation;
  readonly operations: HarnessMcpOperations;
  readonly onSubscriptionActiveChange?: (active: boolean) => void;
  readonly onerror?: (error: Error) => void;
  /** Idle keep-alive period of the message subscription; tests set it. */
  readonly keepAliveMillis?: number;
}

interface RunOperationOptions<Value extends Readonly<Record<string, unknown>>> {
  readonly operation: Effect.Effect<
    Value,
    ClosedOperationError | ProtocolError
  >;
  readonly label: string;
  readonly allowedReasons: ReadonlySet<string>;
  readonly fallbackReason: string;
  readonly signal: AbortSignal;
  readonly requestScope: Scope.CloseableScope;
  readonly services: Runtime.Runtime<never>;
}

const emptyRequestSchema = Schema.Record({
  key: Schema.String,
  value: Schema.Never,
});
const registerInput = requestSchema(managementRegisterRequestSchema);
const registerOutput = resultSchema(managementRegisterResultSchema);
const emptyInput = requestSchema(emptyRequestSchema);
const statusOutput = resultSchema(managementStatusResultSchema);
const policyReadOutput = resultSchema(policyReadSchema);
const policyUpdateInput = requestSchema(policyUpdateSchema);
const policyUpdateOutput = resultSchema(policyUpdateResultSchema);
const decisionsInput = requestSchema(firewallDecisionsRequestSchema);
const decisionsOutput = resultSchema(firewallDecisionsSchema);
const searchAgentsInput = requestSchema(managementSearchAgentsRequestSchema);
const searchAgentsOutput = resultSchema(managementSearchAgentsResultSchema);
const searchConversationsInput = requestSchema(
  managementSearchConversationsRequestSchema,
);
const searchConversationsOutput = resultSchema(
  managementSearchConversationsResultSchema,
);
const readConversationInput = requestSchema(
  managementReadConversationRequestSchema,
);
const readConversationOutput = resultSchema(
  managementReadConversationResultSchema,
);
const sendInput = requestSchema(harnessSendArgumentsSchema);
const acknowledgeDeliveryInput = requestSchema(
  harnessAcknowledgeDeliveryRequestSchema,
);
const emptyOutput = resultSchema(harnessEmptyResultSchema);
const sendOutput = resultSchema(harnessSendResultSchema);
const readEventInput = requestSchema(readEventRequestSchema);
const readEventOutput = resultSchema(readEventResultSchema);
const readInboxInput = requestSchema(inboxRequestSchema);
const readInboxOutput = resultSchema(inboxResultSchema);
const {
  RUNTIME_READ_REASONS,
  REGISTER_REASONS,
  STATUS_REASONS,
  SEARCH_AGENTS_REASONS,
  SEARCH_CONVERSATIONS_REASONS,
  READ_CONVERSATION_REASONS,
  ACKNOWLEDGE_DELIVERY_REASONS,
} = harnessFailureReasons;

const operationReason = (
  cause: unknown,
  allowed: ReadonlySet<string>,
  fallback: string,
): string => {
  if (typeof cause !== "object" || cause === null || !("reason" in cause)) {
    return fallback;
  }
  const reason: unknown = cause.reason;
  return typeof reason === "string" && allowed.has(reason) ? reason : fallback;
};

const toolResult = <Value extends Readonly<Record<string, unknown>>>(
  structuredContent: Value,
) => ({
  content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
  structuredContent,
});

/**
 * JSON Schema decides structural admission; Effect supplies field diagnostics
 * only for rejected inputs, leaving semantic refusals with their operations.
 */
const decodeToolInput = async <Value, A, I>(
  schema: StandardSchemaV1<unknown, Value>,
  diagnosticsSchema: Schema.Schema<A, I>,
  value: unknown,
  toolName: string,
) => {
  const decoded = await schema["~standard"].validate(value);
  if (!("value" in decoded)) {
    const diagnostics = Schema.decodeUnknownEither(diagnosticsSchema, {
      errors: "all",
    })(value);
    const issues = Either.match(diagnostics, {
      onLeft: validationIssues,
      onRight: () => [{ path: [], message: "Expected tool argument schema" }],
    });
    throw new ProtocolError(
      ProtocolErrorCode.InvalidParams,
      `Invalid arguments for tool ${toolName}`,
      {
        issues,
      },
    );
  }
  return decoded.value;
};

const runOperation = async <Value extends Readonly<Record<string, unknown>>>(
  options: RunOperationOptions<Value>,
) => {
  const outcome = await runRequest(
    options.operation,
    options.signal,
    options.requestScope,
    options.services,
  );
  if (Exit.isFailure(outcome)) {
    const expectedFailure = Option.match(Cause.dieOption(outcome.cause), {
      onNone: () => Cause.failureOption(outcome.cause),
      onSome: () => Option.none(),
    });
    if (
      Option.isSome(expectedFailure) &&
      ProtocolError.isInstance(expectedFailure.value)
    ) {
      throw expectedFailure.value;
    }
    const reason = Option.match(expectedFailure, {
      onNone: () => options.fallbackReason,
      onSome: (failure) =>
        operationReason(
          failure,
          options.allowedReasons,
          options.fallbackReason,
        ),
    });
    throw new ProtocolError(
      ProtocolErrorCode.InternalError,
      reason === "admission-refused"
        ? registrationAdmissionRefusalMessage
        : `${options.label} failed`,
      {
        reason,
      },
    );
  }
  return toolResult(outcome.value);
};

/**
 * Run one send and answer its typed failure as JSON-RPC error data, with the
 * typed error's own message, which names its cause for a host to hand its
 * model. A send that ends without one, interrupted or by a defect, may
 * already have queued its post, so it answers `outcome-unknown`.
 * @param operation A multicast, collective send or collective response.
 * @param signal The request's abort signal, which interrupts the send.
 * @param requestScope The handler lifetime that joins request finalizers before closing.
 * @param services The trusted daemon services captured when the handler is acquired.
 * @returns The send's tool result.
 */
const runSendOperation = async (
  operation: Effect.Effect<
    HarnessSendResult,
    SendError | CollectiveError | FirewallSendError
  >,
  signal: AbortSignal,
  requestScope: Scope.CloseableScope,
  services: Runtime.Runtime<never>,
) => {
  const outcome = await runRequest(operation, signal, requestScope, services);
  if (Exit.isFailure(outcome)) {
    const failure = Cause.failureOption(outcome.cause);
    throw new ProtocolError(
      ProtocolErrorCode.InternalError,
      Option.match(failure, {
        onNone: () => "Operation send failed",
        onSome: (error) => error.message,
      }),
      Option.match(failure, {
        onNone: (): HarnessSendErrorData => ({ reason: "outcome-unknown" }),
        onSome: sendErrorData,
      }),
    );
  }
  return toolResult(outcome.value);
};

const validateToolOutput = async <
  Value,
  Result extends Readonly<{ structuredContent: Value }>,
>(
  schema: StandardSchemaV1<unknown, Value>,
  result: Result,
  toolName: string,
) => {
  const decoded = await schema["~standard"].validate(result.structuredContent);
  if (!("value" in decoded)) {
    throw new ProtocolError(
      ProtocolErrorCode.InvalidParams,
      `Invalid result from tool ${toolName}`,
    );
  }
  return result;
};

const runValidatedOperation = async <
  Value extends Readonly<Record<string, unknown>>,
>(
  schema: StandardSchemaV1<unknown, Value>,
  toolName: string,
  options: RunOperationOptions<Value>,
) => await validateToolOutput(schema, await runOperation(options), toolName);

/**
 * The MCP annotations a host reads to decide which calls need its user's
 * approval. MCP defaults an unset `destructiveHint` to true and
 * `openWorldHint` to true, so a write that changes nothing it cannot undo, and
 * a tool that stays on this host, say so.
 */
type ToolHints = ToolAnnotations &
  Required<Pick<ToolAnnotations, "readOnlyHint" | "openWorldHint">>;

/** A tool's catalog entry: its description, schemas and annotations. */
interface ToolListing {
  readonly description: string;
  readonly inputSchema: StandardSchemaWithJSON;
  readonly outputSchema?: ResultSchema;
  readonly annotations: ToolHints;
}

/** A tool that reads this daemon's own state. */
const localRead: ToolHints = { readOnlyHint: true, openWorldHint: false };

/**
 * Every tool the catalog can list. `installToolCallHandler` replaces the
 * SDK's tools/call dispatch, so `toolHandlers` serves every call and a listing
 * only names a tool, its schemas and its annotations.
 */
const toolListings = {
  policy_read: {
    description:
      "Read the active editable English rules and the fixed rules, which cannot be edited. Read it before policy_update to see which rule ids exist.",
    inputSchema: emptyInput,
    outputSchema: policyReadOutput,
    annotations: localRead,
  },
  policy_update: {
    description:
      'Add or remove editable English rules, such as a shared norm the agent agreed to: add takes whole rules or {"behavior": "<BEHAVIOR.md text>"}, which adds a shared norm\'s BEHAVIOR.md exactly as proposed; remove takes rule ids, and removing and adding one id replaces it. Fails with invalid-rule for an added id that already exists, a BEHAVIOR.md that does not start with its --- frontmatter line, lacks name, description or guidance, is not kind norm, or is over 64 KiB, a removed id that does not exist, or more than 256 rules; fixed-rule for a fixed rule\'s id; and not-configured when the message policy has no english block. Returns the new activeRevision once the rules are active; changes are not retroactive: admitted guidance, held items and bound sends remain unchanged.',
    inputSchema: policyUpdateInput,
    outputSchema: policyUpdateOutput,
    annotations: { readOnlyHint: false, openWorldHint: false },
  },
  firewall_decisions: {
    description:
      "Read metadata for the latest 100 completed checks since inclusive Unix milliseconds: each outcome's cause and deciding rules with their registered advice; no message text. Groups have one row per peer.",
    inputSchema: decisionsInput,
    outputSchema: decisionsOutput,
    annotations: localRead,
  },
  [STATUS_TOOL]: {
    description:
      "Inspect whether this daemon is registered: unregistered, or active with its bound AgentCard and agent, the card's agentId, agentName and principalId.",
    inputSchema: emptyInput,
    outputSchema: statusOutput,
    annotations: localRead,
  },
  [REGISTER_TOOL]: {
    description:
      "Register this daemon's configured key under an immutable agent name for a principal, reusing operationId for retries. Returns registered with the AgentCard and agent (agentId, agentName, principalId), or name_taken, key_already_registered or idempotency_conflict. Fails with admission-refused when the Registry refuses this daemon's admission credential: supply this network's credential and register again.",
    inputSchema: registerInput,
    outputSchema: registerOutput,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  event_subscription_status: {
    description:
      "Inspect the runtime consumer and stalled delivery without exposing callback credentials.",
    inputSchema: emptyInput,
    outputSchema: webhookStatusResult,
    annotations: localRead,
  },
  revoke_event_subscription: {
    description:
      "Release the active runtime consumer while leaving pending inbox items unread.",
    inputSchema: emptyInput,
    outputSchema: emptyOutput,
    annotations: { readOnlyHint: false, openWorldHint: false },
  },
  resume_event_subscription: {
    description:
      "Resume transient callback retries after a recoverable delivery failure. A terminal rejection requires revocation and reconfiguration.",
    inputSchema: emptyInput,
    outputSchema: emptyOutput,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    },
  },
  [SEARCH_AGENTS_TOOL]: {
    description:
      "Look up an agent by its exact AgentId or agentName. Returns found with its encoded agentCard and agent (agentId, agentName, principalId) from the verified card; use agent.agentId for identity-based firewall rules. A display name or partial name returns not_found.",
    inputSchema: searchAgentsInput,
    outputSchema: searchAgentsOutput,
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  [SEARCH_CONVERSATIONS_TOOL]: {
    description:
      "List canonical addresses of local conversations in order, optionally after an exclusive address cursor.",
    inputSchema: searchConversationsInput,
    outputSchema: searchConversationsOutput,
    annotations: localRead,
  },
  [READ_CONVERSATION_TOOL]: {
    description:
      "Read a frozen page of verified local conversation history by address or single-use continuation; each record names its author as author (agentId, agentName, principalId), and its message text is at recordCore.action.postIntent.content, beside the signatures that verify it. For new messages not yet handled, use read_inbox.",
    inputSchema: readConversationInput,
    outputSchema: readConversationOutput,
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  [HARNESS_READ_INBOX_TOOL]: {
    description:
      "Read a page of pending classified inbox items without acknowledging delivery.",
    inputSchema: readInboxInput,
    outputSchema: readInboxOutput,
    annotations: localRead,
  },
  [HARNESS_SEND_TOOL]: {
    description:
      "Send one multicast, gather, all_gather, or collective response to an agent or fixed-member group. Returns a gather's or all_gather's operationId; a multicast or response returns the postId of the post it created, the id read_conversation records and, for a multicast, the recipients' multicast items carry, and its conversation's canonical address; a response also returns the operationId of the request it answered. A collectiveResponse answers in the conversation its question arrived in; always give it the question's id, from its collectiveRequest item: without it the reply goes to whichever question is the one open there, and fails with request-ambiguous and the open ids when several are. When the daemon has a message firewall, it checks the message first; a refusal fails the call with the check id, the reason and the next action, and sends nothing. A delivery-pending failure means the message will still be sent: do not send it again.",
    inputSchema: sendInput,
    outputSchema: sendOutput,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    },
  },
  [HARNESS_READ_EVENT_TOOL]: {
    description:
      "Read the original full content of a Social Harness event by eventId without delivery or acknowledgment side effects. An inbox item's eventId is its deliveryToken with evt_ in place of dlv_.",
    inputSchema: readEventInput,
    outputSchema: readEventOutput,
    annotations: localRead,
  },
  [HARNESS_ACKNOWLEDGE_DELIVERY_TOOL]: {
    description:
      "Acknowledge a delivery token after the host has accepted its item under the host-specific handoff contract.",
    inputSchema: acknowledgeDeliveryInput,
    outputSchema: emptyOutput,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
} as const satisfies Readonly<Record<string, ToolListing>>;

type ToolName = keyof typeof toolListings;

interface RoleCatalog {
  readonly inactive: readonly ToolName[];
  readonly active: readonly ToolName[];
}

const ownerEventTools = [
  "event_subscription_status",
  "revoke_event_subscription",
  "resume_event_subscription",
] as const;

/** The local and owner tools that follow registration, after `status`. */
const activeTools = [
  "policy_read",
  "policy_update",
  "firewall_decisions",
  SEARCH_AGENTS_TOOL,
  SEARCH_CONVERSATIONS_TOOL,
  READ_CONVERSATION_TOOL,
  HARNESS_READ_INBOX_TOOL,
  HARNESS_SEND_TOOL,
  HARNESS_READ_EVENT_TOOL,
  HARNESS_ACKNOWLEDGE_DELIVERY_TOOL,
] as const;

/**
 * The tools each role lists before the daemon's protocol is up and once it
 * is. The runtime role lists nothing until then.
 */
const roleCatalogs = {
  local: {
    inactive: [STATUS_TOOL, REGISTER_TOOL],
    active: [STATUS_TOOL, ...activeTools],
  },
  owner: {
    inactive: [STATUS_TOOL, ...ownerEventTools, REGISTER_TOOL],
    active: [STATUS_TOOL, ...ownerEventTools, ...activeTools],
  },
  runtime: {
    inactive: [],
    active: [SEARCH_AGENTS_TOOL, HARNESS_SEND_TOOL, HARNESS_READ_EVENT_TOOL],
  },
} as const satisfies Readonly<Record<HarnessMcpRole, RoleCatalog>>;

interface ToolCallInput {
  readonly role: HarnessMcpRole;
  readonly name: string;
  readonly toolArguments: unknown;
  readonly metadata: unknown;
  readonly signal: AbortSignal;
  readonly requestScope: Scope.CloseableScope;
  readonly services: Runtime.Runtime<never>;
}

const toolNotFound = (name: string): never => {
  throw new ProtocolError(
    ProtocolErrorCode.InvalidParams,
    `Tool ${name} not found`,
  );
};

const requestRuntime = (input: ToolCallInput) => ({
  signal: input.signal,
  requestScope: input.requestScope,
  services: input.services,
});

const decodeInvocationInput = <A>(
  input: Effect.Effect<A, ParseResult.ParseError>,
  signal: AbortSignal,
  requestScope: Scope.CloseableScope,
  services: Runtime.Runtime<never>,
) =>
  runEventOperation(
    input.pipe(
      Effect.catchTag("ParseError", (error) =>
        Effect.fail(
          new ProtocolError(-32602, "Invalid invocation arguments", {
            reason: "content-invalid",
            issues: validationIssues(error),
          }),
        ),
      ),
    ),
    signal,
    requestScope,
    services,
  );

/**
 * Run one send call. A send that returns a result outside its output schema
 * has already run, so that result is a defect, which `runSendOperation`
 * answers as `outcome-unknown`.
 * @param input The `send_message` arguments, metadata and abort signal.
 * @param operations The daemon operations that run the send.
 * @returns The send's validated tool result.
 */
const handleSendToolCall = async (
  input: ToolCallInput,
  operations: HarnessMcpOperations,
) => {
  const decoded = await decodeInvocationInput(
    decodeHarnessSendCall(input.toolArguments, input.metadata),
    input.signal,
    input.requestScope,
    input.services,
  );
  const send = operations
    .send(decoded)
    .pipe(
      Effect.flatMap((result) =>
        checkHarnessSendResult(result).pipe(Effect.orDie),
      ),
    );
  return await validateToolOutput(
    sendOutput,
    await runSendOperation(
      send,
      input.signal,
      input.requestScope,
      input.services,
    ),
    input.name,
  );
};

const POLICY_REASONS = new Set([
  "not-configured",
  "invalid-rule",
  "fixed-rule",
  "build-failed",
  "persistence-failed",
]);

/** The operations a tool call runs: the daemon's and the event subscription's. */
interface ToolOperations extends HarnessMcpOperations {
  readonly events: HarnessEvents;
  readonly requestScope: Scope.CloseableScope;
  readonly services: Runtime.Runtime<never>;
}

const handleOwnerOperation = async <
  Value extends Readonly<Record<string, unknown>>,
>(
  operation: Effect.Effect<Value, ProtocolError>,
  outputSchema: StandardSchemaV1<unknown, Value>,
  input: ToolCallInput,
) => {
  await decodeToolInput(
    emptyInput,
    emptyRequestSchema,
    input.toolArguments,
    input.name,
  );
  return await validateToolOutput(
    outputSchema,
    toolResult(
      await runEventOperation(
        operation,
        input.signal,
        input.requestScope,
        input.services,
      ),
    ),
    input.name,
  );
};

/** Serves one admitted call of the tool it is keyed by in `toolHandlers`. */
type ToolHandler = (
  input: ToolCallInput,
  operations: ToolOperations,
  // eslint-disable-next-line agent-code-guard/promise-type -- MCP tool handlers are Promise callbacks of the official SDK.
) => Promise<ReturnType<typeof toolResult>>;

/** Couples each decoded request to its operation and validated result. */
const makeToolHandler =
  <
    Request,
    Diagnostics,
    Encoded,
    Value extends Readonly<Record<string, unknown>>,
  >(
    inputSchema: StandardSchemaV1<unknown, Request>,
    diagnosticsSchema: Schema.Schema<Diagnostics, Encoded>,
    outputSchema: StandardSchemaV1<unknown, Value>,
    options: Pick<
      RunOperationOptions<Value>,
      "label" | "allowedReasons" | "fallbackReason"
    > & {
      readonly consumesInbox?: boolean;
      readonly execute: (
        operations: HarnessMcpOperations,
        request: Request,
      ) => Effect.Effect<Value, ClosedOperationError>;
    },
  ): ToolHandler =>
  async (input, operations) => {
    const request = await decodeToolInput(
      inputSchema,
      diagnosticsSchema,
      input.toolArguments,
      input.name,
    );
    return await runValidatedOperation(outputSchema, input.name, {
      ...options,
      operation: options.consumesInbox
        ? operations.events.nativeOperation(
            input.metadata,
            options.execute(operations, request),
            input.role === "runtime",
          )
        : options.execute(operations, request),
      ...requestRuntime(input),
    });
  };

/**
 * The handler for each tool the catalog can list, keyed like `toolListings`,
 * so a listed tool without a handler does not compile.
 */
const toolHandlers = {
  policy_read: makeToolHandler(
    emptyInput,
    emptyRequestSchema,
    policyReadOutput,
    {
      execute: (operations) =>
        operations.policy?.read() ?? Effect.fail({ reason: "not-configured" }),
      label: "Policy read",
      allowedReasons: POLICY_REASONS,
      fallbackReason: "persistence-failed",
    },
  ),
  policy_update: makeToolHandler(
    policyUpdateInput,
    policyUpdateSchema,
    policyUpdateOutput,
    {
      execute: (operations, request) =>
        operations.policy?.update(request) ??
        Effect.fail({ reason: "not-configured" }),
      label: "Policy update",
      allowedReasons: POLICY_REASONS,
      fallbackReason: "build-failed",
    },
  ),
  firewall_decisions: makeToolHandler(
    decisionsInput,
    firewallDecisionsRequestSchema,
    decisionsOutput,
    {
      execute: (operations, request) =>
        operations.policy?.decisions(request) ??
        Effect.fail({ reason: "not-configured" }),
      label: "Firewall decisions",
      allowedReasons: POLICY_REASONS,
      fallbackReason: "persistence-failed",
    },
  ),
  [STATUS_TOOL]: makeToolHandler(emptyInput, emptyRequestSchema, statusOutput, {
    execute: (operations, request) => {
      if (Object.keys(request).length !== 0) {
        throw new ProtocolError(
          ProtocolErrorCode.InvalidParams,
          "Status accepts no arguments",
        );
      }
      return operations.readStatus();
    },
    label: "Status",
    allowedReasons: STATUS_REASONS,
    fallbackReason: "incompatible-daemon",
  }),
  [REGISTER_TOOL]: makeToolHandler(
    registerInput,
    managementRegisterRequestSchema,
    registerOutput,
    {
      execute: (operations, request) => operations.register(request),
      label: "Registration",
      allowedReasons: REGISTER_REASONS,
      fallbackReason: "dependency-unavailable",
    },
  ),
  event_subscription_status: (input, operations) =>
    handleOwnerOperation(operations.events.status, webhookStatusResult, input),
  revoke_event_subscription: (input, operations) =>
    handleOwnerOperation(
      operations.events.revoke.pipe(Effect.as({})),
      emptyOutput,
      input,
    ),
  resume_event_subscription: (input, operations) =>
    handleOwnerOperation(
      operations.events.resume.pipe(Effect.as({})),
      emptyOutput,
      input,
    ),
  [SEARCH_AGENTS_TOOL]: makeToolHandler(
    searchAgentsInput,
    managementSearchAgentsRequestSchema,
    searchAgentsOutput,
    {
      execute: (operations, request) => operations.searchAgents(request),
      label: "Agent search",
      allowedReasons: SEARCH_AGENTS_REASONS,
      fallbackReason: "dependency-unavailable",
    },
  ),
  [SEARCH_CONVERSATIONS_TOOL]: makeToolHandler(
    searchConversationsInput,
    managementSearchConversationsRequestSchema,
    searchConversationsOutput,
    {
      execute: (operations, request) => operations.searchConversations(request),
      label: "Conversation search",
      allowedReasons: SEARCH_CONVERSATIONS_REASONS,
      fallbackReason: "persistence-failed",
    },
  ),
  [READ_CONVERSATION_TOOL]: makeToolHandler(
    readConversationInput,
    managementReadConversationRequestSchema,
    readConversationOutput,
    {
      execute: (operations, request) => operations.readConversation(request),
      label: "Conversation read",
      allowedReasons: READ_CONVERSATION_REASONS,
      fallbackReason: "persistence-failed",
    },
  ),
  [HARNESS_READ_INBOX_TOOL]: makeToolHandler(
    readInboxInput,
    inboxRequestSchema,
    readInboxOutput,
    {
      consumesInbox: true,
      execute: (operations, request) => operations.readInbox(request),
      label: "Inbox read",
      allowedReasons: RUNTIME_READ_REASONS,
      fallbackReason: "persistence-failed",
    },
  ),
  [HARNESS_SEND_TOOL]: handleSendToolCall,
  [HARNESS_READ_EVENT_TOOL]: makeToolHandler(
    readEventInput,
    readEventRequestSchema,
    readEventOutput,
    {
      execute: (operations, request) => operations.readEvent(request),
      label: "Event read",
      allowedReasons: RUNTIME_READ_REASONS,
      fallbackReason: "persistence-failed",
    },
  ),
  [HARNESS_ACKNOWLEDGE_DELIVERY_TOOL]: makeToolHandler(
    acknowledgeDeliveryInput,
    harnessAcknowledgeDeliveryRequestSchema,
    emptyOutput,
    {
      consumesInbox: true,
      execute: (operations, request) =>
        operations
          .acknowledgeDelivery(request.deliveryToken)
          .pipe(Effect.as<HarnessEmptyResult>({})),
      label: "Delivery acknowledgment",
      allowedReasons: ACKNOWLEDGE_DELIVERY_REASONS,
      fallbackReason: "transport-failed",
    },
  ),
} satisfies Readonly<Record<ToolName, ToolHandler>>;

/**
 * The advertised tools and ordinary call admission for the current protocol
 * state. Generation-bound native inbox calls have a separate admission path.
 * @param role The request's authority.
 * @param operations The daemon operations that report the protocol state.
 * @returns The tool names, in catalog order.
 */
const currentTools = (
  role: HarnessMcpRole,
  operations: HarnessMcpOperations,
): readonly ToolName[] => {
  const catalog = roleCatalogs[role];
  const tools = operations.protocolActive() ? catalog.active : catalog.inactive;
  return operations.policy === undefined
    ? tools.filter(
        (name) =>
          name !== "policy_read" &&
          name !== "policy_update" &&
          name !== "firewall_decisions",
      )
    : tools;
};

/** Transport metadata admits native receive calls without advertising them as model tools. */
const hasConsumerBinding = (metadata: unknown) =>
  typeof metadata === "object" &&
  metadata !== null &&
  HARNESS_CONSUMER_META_KEY in metadata;
const nativeInboxTool = (name: string) =>
  name === HARNESS_READ_INBOX_TOOL || name === HARNESS_ACKNOWLEDGE_DELIVERY_TOOL
    ? name
    : undefined;

const handleToolCall = async (
  input: ToolCallInput,
  operations: ToolOperations,
  role: HarnessMcpRole,
) => {
  const nativeName =
    operations.protocolActive() && hasConsumerBinding(input.metadata)
      ? nativeInboxTool(input.name)
      : undefined;
  const name =
    nativeName ??
    currentTools(role, operations).find((tool) => tool === input.name);
  if (name === undefined) {
    return toolNotFound(input.name);
  }
  return await toolHandlers[name](input, operations);
};

/** Schema failures and refused operations stay on the JSON-RPC error channel. */
const installToolCallHandler = (
  server: McpServer,
  operations: ToolOperations,
  role: HarnessMcpRole,
): void => {
  server.server.setRequestHandler("tools/call", (request, context) => {
    const input = {
      role,
      name: request.params.name,
      toolArguments: request.params.arguments ?? {},
      metadata: context.mcpReq._meta,
      signal: context.mcpReq.signal,
      requestScope: operations.requestScope,
      services: operations.services,
    };
    return handleToolCall(input, operations, role);
  });
};
const runtimeOperations = (
  operations: HarnessMcpOperations,
  events: HarnessEvents,
  requestScope: Scope.CloseableScope,
  services: Runtime.Runtime<never>,
): ToolOperations => ({
  ...operations,
  events,
  requestScope,
  services,
  acknowledgeDelivery: (token) =>
    operations
      .acknowledgeDelivery(token)
      .pipe(Effect.tap(() => Effect.sync(() => events.notifyPending()))),
});
/**
 * One request's server. Its catalog is the role's, read from the daemon's
 * protocol state when the request arrives.
 */
const makeServer = (
  options: HarnessMcpHandlerOptions,
  operations: ToolOperations,
  role: HarnessMcpRole,
): McpServer => {
  const capabilities = { tools: {}, events: {} };
  const server = new McpServer(options.implementation, { capabilities });
  for (const name of currentTools(role, options.operations)) {
    const listing: ToolListing = toolListings[name];
    server.registerTool(name, listing, () => toolResult({}));
  }
  installToolCallHandler(server, operations, role);
  operations.events.install(server.server, role === "local" ? undefined : role);
  return server;
};
const officialHandler = (
  options: HarnessMcpHandlerOptions,
  events: HarnessEvents,
  requestScope: Scope.CloseableScope,
  services: Runtime.Runtime<never>,
) =>
  createMcpHandler(
    (context) => {
      const request = context.requestInfo;
      if (request === undefined) {
        throw new ProtocolError(-32012, "Authentication required");
      }
      const role = authenticateHarnessRequest(request, options.credentials);
      if (role === undefined) {
        throw new ProtocolError(-32012, "Authentication required");
      }
      return makeServer(
        options,
        runtimeOperations(options.operations, events, requestScope, services),
        role,
      );
    },
    { responseMode: "auto", onerror: options.onerror },
  );
const guardedHandler = (
  options: HarnessMcpHandlerOptions,
  delegate: McpHttpHandler,
  events: HarnessEvents,
  scope: Scope.CloseableScope,
): HarnessMcpEventHandler => ({
  ...delegate,
  hasActiveSubscription: events.hasActiveSubscription,
  notifyPending: events.notifyPending,
  fetch: (request, requestOptions) => {
    const role = authenticateHarnessRequest(request, options.credentials);
    if (role === undefined) {
      return Promise.resolve(
        new Response("Unauthorized", {
          status: 401,
          headers: { "www-authenticate": "Bearer" },
        }),
      );
    }
    return delegate.fetch(request, requestOptions);
  },
  close: () =>
    Effect.runPromise(
      Effect.all([events.close, Scope.close(scope, Exit.void)], {
        concurrency: 2,
        discard: true,
      }).pipe(
        Effect.ensuring(
          Effect.tryPromise(() => delegate.close()).pipe(Effect.ignore),
        ),
      ),
    ),
});
const acquireWebhook = (
  options: HarnessMcpHandlerOptions,
  scope: Scope.CloseableScope,
  gate: Effect.Semaphore,
) =>
  Effect.gen(function* () {
    if (options.credentials === undefined || options.eventStore === undefined) {
      return undefined;
    }
    const context = yield* Layer.buildWithScope(webhookHttpClientLayer, scope);
    return yield* makeWebhookEvents(options.eventStore, gate).pipe(
      Effect.provide(context),
      Scope.extend(scope),
      Effect.mapError(() => ({ reason: "persistence-failed" })),
    );
  });
const acquireHandler = (
  options: HarnessMcpHandlerOptions,
  scope: Scope.CloseableScope,
) =>
  Effect.gen(function* () {
    const services = yield* Effect.runtime();
    const gate = yield* Effect.makeSemaphore(1);
    const webhook = yield* acquireWebhook(options, scope, gate);
    const poll =
      options.credentials === undefined || options.eventStore === undefined
        ? undefined
        : yield* makeHarnessPollEvents(options.eventStore, gate);
    const events = yield* makeHarnessEvents({
      ...(webhook === undefined ? {} : { webhook }),
      ...(poll === undefined ? {} : { poll }),
      summary: options.operations.readInboxSummary,
      protocolActive: options.operations.protocolActive,
      gate,
      keepAliveMillis: options.keepAliveMillis,
      onActiveChange: options.onSubscriptionActiveChange,
    });
    return guardedHandler(
      options,
      officialHandler(options, events, scope, services),
      events,
      scope,
    );
  });

/**
 * Create one official MCP handler with explicit event resource ownership.
 * @param options Daemon operations, optional credentials and callback persistence.
 * @returns Handler whose catalog follows the daemon's protocol state.
 */
export const makeHarnessMcpHttpHandler = (
  options: HarnessMcpHandlerOptions,
): Effect.Effect<HarnessMcpEventHandler, ClosedOperationError> =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    return yield* acquireHandler(options, scope).pipe(
      Effect.onError(() => Scope.close(scope, Exit.void)),
    );
  }).pipe(Effect.withSpan("makeHarnessMcpHttpHandler"));

/* eslint-enable agent-code-guard/async-keyword -- Restore repository defaults after the MCP boundary. */
