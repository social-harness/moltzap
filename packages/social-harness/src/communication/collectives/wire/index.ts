/**
 * @file Collective-layer values carried inside a certified post's content.
 *
 * A collective value travels as one `data` part whose value is an object with
 * the key `COLLECTIVE_DATA_KEY`. `Content` stays a generic container; only
 * endpoints read the part, and the Router sees only the envelope. Every value
 * carries a `kind` discriminant so an endpoint classifies a part without trying
 * each shape in turn.
 */

import { Data, Effect, Option, Schema } from "effect";
import { createHash, randomBytes } from "node:crypto";
import { exactStruct } from "../../../encoding/exact.js";
import { WIRE_VERSION } from "../../../identity/wire-version.js";
import { type AgentAddress, Content, RecordHash } from "../../records/index.js";
import { wireProfiles } from "../../records/values.js";
import {
  AcceptResponse,
  CollectiveId,
  DeclineResponse,
  EpochMillis,
  RequestedSchema,
} from "../contracts.js";
import { FormFieldSchema } from "./grammar.js";

/** One admitted form field, the shape answer checks read. */
export type { FormField } from "./grammar.js";

/* eslint-disable @typescript-eslint/naming-convention, @typescript-eslint/no-redeclare -- Effect Schemas share their domain names with the values they decode. */

type PostContent = typeof Content.Type;

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

/** 32 random bytes in base64url, which a requester binds its collective id to. */
const CollectiveNonce = Schema.String.pipe(
  Schema.pattern(/^[A-Za-z0-9_-]{43}$/),
);

const decodeCollectiveId = Schema.decodeUnknownSync(CollectiveId);

/**
 * The collective id a requester's nonce names: `col_` and the base64url
 * SHA-256 of a domain tag, the requester's address and the nonce. A member
 * accepts a request only when its id derives from the request's certified
 * sender, so no agent can reuse an id another requester minted.
 * @param requester The agent that minted the id.
 * @param nonce The request's nonce.
 * @returns The id the pair names.
 */
export const collectiveIdOf = (
  requester: AgentAddress,
  nonce: string,
): CollectiveId =>
  decodeCollectiveId(
    `col_${createHash("sha256")
      .update(
        `${wireProfiles[WIRE_VERSION].collectiveIdDomain}\0${requester}\0${nonce}`,
      )
      .digest("base64url")}`,
  );

/**
 * A fresh nonce and the id it binds to the requester.
 * @param requester The address the id names as the operation's requester.
 * @returns The nonce and the collective id derived from it.
 */
export const mintCollectiveId = (requester: AgentAddress) =>
  Effect.sync(() => {
    const nonce = randomBytes(32).toString("base64url");
    return { id: collectiveIdOf(requester, nonce), nonce };
  });

/** A plain post: multicast carries neither a deadline nor a schema. */
const MulticastOperation = exactStruct({
  kind: Schema.Literal("operation"),
  op: Schema.Literal("multicast"),
});

/**
 * A question to every member. `id` derives from the requester and `nonce`
 * through `collectiveIdOf`. `deadlineAt` is absolute epoch milliseconds: the
 * sending endpoint converts the model's relative duration at send, and
 * endpoints assume zero clock skew.
 */
const CollectingOperation = exactStruct({
  kind: Schema.Literal("operation"),
  op: Schema.Literal("gather", "all_gather"),
  id: CollectiveId,
  nonce: CollectiveNonce,
  deadlineAt: EpochMillis,
  requestedSchema: FormModeSchema,
});

/** The request a member's reply answers. */
const responseHead = { kind: Schema.Literal("response"), id: CollectiveId };

/** A member's reply to one request; only `accept` carries content. */
const CollectiveResponse = Schema.Union(
  exactStruct({
    ...responseHead,
    action: AcceptResponse.fields.action,
    content: AcceptResponse.fields.content,
  }),
  exactStruct({ ...responseHead, action: DeclineResponse.fields.action }),
);

/** The requester's all_gather close: the included answers by certified record hash. */
const CollectiveClose = exactStruct({
  kind: Schema.Literal("close"),
  id: CollectiveId,
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
  part: PostContent[number],
): Option.Option<unknown> {
  return part.type === "data"
    ? Schema.decodeUnknownOption(CollectiveCarrier)(part.value).pipe(
        Option.map((carrier) => carrier[COLLECTIVE_DATA_KEY]),
      )
    : Option.none();
}

/**
 * Remove the collective part from post content, keeping every other part in
 * order.
 * @param content Certified post content.
 * @returns The remaining parts, empty when the collective part was the only one.
 */
export const withoutCollectivePart = (
  content: PostContent,
): ReadonlyArray<PostContent[number]> =>
  content.filter((part) => Option.isNone(collectivePartValue(part)));

/**
 * Decode one untrusted collective value.
 * @param value The value found under `COLLECTIVE_DATA_KEY`.
 * @returns The validated value.
 */
export const decodeCollectiveValue = Schema.decodeUnknown(CollectiveValue);

/**
 * Find and decode the collective value in one post's content.
 * @param content Certified post content.
 * @returns The decoded value, or none when the content carries no collective part.
 */
export const readCollectiveValue = (
  content: PostContent,
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
 * Build post content from a collective value and optional message text. The
 * public `Content` schema applies the one canonical size limit.
 * @param value The collective value to carry in the data part.
 * @param text The message body; for gather and all_gather, the question.
 * @returns Content with the text first and the collective part last.
 */
export const encodeCollectiveContent = (
  value: CollectiveValue,
  text?: string,
): Effect.Effect<PostContent, CollectiveContentError> =>
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
