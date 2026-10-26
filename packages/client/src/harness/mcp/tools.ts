/** @file Official MCP tool catalog and private Harness operation projection. */

import {
  createMcpHandler,
  fromJsonSchema,
  type Implementation,
  type JsonSchemaType,
  type McpHttpHandler,
  McpServer,
  ProtocolError,
  ProtocolErrorCode,
  type StandardSchemaV1,
  type StandardSchemaWithJSON,
} from "@modelcontextprotocol/server";
import {
  Cause,
  Effect,
  Either,
  Exit,
  JSONSchema,
  Layer,
  Option,
  type ParseResult,
  type Runtime,
  Schema,
  Scope,
} from "effect";
import type { CollectiveError } from "../../communication/collectives/forms.js";
import type { SendError } from "../../communication/conversations/errors.js";
import {
  firewallDecisionsRequestSchema,
  firewallDecisionsSchema,
  type FirewallPolicyOperations,
  policyReadSchema,
  policyUpdateResultSchema,
  policyUpdateSchema,
} from "../../firewall/index.js";
import { FirewallSendError } from "../../firewall/outcome/index.js";
import {
  decodeHarnessSendCall,
  harnessAcknowledgeDeliveryRequestJsonSchema,
  type HarnessEmptyResult,
  harnessEmptyResultJsonSchema,
  harnessFailureReasons,
  harnessReadInboxRequestJsonSchema,
  harnessReadInboxResultJsonSchema,
  harnessSendArgumentsJsonSchema,
  harnessSendResultJsonSchema,
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
  validationIssues,
} from "../protocol/index.js";
import {
  HARNESS_ACKNOWLEDGE_DELIVERY_TOOL,
  HARNESS_READ_EVENT_TOOL,
  HARNESS_READ_INBOX_TOOL,
  HARNESS_SEND_TOOL,
} from "../protocol/names.js";
import {
  checkHarnessSendResult,
  type DeliveryOperations,
  type EventStore,
  type HarnessAcknowledgeDeliveryRequest,
  harnessAcknowledgeDeliveryRequestSchema,
  type HarnessReadInboxRequest,
  type HarnessReadInboxResult,
  type HarnessSendArguments,
  type HarnessSendErrorData,
  type HarnessSendResult,
  inboxRequestSchema,
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
  makeWebhookEvents,
  runEventOperation,
  runRequest,
  webhookHttpClientLayer,
  webhookStatusJsonSchema,
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
  readonly operation: Effect.Effect<Value, ClosedOperationError>;
  readonly label: string;
  readonly allowedReasons: ReadonlySet<string>;
  readonly fallbackReason: string;
  readonly signal: AbortSignal;
  readonly requestScope: Scope.CloseableScope;
  readonly services: Runtime.Runtime<never>;
}

const makeStandardSchema = <Value>(jsonSchema: unknown) =>
  fromJsonSchema<Value>(
    // eslint-disable-next-line agent-code-guard/require-assertion-rationale -- JSONSchema.make emits the exact JsonSchemaType consumed by the pinned MCP SDK.
    jsonSchema as JsonSchemaType,
  );

const makeJsonSchema = <A, I>(schema: Schema.Schema<A, I>) =>
  JSONSchema.make(schema, { target: "jsonSchema2020-12" });

const emptyRequestSchema = Schema.Record({
  key: Schema.String,
  value: Schema.Never,
});
const registerInput = makeStandardSchema<ManagementRegisterRequest>(
  makeJsonSchema(managementRegisterRequestSchema),
);
const registerOutput = makeStandardSchema<ManagementRegisterResult>(
  makeJsonSchema(managementRegisterResultSchema),
);
const emptyInput = makeStandardSchema<Record<string, never>>(
  makeJsonSchema(emptyRequestSchema),
);
const statusOutput = makeStandardSchema<ManagementStatusResult>(
  makeJsonSchema(managementStatusResultSchema),
);
const policyReadOutput = makeStandardSchema<typeof policyReadSchema.Type>(
  makeJsonSchema(policyReadSchema),
);
const policyUpdateInput = makeStandardSchema<typeof policyUpdateSchema.Type>(
  makeJsonSchema(policyUpdateSchema),
);
const policyUpdateOutput = makeStandardSchema<
  typeof policyUpdateResultSchema.Type
>(makeJsonSchema(policyUpdateResultSchema));
const decisionsInput = makeStandardSchema<
  typeof firewallDecisionsRequestSchema.Type
>(makeJsonSchema(firewallDecisionsRequestSchema));
const decisionsOutput = makeStandardSchema<typeof firewallDecisionsSchema.Type>(
  makeJsonSchema(firewallDecisionsSchema),
);
const searchAgentsInput = makeStandardSchema<ManagementSearchAgentsRequest>(
  makeJsonSchema(managementSearchAgentsRequestSchema),
);
const searchAgentsOutput = makeStandardSchema<ManagementSearchAgentsResult>(
  makeJsonSchema(managementSearchAgentsResultSchema),
);
const searchConversationsInput =
  makeStandardSchema<ManagementSearchConversationsRequest>(
    makeJsonSchema(managementSearchConversationsRequestSchema),
  );
const searchConversationsOutput =
  makeStandardSchema<ManagementSearchConversationsResult>(
    makeJsonSchema(managementSearchConversationsResultSchema),
  );
const readConversationInput =
  makeStandardSchema<ManagementReadConversationRequest>(
    makeJsonSchema(managementReadConversationRequestSchema),
  );
const readConversationOutput =
  makeStandardSchema<ManagementReadConversationResult>(
    makeJsonSchema(managementReadConversationResultSchema),
  );
const sendInput = makeStandardSchema<HarnessSendArguments>(
  harnessSendArgumentsJsonSchema,
);
const acknowledgeDeliveryInput =
  makeStandardSchema<HarnessAcknowledgeDeliveryRequest>(
    harnessAcknowledgeDeliveryRequestJsonSchema,
  );
const emptyOutput = makeStandardSchema<HarnessEmptyResult>(
  harnessEmptyResultJsonSchema,
);
const sendOutput = makeStandardSchema<HarnessSendResult>(
  harnessSendResultJsonSchema,
);
const readEventInput = makeStandardSchema<typeof readEventRequestSchema.Type>(
  makeJsonSchema(readEventRequestSchema),
);
const readEventOutput = makeStandardSchema<typeof readEventResultSchema.Type>(
  makeJsonSchema(readEventResultSchema),
);
const readInboxInput = makeStandardSchema<HarnessReadInboxRequest>(
  harnessReadInboxRequestJsonSchema,
);
const readInboxOutput = makeStandardSchema<HarnessReadInboxResult>(
  harnessReadInboxResultJsonSchema,
);
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
      `${options.label} failed`,
      {
        reason,
      },
    );
  }
  return toolResult(outcome.value);
};

/**
 * Run one send and answer its typed failure as JSON-RPC error data. A send
 * that ends without one, interrupted or by a defect, may already have queued
 * its post, so it answers `outcome-unknown`.
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
    const data = Option.match(Cause.failureOption(outcome.cause), {
      onNone: (): HarnessSendErrorData => ({ reason: "outcome-unknown" }),
      onSome: sendErrorData,
    });
    throw new ProtocolError(
      ProtocolErrorCode.InternalError,
      "refusal" in data
        ? new FirewallSendError(data).message
        : "Operation send failed",
      data,
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

/** A tool's catalog entry: its description and schemas. */
interface ToolListing {
  readonly description: string;
  readonly inputSchema: StandardSchemaWithJSON;
  readonly outputSchema?: StandardSchemaWithJSON;
}

/**
 * Every tool the catalog can list. `installToolCallHandler` replaces the
 * SDK's tools/call dispatch, so `toolHandlers` serves every call and a listing
 * only names a tool and its schemas.
 */
const toolListings = {
  policy_read: {
    description:
      "Read the active editable English rules and the fixed rules, which cannot be edited.",
    inputSchema: emptyInput,
    outputSchema: policyReadOutput,
  },
  policy_update: {
    description:
      "Update editable English rules. Returns after activation. Changes are not retroactive: admitted guidance, held items and bound sends remain unchanged.",
    inputSchema: policyUpdateInput,
    outputSchema: policyUpdateOutput,
  },
  firewall_decisions: {
    description:
      "Read metadata for the latest 100 completed checks since inclusive Unix milliseconds: each outcome's cause and deciding rules with their registered advice; no message text. Groups have one row per peer.",
    inputSchema: decisionsInput,
    outputSchema: decisionsOutput,
  },
  [STATUS_TOOL]: {
    description:
      "Inspect whether this daemon is registered and read its bound AgentCard.",
    inputSchema: emptyInput,
    outputSchema: statusOutput,
  },
  [REGISTER_TOOL]: {
    description:
      "Register this daemon's configured key under an immutable agent name for a principal, reusing operationId for retries.",
    inputSchema: registerInput,
    outputSchema: registerOutput,
  },
  event_subscription_status: {
    description:
      "Inspect the runtime consumer and stalled delivery without exposing callback credentials.",
    inputSchema: emptyInput,
    outputSchema: makeStandardSchema(webhookStatusJsonSchema),
  },
  revoke_event_subscription: {
    description:
      "Release the active runtime consumer while leaving pending inbox items unread.",
    inputSchema: emptyInput,
  },
  resume_event_subscription: {
    description:
      "Resume transient callback retries after a recoverable delivery failure. A terminal rejection requires revocation and reconfiguration.",
    inputSchema: emptyInput,
  },
  [SEARCH_AGENTS_TOOL]: {
    description:
      "Look up an agent by its exact AgentId or agentName; a display name or partial name returns not_found.",
    inputSchema: searchAgentsInput,
    outputSchema: searchAgentsOutput,
  },
  [SEARCH_CONVERSATIONS_TOOL]: {
    description:
      "List canonical addresses of local conversations in order, optionally after an exclusive address cursor.",
    inputSchema: searchConversationsInput,
    outputSchema: searchConversationsOutput,
  },
  [READ_CONVERSATION_TOOL]: {
    description:
      "Read a frozen page of verified local conversation history by address or single-use continuation.",
    inputSchema: readConversationInput,
    outputSchema: readConversationOutput,
  },
  [HARNESS_READ_INBOX_TOOL]: {
    description:
      "Read a page of pending classified inbox items without acknowledging delivery.",
    inputSchema: readInboxInput,
    outputSchema: readInboxOutput,
  },
  [HARNESS_SEND_TOOL]: {
    description:
      "Send one multicast, gather, all_gather, or collective response to an agent or fixed-member group.",
    inputSchema: sendInput,
    outputSchema: sendOutput,
  },
  [HARNESS_READ_EVENT_TOOL]: {
    description:
      "Read the original full content of a Social Harness event by eventId without delivery or acknowledgment side effects.",
    inputSchema: readEventInput,
    outputSchema: readEventOutput,
  },
  [HARNESS_ACKNOWLEDGE_DELIVERY_TOOL]: {
    description:
      "Acknowledge a delivery token after the host has accepted its item under the host-specific handoff contract.",
    inputSchema: acknowledgeDeliveryInput,
    outputSchema: emptyOutput,
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

const handleOwnerOperation = async (
  operation: Effect.Effect<Readonly<Record<string, unknown>>, ProtocolError>,
  input: ToolCallInput,
) => {
  await decodeToolInput(
    emptyInput,
    emptyRequestSchema,
    input.toolArguments,
    input.name,
  );
  return toolResult(
    await runEventOperation(
      operation,
      input.signal,
      input.requestScope,
      input.services,
    ),
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
      operation: options.execute(operations, request),
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
    handleOwnerOperation(operations.events.status, input),
  revoke_event_subscription: (input, operations) =>
    handleOwnerOperation(operations.events.revoke.pipe(Effect.as({})), input),
  resume_event_subscription: (input, operations) =>
    handleOwnerOperation(operations.events.resume.pipe(Effect.as({})), input),
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
 * The tools `role` lists and may call now: its catalog for whether the
 * daemon's protocol is up. Listing and admission read this one answer.
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

const handleToolCall = async (
  input: ToolCallInput,
  operations: ToolOperations,
  role: HarnessMcpRole,
) => {
  const name = currentTools(role, operations).find(
    (tool) => tool === input.name,
  );
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
    { legacy: "reject", responseMode: "auto", onerror: options.onerror },
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
      events.close.pipe(
        Effect.ensuring(
          Effect.tryPromise(() => delegate.close()).pipe(Effect.ignore),
        ),
        Effect.ensuring(Scope.close(scope, Exit.void)),
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
    const events = yield* makeHarnessEvents({
      ...(webhook === undefined ? {} : { webhook }),
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
