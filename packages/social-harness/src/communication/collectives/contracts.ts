/** @file Collective operations, answers and the closed errors of a refused collective send. */

import { Data, ParseResult, Schema } from "effect";
import type { AgentView } from "../../identity/cards.js";
import { exactStruct } from "../../encoding/exact.js";
import { isCanonicalIdentifier } from "../../encoding/identifier.js";
import { checkedGuidanceSchema } from "../../firewall/outcome/index.js";
import {
  issuesText,
  type SendError,
  sendFailureReasons,
  sendFailureText,
} from "../conversations/errors.js";
import {
  AgentAddress,
  GroupAddress,
  JsonValue,
  MessageAddressInput,
  PostId,
  wellFormedString,
} from "../records/values.js";

/* eslint-disable @typescript-eslint/naming-convention, @typescript-eslint/no-redeclare -- Effect Schemas share their domain names with the nominal values they decode. */

/** The agents a collecting operation asks, in result order. */
export type Members = readonly [AgentView, ...AgentView[]];

/**
 * Identity of one gather or all_gather, minted by the requesting endpoint.
 * The request, each member's answer post, an all_gather's close, the result
 * and any failure carry it. An answer that matches no single open request is
 * refused under an id minted for the refusal, so its failure is named too.
 */
export const CollectiveId = Schema.String.pipe(
  Schema.filter((value) => isCanonicalIdentifier("col_", value), {
    description:
      "A collective operation id: col_ followed by 43 base64url characters",
  }),
  Schema.brand("CollectiveId"),
);
/** A validated collective operation id. */
export type CollectiveId = typeof CollectiveId.Type;

/** One property of a form-mode schema as a caller states it. */
const formProperty = Schema.Record({ key: Schema.String, value: JsonValue });

/**
 * The MCP form-mode `requestedSchema` of a collecting operation: a flat object
 * of primitive properties. This schema fixes its outline; the sending endpoint
 * checks each property against the MCP form-mode grammar before any post.
 */
export const RequestedSchema = exactStruct({
  $schema: Schema.optionalWith(Schema.String, { exact: true }),
  type: Schema.Literal("object"),
  properties: Schema.Record({ key: Schema.String, value: formProperty }),
  required: Schema.optionalWith(Schema.Array(Schema.String), { exact: true }),
});
/** A form-mode schema as stated by its requester. */
export type RequestedSchema = typeof RequestedSchema.Type;

/**
 * One answer to a collecting operation, field by field. Its value space is MCP
 * `ElicitResult` content's; the request's schema decides which fields apply.
 */
export const AnswerContent = Schema.Record({
  key: Schema.String,
  value: Schema.Union(
    Schema.String,
    Schema.Number.pipe(Schema.finite()),
    Schema.Boolean,
    Schema.Array(Schema.String),
  ),
}).annotations({
  description: "The answer, one field per requestedSchema property",
});
/** A structurally valid answer. */
export type AnswerContent = typeof AnswerContent.Type;

/** The longest deadline a collecting operation may state: 30 days, in seconds. */
export const MAXIMUM_DEADLINE_SECONDS = 2_592_000;

/** A collecting operation's relative deadline: whole seconds, up to 30 days. */
export const DeadlineSeconds = Schema.Number.pipe(
  Schema.int(),
  Schema.between(1, MAXIMUM_DEADLINE_SECONDS),
);

/** The latest instant a `Date` represents, in epoch milliseconds. */
const MAXIMUM_EPOCH_MILLIS = 8_640_000_000_000_000;

/** Positive Unix milliseconds within the range a `Date` can render. */
export const EpochMillis = Schema.Int.pipe(
  Schema.between(1, MAXIMUM_EPOCH_MILLIS),
);

/** The requester's first completion decision, retained before closing or delivering a result. */
export const collectiveClosure = exactStruct({
  closedAt: Schema.Int.pipe(
    Schema.between(0, MAXIMUM_EPOCH_MILLIS),
  ).annotations({
    description: "Unix milliseconds when the requester first froze completion",
  }),
  closedBy: Schema.Literal("settled", "deadline").annotations({
    description:
      "Whether every requested member had an outcome or the deadline left members unresolved",
  }),
});
/** Completion metadata remains identical across recovery and all-gather participants. */
export type CollectiveClosure = typeof collectiveClosure.Type;

/**
 * Multicast: one post to the `to` address, complete when certified. `op`
 * defaults to multicast, so an omitted `op` and an omitted `collective` mean
 * the same operation.
 */
const multicastOperation = exactStruct({
  op: Schema.optionalWith(Schema.Literal("multicast"), { exact: true }),
});

/**
 * A collecting operation: the text is a question to every member of `to`.
 * A gather sends one request post to each member, in that member's direct
 * conversation with the requester, and only the requester receives the
 * result. An all_gather sends one request post to the `group:` conversation
 * `to` names; members answer there, no model sees a peer's answer before the
 * requester's close, and every member receives the same result. The deadline
 * is relative, in whole seconds; the sending endpoint converts it to an
 * absolute time at send.
 */
const collectingOperation = exactStruct({
  op: Schema.Literal("gather", "all_gather"),
  deadline: DeadlineSeconds,
  requestedSchema: RequestedSchema,
});

/** The collective operation one send performs, discriminated by `op`. */
const CollectiveOperation = Schema.Union(
  multicastOperation,
  collectingOperation,
);
/** A validated collective operation. */
export type CollectiveOperation = typeof CollectiveOperation.Type;

/** The request an answer names: the `col_` id its `collectiveRequest` item carries. */
const answeredRequest = {
  id: Schema.optionalWith(CollectiveId, { exact: true }),
};

/** An `accept` answer, the only one that carries content. */
export const AcceptResponse = exactStruct({
  action: Schema.Literal("accept"),
  content: AnswerContent,
  ...answeredRequest,
});

/** A `decline` answer. */
export const DeclineResponse = exactStruct({
  action: Schema.Literal("decline"),
  ...answeredRequest,
});

/**
 * A member's answer to a request open in the conversation it is sent to: the
 * requester's direct conversation for a gather, the group for an all_gather.
 * `id` names the request; without it the answer goes to the one request open
 * there. It is MCP's `ElicitResult`; only `accept` carries content, valid
 * against the request's schema.
 */
const CollectiveResponse = Schema.Union(AcceptResponse, DeclineResponse);
/** A validated collective response. */
export type CollectiveResponse = typeof CollectiveResponse.Type;

/**
 * One send to one address: text with its collective operation, multicast
 * when `collective` is omitted, or an answer to the request open in that
 * address's conversation. `parseMessageText` reads both from a message's
 * text.
 */
export const SendInput = Schema.Union(
  exactStruct({
    to: MessageAddressInput,
    text: wellFormedString,
    collective: Schema.optionalWith(CollectiveOperation, { exact: true }),
  }),
  exactStruct({
    to: MessageAddressInput,
    collectiveResponse: CollectiveResponse,
  }),
).annotations({ identifier: "SendInput" });
/**
 * Validated input for one send.
 * @useDeclaredType
 */
export type SendInput = typeof SendInput.Type;

/** Members a send could not reach. */
const unreachableMembers = Schema.NonEmptyArray(
  exactStruct({
    member: AgentAddress,
    reason: Schema.Literal(...sendFailureReasons),
    detail: Schema.optionalWith(Schema.String, { exact: true }),
  }),
);

/** The local firewall's advice accompanies any successful invocation it admitted. */
const sendGuidance = {
  guidance: Schema.optionalWith(checkedGuidanceSchema, { exact: true }),
};

/** Owned fields from a different result kind cannot accompany this result. */
const absentResultField = Schema.Never.annotations({
  identifier: "AbsentSendResultField",
});

/**
 * A successful invocation identifies its operation explicitly. Multicasts
 * and responses name their certified post and canonical conversation address.
 * Collecting operations name the operation whose result arrives in the inbox.
 * A response also names the request it answered. Refusals use the error channel.
 * Readers may ignore future fields, but fields owned by another result kind
 * cannot describe this result.
 */
export const SendResultSchema = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("multicast"),
    postId: PostId,
    address: Schema.Union(AgentAddress, GroupAddress),
    operationId: Schema.optionalWith(absentResultField, { exact: true }),
    ...sendGuidance,
  }),
  Schema.Struct({
    kind: Schema.Literal("response"),
    operationId: CollectiveId,
    postId: PostId,
    address: Schema.Union(AgentAddress, GroupAddress),
    ...sendGuidance,
  }),
  Schema.Struct({
    kind: Schema.Literal("collective"),
    operationId: CollectiveId,
    postId: Schema.optionalWith(absentResultField, { exact: true }),
    address: Schema.optionalWith(absentResultField, { exact: true }),
    ...sendGuidance,
  }),
).annotations({ identifier: "SendResult" });
/**
 * A certified message, a certified answer or an accepted collective operation.
 * @useDeclaredType
 */
export type SendResult = typeof SendResultSchema.Type;

/** Private completion retains the posts certified before the invocation returned. */
export type CollectiveSendOutcome = SendResult & {
  readonly postIds: readonly PostId[];
};

/**
 * Why a collective send was refused, discriminated by `kind`: a gather or
 * all_gather whose schema is outside the form-mode grammar, whose request
 * post some member could not receive, or whose deadline passed while its
 * check ran; or a response the member's endpoint cannot send.
 */
const collectiveFailure = Schema.Union(
  exactStruct({
    kind: Schema.Literal("members-unreachable"),
    members: unreachableMembers,
  }),
  exactStruct({
    kind: Schema.Literal("schema-invalid"),
    detail: Schema.String,
  }),
  exactStruct({
    kind: Schema.Literal("answer-invalid"),
    fields: Schema.NonEmptyArray(
      exactStruct({
        field: Schema.String,
        reason: Schema.Literal("missing", "unexpected", "invalid"),
        detail: Schema.optionalWith(Schema.String, { exact: true }),
      }),
    ),
  }),
  exactStruct({ kind: Schema.Literal("request-none") }),
  exactStruct({
    kind: Schema.Literal("request-ambiguous"),
    openIds: Schema.Array(CollectiveId).pipe(Schema.minItems(2)),
  }),
  exactStruct({ kind: Schema.Literal("request-answered") }),
  exactStruct({ kind: Schema.Literal("request-expired") }),
  exactStruct({ kind: Schema.Literal("deadline-passed") }),
);
/** A validated collective failure. */
export type CollectiveFailure = typeof collectiveFailure.Type;

/**
 * Decode a collective failure carried across the loopback MCP boundary.
 * @param value Untrusted failure detail from a refused send's error data.
 * @returns The validated failure.
 */
export const decodeCollectiveFailure = Schema.decodeUnknown(collectiveFailure);

/**
 * The text of an all_gather whose close was not certified, so the asker has
 * no result. A close refused before it was queued reaches no member; a
 * `delivery-pending` close reaches them once Social Harness is reachable, and its
 * text says so.
 * @param error Why the close post failed.
 * @returns The `operationFailed` text the asker's model reads.
 */
export function closeFailureText(error: SendError): string {
  return `all_gather failed: the result could not be shared with the group: ${error.detail ?? sendFailureText[error.reason]}`;
}

/**
 * One line per issue of a decode failure, each led by its path, such as
 * `requestedSchema.type: Expected "object", actual "obj"`, joined by `; `.
 * A model repairs its input from this text alone.
 * @param error The failed decode.
 * @returns The issues as text.
 */
export const describeIssues = (error: ParseResult.ParseError): string =>
  issuesText(ParseResult.ArrayFormatter.formatErrorSync(error));

/** What each answer-field problem means. */
const answerFieldText = {
  missing: "is missing",
  unexpected: "is not in the form",
  invalid: "is invalid",
} as const;

/** Every field of an answer that fails its request's schema. */
export type AnswerFieldFailures = Extract<
  CollectiveFailure,
  { readonly kind: "answer-invalid" }
>["fields"];

/**
 * Name each failing answer field, such as `field "slot" is invalid (enum)`.
 * A refused reply and a member's `invalid` outcome read the same. Field
 * names come from peers, so each is quoted as JSON: no name can close its
 * quotes or start a new line of the text a model reads.
 * @param fields The failing fields, in validation order.
 * @returns One clause per field, joined by `; `.
 */
export function answerFieldsText(fields: AnswerFieldFailures): string {
  return fields
    .map(({ field, reason, detail }) => {
      const named = `field ${JSON.stringify(field)} ${answerFieldText[reason]}`;
      return detail === undefined ? named : `${named} (${detail})`;
    })
    .join("; ");
}

/** A failure that carries nothing beyond its kind. */
type FixedFailureKind = Exclude<
  CollectiveFailure["kind"],
  | "members-unreachable"
  | "schema-invalid"
  | "answer-invalid"
  | "request-ambiguous"
>;

/** The text of each failure that carries nothing beyond its kind. */
const fixedFailureText: Record<FixedFailureKind, string> = {
  "request-none": "reply failed: no question is open in this conversation",
  "request-answered": "reply failed: the question was already answered",
  "request-expired": "reply failed: the question's deadline has passed",
  "deadline-passed":
    "send failed: the deadline passed before the question was posted",
};

function describeCollectiveFailure(failure: CollectiveFailure): string {
  if (isFixedFailure(failure)) {
    return fixedFailureText[failure.kind];
  }
  switch (failure.kind) {
    case "members-unreachable":
      return `send failed: ${failure.members
        .map(({ member, reason, detail }) =>
          reason === "unknown-agent"
            ? `${member} is not a known agent`
            : `${member} could not be reached: ${detail ?? sendFailureText[reason]}`,
        )
        .join("; ")}`;
    case "schema-invalid":
      return `send failed: the form is invalid (${failure.detail})`;
    case "answer-invalid":
      return `reply failed: ${answerFieldsText(failure.fields)}`;
    case "request-ambiguous":
      return `reply failed: several questions are open in this conversation. Set collectiveResponse.id to one of: ${failure.openIds.join(", ")}. Docs: https://github.com/social-harness/moltzap/blob/main/docs/reference/spec/communication/collectives.md#answers`;
    default: {
      const exhaustive: never = failure;
      return exhaustive;
    }
  }
}

function isFixedFailure(
  failure: CollectiveFailure,
): failure is Extract<CollectiveFailure, { readonly kind: FixedFailureKind }> {
  return Object.hasOwn(fixedFailureText, failure.kind);
}

/**
 * The service could not keep an item the layer emitted. The service has
 * already reported its own failure, so the layer only stops the work that
 * emitted the item.
 */
export class CollectiveEmitError extends Data.TaggedError(
  "CollectiveEmitError",
) {}

/**
 * A question open in a conversation other than the one an answer went to,
 * and where to answer it.
 * @inline
 */
export interface OpenElsewhere {
  readonly id: CollectiveId;
  readonly to: AgentAddress | GroupAddress;
}

/**
 * A gather, all_gather or answer was refused. The message is what a host
 * hands its model as the tool error: the failed action and its cause, naming
 * each unreachable member or failing field. For an answer that named no
 * request while several were open, it names each open request's id; for a
 * `request-none`, `request-answered` or `request-expired` refusal, the
 * questions open in other conversations and where each is answered. The
 * operation id stays in the error's data, not its message.
 */
export class CollectiveError extends Data.TaggedError("CollectiveError")<{
  readonly id: CollectiveId;
  readonly failure: CollectiveFailure;
  readonly openElsewhere?: readonly OpenElsewhere[];
}> {
  override get message(): string {
    const text = describeCollectiveFailure(this.failure);
    return this.openElsewhere === undefined
      ? text
      : `${text}; open in other conversations: ${this.openElsewhere
          .map(({ id, to }) => `${id} in ${to}`)
          .join(", ")}`;
  }
}

/* eslint-enable @typescript-eslint/naming-convention, @typescript-eslint/no-redeclare -- Restore the package naming rules after the Schema/type pairs. */
