/**
 * @file The MCP form-mode grammar for one property of a `requestedSchema`.
 *
 * Each shape is the MCP specification's primitive schema definition for one
 * kind of form field. Decoding tries the shapes in the specification's union
 * order and keeps the first that admits the property, without the keywords
 * that shape does not declare, so keywords outside the grammar never travel
 * or reach answer validation. A property no shape admits fails with the
 * failing keywords of the shape it most plausibly meant, so a requester can
 * repair the property it meant to write.
 */

import type { ParseOptions } from "effect/SchemaAST";
import {
  Array as Arr,
  Either,
  Option,
  ParseResult,
  Predicate,
  Schema,
} from "effect";
import { describeIssues } from "../contracts.js";

/* eslint-disable @typescript-eslint/naming-convention -- Effect Schemas take the names of the MCP specification shapes they mirror. */

const expectedText = (expected: string): string =>
  `Invalid input: expected ${expected}`;

/**
 * A keyword whose failure, ill-typed or missing, names what it expects.
 * `whole` reports a failure inside the keyword's value as one failure of the
 * keyword; a nested object keeps its own keywords' paths instead.
 */
const expecting = <A, I>(
  schema: Schema.Schema<A, I>,
  expected: string,
  whole = true,
): Schema.Schema<A, I> =>
  schema.annotations({
    message: () => ({ message: expectedText(expected), override: whole }),
  });

function keyword<A, I>(
  schema: Schema.Schema<A, I>,
  expected: string,
  whole = true,
) {
  return Schema.propertySignature(
    expecting(schema, expected, whole),
  ).annotations({ missingMessage: () => expectedText(expected) });
}

function optionalKeyword<A, I>(schema: Schema.Schema<A, I>, expected: string) {
  return Schema.optionalWith(expecting(schema, expected), { exact: true });
}

const FiniteNumber = Schema.Number.pipe(Schema.finite());
const StringList = Schema.Array(Schema.String);
const STRING_LIST = "an array of strings";

/** Labels every field shape may carry; neither constrains an answer. */
const labels = {
  title: optionalKeyword(Schema.String, "string"),
  description: optionalKeyword(Schema.String, "string"),
};

const stringType = keyword(Schema.Literal("string"), '"string"');
const arrayType = keyword(Schema.Literal("array"), '"array"');
const optionalString = optionalKeyword(Schema.String, "string");
const optionalNumber = optionalKeyword(FiniteNumber, "number");

/** One titled option of a titled select: the value and its display title. */
const titledOptions = keyword(
  Schema.Array(Schema.Struct({ const: Schema.String, title: Schema.String })),
  'an array of {"const": string, "title": string}',
);

const UntitledSingleSelectEnumSchema = Schema.Struct({
  type: stringType,
  ...labels,
  enum: keyword(StringList, STRING_LIST),
  default: optionalString,
});

const TitledSingleSelectEnumSchema = Schema.Struct({
  type: stringType,
  ...labels,
  oneOf: titledOptions,
  default: optionalString,
});

const multiSelect = {
  type: arrayType,
  ...labels,
  minItems: optionalNumber,
  maxItems: optionalNumber,
  default: optionalKeyword(StringList, STRING_LIST),
};

const UntitledMultiSelectEnumSchema = Schema.Struct({
  ...multiSelect,
  items: keyword(
    Schema.Struct({
      type: stringType,
      enum: keyword(StringList, STRING_LIST),
    }),
    "an object",
    false,
  ),
});

const TitledMultiSelectEnumSchema = Schema.Struct({
  ...multiSelect,
  items: keyword(Schema.Struct({ anyOf: titledOptions }), "an object", false),
});

const BooleanSchema = Schema.Struct({
  type: keyword(Schema.Literal("boolean"), '"boolean"'),
  ...labels,
  default: optionalKeyword(Schema.Boolean, "boolean"),
});

const StringSchema = Schema.Struct({
  type: stringType,
  ...labels,
  minLength: optionalNumber,
  maxLength: optionalNumber,
  format: optionalKeyword(
    Schema.Literal("email", "uri", "date", "date-time"),
    'one of "email", "uri", "date" or "date-time"',
  ),
  default: optionalString,
});

const NumberSchema = Schema.Struct({
  type: keyword(Schema.Literal("number", "integer"), '"number" or "integer"'),
  ...labels,
  minimum: optionalNumber,
  maximum: optionalNumber,
  default: optionalNumber,
});

/** One admitted form field: a primitive property of a form-mode schema. */
export type FormField =
  | typeof UntitledSingleSelectEnumSchema.Type
  | typeof TitledSingleSelectEnumSchema.Type
  | typeof UntitledMultiSelectEnumSchema.Type
  | typeof TitledMultiSelectEnumSchema.Type
  | typeof BooleanSchema.Type
  | typeof StringSchema.Type
  | typeof NumberSchema.Type;

/** Shape outputs keep only declared keywords; failures report every keyword. */
const shapeOptions: ParseOptions = {
  onExcessProperty: "ignore",
  errors: "all",
};

type ShapeDecoder = (
  property: unknown,
) => Either.Either<FormField, ParseResult.ParseError>;

const decoderOf =
  <A extends FormField, I>(schema: Schema.Schema<A, I>): ShapeDecoder =>
  (property) =>
    Schema.decodeUnknownEither(schema)(property, shapeOptions);

/** The shapes in the specification's union order; the first match wins. */
const fieldShapes: readonly ShapeDecoder[] = [
  decoderOf(UntitledSingleSelectEnumSchema),
  decoderOf(TitledSingleSelectEnumSchema),
  decoderOf(UntitledMultiSelectEnumSchema),
  decoderOf(TitledMultiSelectEnumSchema),
  decoderOf(BooleanSchema),
  decoderOf(StringSchema),
  decoderOf(NumberSchema),
];

/**
 * One form-mode shape: what a requester should write, its schema, and which
 * properties it is the intended shape of.
 */
interface FormFieldShape {
  readonly expected: string;
  readonly decode: ShapeDecoder;
  readonly intends: (property: unknown) => boolean;
}

const declares = (property: unknown, ...types: readonly string[]): boolean =>
  Predicate.hasProperty(property, "type") &&
  types.some((type) => type === property.type);

/** Shapes by intent, each listed before any shape it refines. */
const intendedShapes: readonly FormFieldShape[] = [
  {
    expected:
      'a titled single-select is {"type":"string","oneOf":[{"const":"a","title":"A"}]}',
    decode: decoderOf(TitledSingleSelectEnumSchema),
    intends: (property) =>
      declares(property, "string") && Predicate.hasProperty(property, "oneOf"),
  },
  {
    expected: 'a single-select is {"type":"string","enum":["a","b"]}',
    decode: decoderOf(UntitledSingleSelectEnumSchema),
    intends: (property) =>
      declares(property, "string") && Predicate.hasProperty(property, "enum"),
  },
  {
    expected:
      'a string is {"type":"string"} with optional minLength, maxLength or format',
    decode: decoderOf(StringSchema),
    intends: (property) => declares(property, "string"),
  },
  {
    expected:
      'a number is {"type":"number"} or {"type":"integer"} with optional minimum and maximum',
    decode: decoderOf(NumberSchema),
    intends: (property) => declares(property, "number", "integer"),
  },
  {
    expected: 'a boolean is {"type":"boolean"}',
    decode: decoderOf(BooleanSchema),
    intends: (property) => declares(property, "boolean"),
  },
  {
    expected:
      'a titled multi-select is {"type":"array","items":{"anyOf":[{"const":"a","title":"A"}]}}',
    decode: decoderOf(TitledMultiSelectEnumSchema),
    intends: (property) =>
      declares(property, "array") &&
      Predicate.hasProperty(property, "items") &&
      Predicate.hasProperty(property.items, "anyOf"),
  },
  {
    expected:
      'a multi-select is {"type":"array","items":{"type":"string","enum":["a","b"]}}',
    decode: decoderOf(UntitledMultiSelectEnumSchema),
    intends: (property) => declares(property, "array"),
  },
];

const FormFieldValue = Schema.declare(
  (value): value is FormField =>
    Either.match(admitFormField(value), {
      onLeft: () => false,
      onRight: () => true,
    }),
  { identifier: "PrimitiveSchemaDefinition" },
);

/**
 * One property of an MCP form-mode `requestedSchema`. Decoding keeps only the
 * keywords of the shape that admitted the property.
 */
export const FormFieldSchema = Schema.transformOrFail(
  Schema.Unknown,
  FormFieldValue,
  {
    strict: true,
    decode: (value) =>
      Either.match(admitFormField(value), {
        onLeft: (message) =>
          ParseResult.fail(
            new ParseResult.Type(FormFieldValue.ast, value, message),
          ),
        onRight: (field) => ParseResult.succeed(field),
      }),
    encode: (field) => ParseResult.succeed(field),
  },
);

/**
 * Admit one property under the first shape that matches it.
 * @param property An untrusted property of a requested schema.
 * @returns The admitted field, or the text naming each failing keyword.
 */
function admitFormField(property: unknown): Either.Either<FormField, string> {
  return Option.match(
    Arr.findFirst(fieldShapes, (decode) => Either.getRight(decode(property))),
    {
      onNone: () => Either.left(formFieldViolation(property)),
      onSome: offersOptions,
    },
  );
}

/**
 * Say why no shape admits a property: each keyword its intended shape
 * rejects, by path within the property, then that shape.
 * @param property A property every shape rejected.
 * @returns For example `items.type: Invalid input: expected "string"; a
 *   multi-select is {"type":"array","items":{"type":"string","enum":["a","b"]}}`.
 */
function formFieldViolation(property: unknown): string {
  const shape = intendedShapes.find(({ intends }) => intends(property));
  if (shape === undefined) {
    return '"type" must be "string", "number", "integer", "boolean" or "array"';
  }
  return Either.match(shape.decode(property), {
    onLeft: (error) => `${describeIssues(error)}; ${shape.expected}`,
    onRight: () => shape.expected,
  });
}

/**
 * Refuse an admitted select that lists no option to choose. JSON Schema
 * requires a non-empty `enum`, so such a field could accept no answer.
 */
function offersOptions(field: FormField): Either.Either<FormField, string> {
  const noOptions = (path: readonly string[]) =>
    Either.left(`${path.join(".")}: ${expectedText("at least one option")}`);
  if ("enum" in field && field.enum.length === 0) {
    return noOptions(["enum"]);
  }
  if ("items" in field && "enum" in field.items) {
    return field.items.enum.length === 0
      ? noOptions(["items", "enum"])
      : Either.right(field);
  }
  return Either.right(field);
}

/* eslint-enable @typescript-eslint/naming-convention -- Restore the package naming rules after the shapes. */
