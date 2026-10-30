/**
 * @file Collective-layer values carried inside a certified message's content.
 *
 * A collective value travels as one `data` part whose value is an object with
 * the key `COLLECTIVE_DATA_KEY`. `Content` stays a generic container; only
 * endpoints read the part, and the Router sees only the envelope. Every value
 * carries a `kind` discriminant so an endpoint classifies a part without trying
 * each shape in turn.
 */

import { Data, Effect, Option, Schema } from "effect";
import { randomBytes } from "node:crypto";
import { exactStruct } from "../../../encoding/exact.js";
import { AgentId } from "../../../identity/identifiers.js";
import { WIRE_VERSION } from "../../../identity/wire-version.js";
import { Content, RecordHash } from "../../records/index.js";
import { wireProfiles } from "../../records/values.js";
import {
  AcceptResponse,
  collectiveClosure,
  CollectiveId,
  DeclineResponse,
  EpochMillis,
  RequestedSchema,
} from "../contracts.js";
import { FormFieldSchema } from "./answer-fields.js";

/** One admitted form field, the shape answer checks read. */
export type { FormField } from "./answer-fields.js";

/* eslint-disable @typescript-eslint/naming-convention, @typescript-eslint/no-redeclare -- Effect Schemas share their domain names with the values they decode. */

type MessageContent = typeof Content.Type;

/** The `data` part key under which the collective layer carries its value. */
export const COLLECTIVE_DATA_KEY = wireProfiles[WIRE_VERSION].collectiveDataKey;

/**
 * The MCP form-mode `requestedSchema`: a flat object of primitive properties.
 * Every `required` name must be a declared property, since an answer can carry
 * no other field.
 */
export const FormModeSchema = exactStruct({
  ...RequestedSchema.fields,
  properties: Schema.Record({ key: Schema.String, value: FormFieldSchema }),
}).pipe(
  Schema.filter(
    (schema) => {
      const undeclared = (schema.required ?? []).filter(
        (name) => !Object.hasOwn(schema.properties, name),
      );
      return (
        undeclared.length === 0 || {
          path: ["required"],
          message: `names ${undeclared.map((name) => JSON.stringify(name)).join(", ")}, which properties does not declare`,
        }
      );
    },
    {
      identifier: "RequestedSchema",
      description: "Form-mode schema whose required names are properties",
    },
  ),
);
/** A validated form-mode schema for one collective question. */
export type FormModeSchema = typeof FormModeSchema.Type;

const decodeCollectiveId = Schema.decodeUnknownSync(CollectiveId);
const decodeAgentId = Schema.decodeUnknownSync(AgentId);

/**
 * Read the requester embedded in an operation ID. Request admission compares
 * this identity with the certified author before accepting the operation.
 */
export const collectiveRequesterOf = (operationId: CollectiveId): AgentId =>
  decodeAgentId(
    `agt_${Buffer.from(operationId.slice(4), "base64url")
      .subarray(0, 16)
      .toString("base64url")}`,
  );

/** Distinct requesters retain distinct operation IDs even when their random bytes match. */
export const mintCollectiveId = (requester: AgentId) =>
  Effect.sync(() =>
    decodeCollectiveId(
      `col_${Buffer.concat([
        Buffer.from(requester.slice(4), "base64url"),
        randomBytes(32),
      ]).toString("base64url")}`,
    ),
  );

/** A plain message: multicast carries neither a deadline nor a schema. */
const MulticastOperation = exactStruct({
  kind: Schema.Literal("operation"),
  op: Schema.Literal("multicast"),
});

/**
 * A question to every member. `operationId` embeds the requester's immutable
 * identity. `deadlineAt` is absolute epoch milliseconds: the
 * sending endpoint converts the model's relative duration at send, and
 * endpoints assume zero clock skew.
 */
const CollectingOperation = exactStruct({
  kind: Schema.Literal("operation"),
  op: Schema.Literal("gather", "all_gather"),
  operationId: CollectiveId,
  deadlineAt: EpochMillis,
  requestedSchema: FormModeSchema,
});

/** The request a member's reply answers. */
const responseHead = {
  kind: Schema.Literal("response"),
  operationId: CollectiveId,
};

/** A member's reply to one request; only `accept` carries content. */
const CollectiveResponse = Schema.Union(
  exactStruct({
    ...responseHead,
    action: AcceptResponse.fields.action,
    content: AcceptResponse.fields.content,
  }),
  exactStruct({ ...responseHead, action: DeclineResponse.fields.action }),
);

/** The requester's completion decision and counted answers, identified by certified record hash. */
const CollectiveClose = exactStruct({
  kind: Schema.Literal("close"),
  operationId: CollectiveId,
  ...collectiveClosure.fields,
  included: Schema.Array(RecordHash),
});

/** Every value the collective layer carries, discriminated by `kind`. */
const CollectiveValue = Schema.Union(
  MulticastOperation,
  CollectingOperation,
  CollectiveResponse,
  CollectiveClose,
);
/** A validated collective value. */
export type CollectiveValue = typeof CollectiveValue.Type;

/** An accepted or declined answer carried in a certified message. */
export type ResponseValue = Extract<
  CollectiveValue,
  { readonly kind: "response" }
>;

/** Content carries a collective part that is duplicated or does not decode. */
export class CollectivePartInvalidError extends Data.TaggedError(
  "CollectivePartInvalidError",
)<{
  readonly reason: "duplicate" | "malformed";
}> {}

/** A collective value and its text do not form content within the 32,768-byte canonical limit. */
export class CollectiveContentError extends Data.TaggedError(
  "CollectiveContentError",
) {}

/**
 * Any object value that carries the collective key; other keys are ignored.
 * `exact` keeps a missing key from decoding as `undefined`.
 */
const CollectiveCarrier = Schema.Struct({
  [COLLECTIVE_DATA_KEY]: Schema.Unknown,
}).annotations({ parseOptions: { exact: true } });

function collectivePartValue(
  part: MessageContent[number],
): Option.Option<unknown> {
  return part.type === "data"
    ? Schema.decodeUnknownOption(CollectiveCarrier)(part.value).pipe(
        Option.map((carrier) => carrier[COLLECTIVE_DATA_KEY]),
      )
    : Option.none();
}

/**
 * Remove the collective part from message content, keeping every other part in
 * order.
 * @param content Certified message content.
 * @returns The remaining parts, empty when the collective part was the only one.
 */
export const withoutCollectivePart = (
  content: MessageContent,
): ReadonlyArray<MessageContent[number]> =>
  content.filter((part) => Option.isNone(collectivePartValue(part)));

/**
 * Decode one untrusted collective value.
 * @param value The value found under `COLLECTIVE_DATA_KEY`.
 * @returns The validated value.
 */
export const decodeCollectiveValue = Schema.decodeUnknown(CollectiveValue);

/**
 * Find and decode the collective value in one message's content.
 * @param content Certified message content.
 * @returns The decoded value, or none when the content carries no collective part.
 */
export const readCollectiveValue = (
  content: MessageContent,
): Effect.Effect<
  Option.Option<CollectiveValue>,
  CollectivePartInvalidError
> => {
  const [only, ...rest] = content.flatMap((part) =>
    Option.toArray(collectivePartValue(part)),
  );
  if (only === undefined) {
    return Effect.succeed(Option.none());
  }
  if (rest.length > 0) {
    return Effect.fail(new CollectivePartInvalidError({ reason: "duplicate" }));
  }
  return decodeCollectiveValue(only).pipe(
    Effect.map(Option.some),
    Effect.catchTag("ParseError", () =>
      Effect.fail(new CollectivePartInvalidError({ reason: "malformed" })),
    ),
  );
};

/**
 * Build message content from a collective value and optional message text. The
 * public `Content` schema applies the one canonical size limit.
 * @param value The collective value to carry in the data part.
 * @param text The message body; for gather and all_gather, the question.
 * @returns Content with the text first and the collective part last.
 */
export const encodeCollectiveContent = (
  value: CollectiveValue,
  text?: string,
): Effect.Effect<MessageContent, CollectiveContentError> =>
  Schema.encode(CollectiveValue)(value).pipe(
    Effect.flatMap((encoded) =>
      Schema.decodeUnknown(Content)([
        ...(text === undefined ? [] : [{ type: "text", text }]),
        { type: "data", value: { [COLLECTIVE_DATA_KEY]: encoded } },
      ]),
    ),
    Effect.catchTag("ParseError", () =>
      Effect.fail(new CollectiveContentError()),
    ),
  );

/* eslint-enable @typescript-eslint/naming-convention, @typescript-eslint/no-redeclare -- Restore the package naming rules after the Schema/type pairs. */
