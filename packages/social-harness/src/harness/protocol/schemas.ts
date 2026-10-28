/** @file MCP framing of the harness operations: send metadata and the request and result schemas the tool catalog lists. */

import {
  fromJsonSchema,
  type JsonSchemaType,
  type StandardSchemaWithJSON,
} from "@modelcontextprotocol/server";
import {
  Array,
  Brand,
  Effect,
  JSONSchema,
  Option,
  type ParseResult,
  Predicate,
  Schema,
  SchemaAST,
} from "effect";
import { exactParseOptions } from "../../encoding/exact.js";
import { HARNESS_SEND_META_KEY } from "./names.js";
import {
  harnessSendArgumentsSchema,
  harnessSendOptionsSchema,
  type HarnessSendRequest,
} from "./operations.js";

const exactEmptyObject = Schema.Record({
  key: Schema.String,
  value: Schema.Never,
}).annotations({ parseOptions: exactParseOptions });

/** The empty result of an adapter operation. */
export const harnessEmptyResultSchema = exactEmptyObject;

const harnessSendMetadataSchema = Schema.Struct({
  [HARNESS_SEND_META_KEY]: Schema.optionalWith(harnessSendOptionsSchema, {
    exact: true,
  }),
});

/**
 * Validate semantic arguments separately from runtime-owned send options.
 * Unrelated SDK metadata belongs to the transport and is not interpreted here.
 * @param toolArguments Model-visible arguments.
 * @param metadata The SDK request metadata, if supplied.
 * @returns One validated send request.
 */
export function decodeHarnessSendCall(
  toolArguments: unknown,
  metadata: unknown,
): Effect.Effect<HarnessSendRequest, ParseResult.ParseError> {
  return Effect.gen(function* () {
    const args = yield* Schema.decodeUnknown(harnessSendArgumentsSchema)(
      toolArguments,
    );
    const runtime = yield* Schema.decodeUnknown(harnessSendMetadataSchema)(
      metadata === undefined ? {} : metadata,
    );
    return { ...args, ...runtime[HARNESS_SEND_META_KEY] };
  }).pipe(Effect.withSpan("decodeHarnessSendCall"));
}

/** Decoded empty adapter-operation result. */
export type HarnessEmptyResult = typeof harnessEmptyResultSchema.Type;

/** The closed Standard Schema of an Effect Schema, which the MCP SDK validates. */
function closedSchema<A, I>(
  schema: Schema.Schema<A, I>,
): StandardSchemaWithJSON<A, A> {
  return fromJsonSchema<A>(
    // eslint-disable-next-line agent-code-guard/require-assertion-rationale -- JSONSchema.make emits the exact JsonSchemaType consumed by the pinned MCP SDK.
    JSONSchema.make(schema, { target: "jsonSchema2020-12" }) as JsonSchemaType,
  );
}

/**
 * A tool's request schema as the catalog lists it: closed, so an argument the
 * tool does not name fails.
 * @param schema The Effect Schema of the request.
 * @returns The schema the catalog lists and the SDK validates calls against.
 */
export function requestSchema<A, I>(
  schema: Schema.Schema<A, I>,
): StandardSchemaWithJSON<A, A> {
  return closedSchema(schema);
}

/** A tool's result schema as the catalog lists it; only `resultSchema` makes one. */
export type ResultSchema<Value = unknown> = StandardSchemaWithJSON<
  Value,
  Value
> &
  Brand.Brand<"ResultSchema">;

function openObject(
  object: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(object).flatMap(([key, value]) =>
      key === "additionalProperties" && value === false
        ? []
        : [[key, openValue(value)]],
    ),
  );
}

function openValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => openValue(entry));
  }
  return Predicate.isRecord(value) ? openObject(value) : value;
}

/**
 * A tool's result schema. A result may gain fields in any release, so the
 * JSON Schema a host lists is open at every object, and a host that listed an
 * older daemon's tools still accepts a newer daemon's results. Its `validate`
 * is the exact schema the daemon checks each result it returns against.
 * @param schema The Effect Schema of the result.
 * @returns The schema the catalog lists and the daemon checks results with.
 */
export function resultSchema<A, I>(
  schema: Schema.Schema<A, I>,
): ResultSchema<A> {
  const exact = closedSchema(schema);
  const listed = openObject(
    exact["~standard"].jsonSchema.output({ target: "draft-2020-12" }),
  );
  return Brand.nominal<ResultSchema<A>>()({
    "~standard": {
      ...exact["~standard"],
      jsonSchema: { input: () => listed, output: () => listed },
    },
  });
}

/** Admission refusal names the credential to replace without disclosing its value. */
export const registrationAdmissionRefusalMessage =
  "The Registry refused the admission credential; supply this network's admission credential and register again. Docs: https://docs.moltzap.xyz/guides/run-sharnessd#the-registry-refused-the-admission-credential";

/** Closed wire failure vocabularies prevent internal diagnostics from escaping. */
export const harnessFailureReasons = {
  RUNTIME_READ_REASONS: new Set([
    "not-registered",
    "invalid-continuation",
    "invalid-event",
    "unknown-event",
    "persistence-failed",
  ]),
  REGISTER_REASONS: new Set([
    "admission-refused",
    "dependency-unavailable",
    "persistence-failed",
    "incompatible-daemon",
  ]),
  STATUS_REASONS: new Set(["incompatible-daemon"]),
  SEARCH_AGENTS_REASONS: new Set([
    "not-registered",
    "dependency-unavailable",
    "incompatible-daemon",
  ]),
  SEARCH_CONVERSATIONS_REASONS: new Set([
    "not-registered",
    "invalid-address",
    "persistence-failed",
  ]),
  READ_CONVERSATION_REASONS: new Set([
    "not-registered",
    "invalid-address",
    "unknown-agent",
    "invalid-continuation",
    "history-gap",
    "persistence-failed",
  ]),
  ACKNOWLEDGE_DELIVERY_REASONS: new Set([
    "unknown-delivery",
    "delivery-conflict",
    "persistence-failed",
    "transport-failed",
  ]),
};

const MAXIMUM_VALIDATION_ISSUES = 20;

interface ValidationIssue {
  readonly path: ReadonlyArray<string | number>;
  readonly message: string;
}

/**
 * Projects only schema expectations and field paths, keeping submitted values
 * and custom decoder messages out of errors and logs. At most 20 issues cross
 * the boundary even when a schema reports many failing fields or union arms.
 */
export function validationIssues(error: ParseResult.ParseError) {
  const issues: ValidationIssue[] = [];
  appendIssues(error.issue, [], issues);
  return issues;
}

function appendIssues(
  issue: ParseResult.ParseIssue,
  path: ReadonlyArray<string | number>,
  issues: ValidationIssue[],
): void {
  if (issues.length >= MAXIMUM_VALIDATION_ISSUES) {
    return;
  }
  if (issue._tag === "Pointer") {
    appendIssues(
      issue.issue,
      [...path, ...Array.ensure(issue.path).map(pathSegment)],
      issues,
    );
    return;
  }
  if (issue._tag === "Composite") {
    appendChildren(Array.ensure(issue.issues), path, issues);
    return;
  }
  if (issue._tag === "Refinement" || issue._tag === "Transformation") {
    appendIssues(issue.issue, path, issues);
    return;
  }
  issues.push({ path, message: expectedMessage(issue) });
}

function appendChildren(
  children: readonly ParseResult.ParseIssue[],
  path: ReadonlyArray<string | number>,
  issues: ValidationIssue[],
): void {
  for (const child of children) {
    appendIssues(child, path, issues);
    if (issues.length >= MAXIMUM_VALIDATION_ISSUES) {
      break;
    }
  }
}

function pathSegment(key: PropertyKey): string | number {
  return typeof key === "number" ? key : String(key);
}

function expectedMessage(
  issue:
    | ParseResult.Type
    | ParseResult.Forbidden
    | ParseResult.Missing
    | ParseResult.Unexpected,
): string {
  switch (issue._tag) {
    case "Unexpected":
      return "Unexpected field";
    case "Missing":
      return "Required field is missing";
    case "Type":
      if (issue.ast._tag === "NeverKeyword") {
        return "Unexpected field";
      }
      return expectedSchemaMessage(issue.ast);
    case "Forbidden":
      return expectedSchemaMessage(issue.ast);
    default:
      return issue satisfies never;
  }
}

function expectedSchemaMessage(ast: SchemaAST.AST): string {
  return `Expected ${Option.getOrElse(
    SchemaAST.getDescriptionAnnotation(ast),
    () => String(ast),
  )}`;
}
