/** @file Shared schema and ports for the experimental MCP Events edge. */

import {
  fromJsonSchema,
  type JsonSchemaType,
  type ProtocolError,
} from "@modelcontextprotocol/server";
import { Effect, JSONSchema, Schema } from "effect";
import { InboundItem } from "../../communication/collectives/inbound.js";
import { exactStruct } from "../../encoding/exact.js";
import { localGuidanceSchema } from "../../firewall/outcome/index.js";
import { HARNESS_CONSUMER_META_KEY, INBOX_ITEM_EVENT } from "./names.js";
import { eventIdSchema } from "./operations.js";
/** Maximum complete UTF-8 callback body accepted by the event transport. */
export const maximumEventBytes = 256 * 1024;

/** Callback failures expose no upstream response or destination details. */
export const callbackReasons = [
  "connection_refused",
  "timeout",
  "tls_error",
  "http_4xx",
  "http_5xx",
  "challenge_failed",
] as const;
/** Owner-visible diagnostics omit callback addresses and signing authority. */
const webhookStatusSchema = Schema.Struct({
  mode: Schema.Literal("none", "push", "poll", "webhook"),
  id: Schema.optional(Schema.String),
  refreshBefore: Schema.optional(Schema.String),
  pendingCount: Schema.optional(Schema.NonNegativeInt),
  stalled: Schema.optional(
    Schema.NullOr(Schema.Literal("callback", "terminal")),
  ),
  lastError: Schema.optional(Schema.NullOr(Schema.Literal(...callbackReasons))),
});

/** Secret-free diagnostics shared with the owner-only MCP tool. */
export type WebhookStatus = typeof webhookStatusSchema.Type;

/** JSON Schema for the owner-only, secret-free event status tool. */
export const webhookStatusJsonSchema = JSONSchema.make(webhookStatusSchema, {
  target: "jsonSchema2020-12",
});

const emptyArguments = Schema.Record({
  key: Schema.String,
  value: Schema.Never,
});
/** An absent cursor has the draft's explicit null meaning. */
const subscriptionSchema = Schema.Struct({
  name: Schema.String,
  arguments: emptyArguments,
  cursor: Schema.optionalWith(Schema.NullOr(Schema.String), { exact: true }),
  maxAgeMs: Schema.optionalWith(Schema.NonNegativeInt, { exact: true }),
});
const pollSchema = Schema.Struct({
  ...subscriptionSchema.fields,
  _meta: Schema.optional(
    Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  ),
  maxEvents: Schema.optionalWith(Schema.Int.pipe(Schema.positive()), {
    exact: true,
  }),
});

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
/** Native hosts validate polling results without gaining store authority. */
export const decodePollResult = Schema.decodeUnknown(pollResultSchema);
/** Catalog pagination uses its own cursor rather than event replay state. */
const listSchema = Schema.Struct({
  cursor: Schema.optionalWith(Schema.String, { exact: true }),
});
/** Delivery policy checks follow SDK shape validation. */
const subscribeSchema = Schema.Struct({
  ...subscriptionSchema.fields,
  delivery: Schema.Struct({
    mode: Schema.String,
    url: Schema.String,
    secret: Schema.String,
  }),
  ttlMs: Schema.optionalWith(Schema.NullOr(Schema.NonNegativeInt), {
    exact: true,
  }),
});
/** Cleanup identifies the registration without disclosing its signing secret. */
const unsubscribeSchema = Schema.Struct({
  name: Schema.String,
  arguments: emptyArguments,
  delivery: Schema.Struct({ url: Schema.String }),
});

/** Validated webhook subscription parameters before authorization and URL checks. */
export type EventSubscribeInput = typeof subscribeSchema.Type;
/** Exact subscription key supplied for eager webhook cleanup. */
export type EventUnsubscribeInput = typeof unsubscribeSchema.Type;
/** Server grant for one webhook registration. */
interface EventSubscriptionGrant {
  readonly id: string;
  readonly refreshBefore: string;
  readonly cursor: null;
  readonly truncated: boolean;
}

/** Durable webhook edge, available only for an authenticated runtime principal. */
export interface HarnessWebhookEvents {
  readonly hasActiveSubscription: () => boolean;
  readonly subscribe: (
    input: EventSubscribeInput,
    principal: string,
    authorize?: Effect.Effect<void, ProtocolError>,
  ) => Effect.Effect<EventSubscriptionGrant, ProtocolError>;
  readonly unsubscribe: (
    input: EventUnsubscribeInput,
    principal: string,
  ) => Effect.Effect<void, ProtocolError>;
  readonly observe: () => Effect.Effect<void, ProtocolError>;
  readonly status: Effect.Effect<WebhookStatus, ProtocolError>;
  readonly revoke: Effect.Effect<void, ProtocolError>;
  readonly resume: Effect.Effect<void, ProtocolError>;
}

const standard = <A, I>(schema: Schema.Schema<A, I>) =>
  fromJsonSchema<A>(
    // eslint-disable-next-line agent-code-guard/require-assertion-rationale -- Effect emits the JSON Schema object consumed by the pinned official SDK.
    JSONSchema.make(schema, { target: "jsonSchema2020-12" }) as JsonSchemaType,
  );

/** Native streaming uses the same event and replay grammar as callbacks. */
export type EventStreamInput = typeof subscriptionSchema.Type;
/** SDK boundary validation keeps schema constructors private. */
export const eventStreamInput = standard(subscriptionSchema);
/** Polling adds a bounded occurrence count to the shared replay grammar. */
export type EventPollInput = typeof pollSchema.Type;
/** The official SDK validates poll requests before acquiring a consumer. */
export const eventPollInput = standard(pollSchema);
/** The event catalog has its own pagination grammar. */
export const eventListInput = standard(listSchema);
/** Callback registration includes the signing authority and lease request. */
export const eventSubscribeInput = standard(subscribeSchema);
/** Cleanup uses only the subscription's public key fields. */
export const eventUnsubscribeInput = standard(unsubscribeSchema);
