/** @file The values harness operations take, return and persist: sends, inbox pages, events and acknowledgments. */

import { Effect, JSONSchema, type ParseResult, Schema } from "effect";
import type { SendError } from "../communication/conversations/errors.js";
import {
  type CollectiveError,
  CollectiveId,
  decodeCollectiveFailure,
  SendInput,
  SendResult,
} from "../communication/collectives/contracts.js";
import { InboundItem } from "../communication/collectives/inbound.js";
import { AgentAddress, GroupAddress } from "../communication/records/index.js";
import {
  DeliveryToken,
  type EndpointStore,
  type InboxSummary,
} from "../communication/store/types.js";
import { exactParseOptions, exactStruct } from "../encoding/exact.js";
import {
  firewallRefusalSchema,
  type FirewallSendError,
  localGuidanceSchema,
} from "../firewall/outcome/index.js";
import { HARNESS_CONSUMER_META_KEY, INBOX_ITEM_EVENT } from "./names.js";

/** Canonical event identities reuse the immutable inbox binding's random bytes. */
export const eventIdSchema = Schema.String.pipe(
  Schema.pattern(/^evt_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u),
);

const consumerMetadataSchema = exactStruct({
  generation: Schema.UUID,
  release: Schema.optionalWith(Schema.Boolean, { exact: true }),
});
const metadataSchema = Schema.Struct({
  [HARNESS_CONSUMER_META_KEY]: Schema.optional(consumerMetadataSchema),
});
const itemEventDataSchema = Schema.Union(
  exactStruct({
    kind: Schema.Literal("item"),
    item: InboundItem,
    guidance: Schema.optionalWith(localGuidanceSchema, { exact: true }),
  }),
  exactStruct({
    kind: Schema.Literal("reference"),
    itemKind: Schema.Literal(
      "multicast",
      "collectiveRequest",
      "collectiveResult",
      "operationFailed",
    ),
    bytes: Schema.NonNegativeInt,
  }),
);
const itemEventSchema = Schema.Struct({
  eventId: eventIdSchema,
  name: Schema.Literal(INBOX_ITEM_EVENT),
  timestamp: Schema.String,
  data: itemEventDataSchema,
  cursor: Schema.optional(Schema.Null),
});
const pollResultSchema = Schema.Struct({
  events: Schema.Array(itemEventSchema),
  cursor: Schema.String,
  truncated: Schema.Boolean,
  hasMore: Schema.Boolean,
  nextPollMs: Schema.NonNegativeInt,
  _meta: Schema.Struct(
    { [HARNESS_CONSUMER_META_KEY]: consumerMetadataSchema },
    Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  ),
});

/** Receipt binding distinguishes consumer lifetimes; bearer authentication is still required. */
export type ConsumerMetadata = typeof consumerMetadataSchema.Type;
/** Native polling carries a required consumer binding beside open SDK metadata. */
export type PollResult = typeof pollResultSchema.Type;
/** Classified payload has the same inline/reference union in each delivery mode. */
export const itemEventDataJsonSchema = JSONSchema.make(itemEventDataSchema, {
  target: "jsonSchema2020-12",
});
/** Validates only Social Harness metadata, leaving SDK bookkeeping open. */
export const decodeConsumerMetadata = (metadata: unknown) =>
  Schema.decodeUnknown(metadataSchema)(metadata ?? {}).pipe(
    Effect.map((value) => value[HARNESS_CONSUMER_META_KEY]),
  );
/** Native hosts validate polling results without loading the daemon SDK. */
export const decodePollResult = Schema.decodeUnknown(pollResultSchema);

/** Read-only content lookup never acknowledges or retries delivery. */
export const readEventRequestSchema = exactStruct({
  eventId: Schema.propertySignature(eventIdSchema).annotations({
    description:
      "The eventId of an org.social-harness/inbox.item event, or one a host's wakeup carries from an inbox item; retained content remains readable after acknowledgment.",
  }),
});
/** The original classified payload, including after its handoff. */
// eslint-disable-next-line agent-code-guard/no-exported-brand-constructor -- The MCP catalog projects the event-read result to JSON Schema; hosts decode it through this file's boundary functions.
export const readEventResultSchema = Schema.Struct({
  item: InboundItem,
  guidance: Schema.optionalWith(localGuidanceSchema, { exact: true }),
});

/** A delivery acknowledgment names the delivery it retires. */
export const harnessAcknowledgeDeliveryRequestSchema = exactStruct({
  deliveryToken: Schema.propertySignature(DeliveryToken).annotations({
    description:
      "Stable delivery token from the inbox item accepted by the host.",
  }),
});

/** The model-visible arguments of one send. */
export const harnessSendArgumentsSchema = exactStruct({
  input: Schema.propertySignature(SendInput).annotations({
    description:
      "One send to agent:<name> or group:<members>: text with an optional collective operation, or a collectiveResponse to an open request.",
  }),
});
const harnessSendRequestSchema = harnessSendArgumentsSchema;
const harnessMessageReadyEventSchema = Schema.Struct({
  deliveryToken: DeliveryToken,
  item: InboundItem,
  guidance: Schema.optionalWith(localGuidanceSchema, { exact: true }),
});

/** One page request over the classified inbox. */
export const inboxRequestSchema = exactStruct({
  cursor: Schema.optionalWith(
    Schema.String.annotations({
      description:
        "Opaque nextCursor from the previous inbox page; omit for the first page.",
    }),
    { exact: true },
  ),
});
/** One page of classified deliveries and the cursor after it. */
// eslint-disable-next-line agent-code-guard/no-exported-brand-constructor -- The MCP catalog projects the inbox page to JSON Schema; hosts decode it through this file's boundary functions.
export const inboxResultSchema = Schema.Struct({
  items: Schema.Array(harnessMessageReadyEventSchema),
  nextCursor: Schema.optionalWith(Schema.String, { exact: true }),
});
/** Validation diagnostics remain decodable as a send refusal at the runtime edge. */
const invocationValidationErrorSchema = Schema.Struct({
  reason: Schema.Literal("content-invalid"),
  detail: Schema.optionalWith(Schema.String, { exact: true }),
  issues: Schema.Array(
    Schema.Struct({
      path: Schema.Array(Schema.Union(Schema.String, Schema.Number)),
      message: Schema.String,
    }),
  ),
});

/**
 * The JSON-RPC error data of a refused `send_message`: a `SendError` reason
 * with the detail naming its specific cause, or a refused collective send with its id and the failure naming each
 * unreachable member or failing field, which `decodeCollectiveFailure`
 * validates; for an answer that named no request while several were open,
 * `openIds`; and for a `request-none`, `request-answered` or
 * `request-expired` refusal, `openElsewhere`, the questions open in other
 * conversations. Fields a newer daemon adds are ignored; a firewall or
 * collective refusal that misses its own fields never decodes as a plain
 * reason.
 */
const harnessSendErrorDataSchema = Schema.Union(
  invocationValidationErrorSchema,
  Schema.Struct({
    reason: Schema.Literal("firewall-refused"),
    ...firewallRefusalSchema.fields,
  }),
  Schema.Struct({
    reason: Schema.Literal("collective-failed"),
    id: CollectiveId,
    failure: Schema.Unknown,
    openIds: Schema.optionalWith(Schema.Array(CollectiveId), { exact: true }),
    openElsewhere: Schema.optionalWith(
      Schema.Array(
        Schema.Struct({
          id: CollectiveId,
          to: Schema.Union(AgentAddress, GroupAddress),
        }),
      ),
      { exact: true },
    ),
  }),
  Schema.Struct({
    reason: Schema.String.pipe(
      Schema.filter(
        (reason) =>
          reason !== "firewall-refused" && reason !== "collective-failed",
      ),
    ),
    detail: Schema.optionalWith(Schema.String, { exact: true }),
  }),
);

/** Decoded pagination request for the current classified inbox. */
export type HarnessReadInboxRequest = typeof inboxRequestSchema.Type;
/** Classified deliveries, bounded by the daemon's snapshot pagination. */
export type HarnessReadInboxResult = typeof inboxResultSchema.Type;

/** Decode a bounded inbox page received through the MCP transport. */
export const decodeHarnessReadInboxResult =
  Schema.decodeUnknown(inboxResultSchema);

/** Validate one send's input before it runs. */
export const decodeHarnessSendRequest = Schema.decodeUnknown(
  harnessSendRequestSchema,
);

/** Decoded delivery acknowledgment arguments owned by the daemon. */
export type HarnessAcknowledgeDeliveryRequest =
  typeof harnessAcknowledgeDeliveryRequestSchema.Type;

/** Validated semantic input of one send. */
export type HarnessSendRequest = typeof harnessSendRequestSchema.Type;

/**
 * Decoded error data of one refused `send_message` call.
 * @inline
 */
export type HarnessSendErrorData =
  | typeof invocationValidationErrorSchema.Type
  | (typeof firewallRefusalSchema.Type & {
      readonly reason: "firewall-refused";
    })
  | Readonly<{ reason: string; detail?: string }>
  | Readonly<{
      reason: "collective-failed";
      id: CollectiveId;
      failure: Effect.Effect.Success<
        ReturnType<typeof decodeCollectiveFailure>
      >;
      openIds?: readonly CollectiveId[];
      openElsewhere?: CollectiveError["openElsewhere"];
    }>;

/**
 * The error data a refused send carries across the daemon boundary: a
 * collective failure keeps its id and the members or fields it names, and a
 * send failure keeps the detail naming its cause, so the receiving side
 * rebuilds the same typed error and message.
 * @param error The refused send's typed error.
 * @returns The JSON error data.
 */
export function sendErrorData(
  error: SendError | CollectiveError | FirewallSendError,
): HarnessSendErrorData {
  if (error._tag === "FirewallSendError") {
    return {
      reason: "firewall-refused",
      checkId: error.checkId,
      refusal: error.refusal,
      feedback: error.feedback,
    };
  }
  if (error._tag === "CollectiveError") {
    return {
      reason: "collective-failed",
      id: error.id,
      failure: error.failure,
      ...(error.openIds === undefined ? {} : { openIds: error.openIds }),
      ...(error.openElsewhere === undefined
        ? {}
        : { openElsewhere: error.openElsewhere }),
    };
  }
  if (error.detail === undefined) {
    return { reason: error.reason };
  }
  return { reason: error.reason, detail: error.detail };
}

/** Decoded result of one `send_message` operation. */
export type HarnessSendResult = SendResult;

/** One stable pending inbound item emitted by the daemon. */
export type HarnessMessageReadyEvent =
  typeof harnessMessageReadyEventSchema.Type;

/**
 * Decode one exact delivery acknowledgment request.
 * @param value Untrusted tool arguments.
 * @returns The validated request.
 */
export function decodeHarnessAcknowledgeDeliveryRequest(
  value: unknown,
): Effect.Effect<HarnessAcknowledgeDeliveryRequest, ParseResult.ParseError> {
  return Schema.decodeUnknown(harnessAcknowledgeDeliveryRequestSchema)(
    value,
    exactParseOptions,
  );
}

/**
 * Decode one exact pending-delivery notification payload.
 * @param value Untrusted notification parameters.
 * @returns The validated pending delivery.
 */
export function decodeHarnessMessageReadyEvent(
  value: unknown,
): Effect.Effect<HarnessMessageReadyEvent, ParseResult.ParseError> {
  return Schema.decodeUnknown(harnessMessageReadyEventSchema)(value);
}

/**
 * Decode the error data of one refused `send_message` call.
 * @param value Untrusted JSON-RPC error data.
 * @returns The collective failure or send reason it carries.
 */
export function decodeHarnessSendErrorData(
  value: unknown,
): Effect.Effect<HarnessSendErrorData, ParseResult.ParseError> {
  return Schema.decodeUnknown(harnessSendErrorDataSchema)(value).pipe(
    Effect.flatMap(
      (data): Effect.Effect<HarnessSendErrorData, ParseResult.ParseError> =>
        "failure" in data
          ? decodeCollectiveFailure(data.failure).pipe(
              Effect.map((failure) => ({ ...data, failure })),
            )
          : Effect.succeed(data),
    ),
  );
}

/**
 * Decode one `send_message` result, ignoring fields this release does not
 * name.
 * @param value Untrusted structured tool content.
 * @returns The operation id a gather names and the local firewall's guidance
 * on the admitted send, each if any.
 */
export function decodeHarnessSendResult(
  value: unknown,
): Effect.Effect<HarnessSendResult, ParseResult.ParseError> {
  return Schema.decodeUnknown(SendResult)(value);
}

/**
 * Check one `send_message` result exactly before the daemon returns it, so a
 * field this release does not name never leaves the daemon.
 * @param value The operation's result.
 * @returns The validated result.
 */
export function checkHarnessSendResult(
  value: unknown,
): Effect.Effect<HarnessSendResult, ParseResult.ParseError> {
  return Schema.decodeUnknown(SendResult)(value, exactParseOptions);
}

/** The existing endpoint store owns both callback progress and immutable inbox items. */
export type EventStore = Pick<
  EndpointStore,
  | "readEventState"
  | "writeEventState"
  | "readInbox"
  | "readInboxItem"
  | "readInboxSummary"
  | "completeWebhookDelivery"
>;

/** Reversible naming keeps lookup independent of subscription and retry state. */
export const eventIdOf = (token: DeliveryToken): string =>
  `evt_${token.slice(4)}`;

type ClosedOperationError = Readonly<{ readonly reason: string }>;

/** The delivery operations a host calls: inbox and event reads, sends, and acknowledgments. */
export interface DeliveryOperations {
  readonly readEvent: (
    input: typeof readEventRequestSchema.Type,
  ) => Effect.Effect<typeof readEventResultSchema.Type, ClosedOperationError>;
  readonly readInboxSummary: () => Effect.Effect<
    InboxSummary,
    ClosedOperationError
  >;
  readonly readInbox: (
    input: HarnessReadInboxRequest,
  ) => Effect.Effect<HarnessReadInboxResult, ClosedOperationError>;
  readonly send: (
    request: HarnessSendRequest,
  ) => Effect.Effect<
    HarnessSendResult,
    SendError | CollectiveError | FirewallSendError
  >;
  readonly acknowledgeDelivery: (
    deliveryToken: DeliveryToken,
  ) => Effect.Effect<void, ClosedOperationError>;
}

/** Store-owned delivery identity shared across the loopback boundary. */
export { DeliveryToken } from "../communication/store/types.js";
/** Store-owned pending-inbox summary shared across the loopback boundary. */
export type { InboxSummary } from "../communication/store/types.js";
