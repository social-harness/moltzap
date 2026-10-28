/** @file MCP framing of the harness operations: send metadata, the empty result and validation diagnostics. */

import {
  Array,
  Effect,
  Option,
  type ParseResult,
  Schema,
  SchemaAST,
} from "effect";
import type { ValidationIssue } from "../../communication/conversations/errors.js";
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

/**
 * An operation failure's reason when it is one of `allowed`, so no internal
 * diagnostic crosses the boundary.
 * @param cause The operation's expected failure.
 * @param allowed The tool's closed failure reasons.
 * @param fallback The reason for any other failure.
 * @returns The reason the tool reports.
 */
export function closedReason(
  cause: unknown,
  allowed: ReadonlySet<string>,
  fallback: string,
): string {
  if (typeof cause !== "object" || cause === null || !("reason" in cause)) {
    return fallback;
  }
  const reason: unknown = cause.reason;
  return typeof reason === "string" && allowed.has(reason) ? reason : fallback;
}

const MAXIMUM_VALIDATION_ISSUES = 20;

/**
 * Projects only schema expectations and field paths, keeping submitted values
 * and custom decoder messages out of errors and logs. At most 20 issues cross
 * the boundary even when a schema reports many failing fields or union arms.
 * A union reports only the arms the input selects (see `selectedArms`), and a
 * named value, such as an agent name, reports its own description rather
 * than the first of its checks that failed.
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
  if (issue._tag === "Composite" && issue.ast._tag === "Union") {
    appendUnion(issue, path, issues);
    return;
  }
  if (issue._tag === "Composite") {
    appendChildren(Array.ensure(issue.issues), path, issues);
    return;
  }
  if (issue._tag === "Refinement" || issue._tag === "Transformation") {
    appendRefined(issue, path, issues);
    return;
  }
  issues.push({ path, message: expectedMessage(issue) });
}

/** A named value reports its own rule; any other refinement or transformation reports what failed inside it. */
function appendRefined(
  issue: ParseResult.Refinement | ParseResult.Transformation,
  path: ReadonlyArray<string | number>,
  issues: ValidationIssue[],
): void {
  if (issue._tag === "Refinement" && namedValue(issue)) {
    issues.push({ path, message: expectedSchemaMessage(issue.ast) });
    return;
  }
  appendIssues(issue.issue, path, issues);
}

/**
 * A failed union reports the arms the input selects. When each of those
 * rejects the value as a whole, the union reports once, naming every type it
 * accepts; otherwise the arms that failed inside the value report.
 */
function appendUnion(
  issue: ParseResult.Composite,
  path: ReadonlyArray<string | number>,
  issues: ValidationIssue[],
): void {
  const arms = selectedArms(Array.ensure(issue.issues), issue.actual);
  const inside = arms.filter((arm) => !leafFailure(arm));
  if (inside.length === 0) {
    issues.push({ path, message: expectedSchemaMessage(issue.ast) });
    return;
  }
  appendChildren(inside, path, issues);
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

/**
 * The arms of a failed union the input selects. An `undefined` arm, which an
 * optional field adds, never explains a value that is present. An arm whose
 * literal fields, such as `kind`, all equal the input's is the one the input
 * chose; otherwise an arm with every field it needs and none it forbids. With
 * no such arm, every arm reports.
 */
function selectedArms(
  arms: readonly ParseResult.ParseIssue[],
  actual: unknown,
): readonly ParseResult.ParseIssue[] {
  const present = arms.filter(
    (arm) => !(arm._tag === "Type" && arm.ast._tag === "UndefinedKeyword"),
  );
  const candidates = present.length === 0 ? arms : present;
  const chosen = candidates.filter((arm) => literalsMatch(arm, actual));
  if (chosen.length > 0) {
    return chosen;
  }
  const fitting = candidates.filter((arm) => !fieldsMismatch(arm));
  return fitting.length > 0 ? fitting : candidates;
}

function literalsMatch(
  issue: ParseResult.ParseIssue,
  actual: unknown,
): boolean {
  if (issue._tag === "Refinement" || issue._tag === "Transformation") {
    return literalsMatch(issue.issue, actual);
  }
  if (issue._tag !== "Composite") {
    return false;
  }
  if (issue.ast._tag === "Union") {
    return Array.ensure(issue.issues).some((arm) => literalsMatch(arm, actual));
  }
  if (issue.ast._tag !== "TypeLiteral" || !isRecord(actual)) {
    return false;
  }
  const literals = issue.ast.propertySignatures.flatMap((signature) =>
    signature.type._tag === "Literal"
      ? [{ name: signature.name, literal: signature.type.literal }]
      : [],
  );
  return (
    literals.length > 0 &&
    literals.every(({ name, literal }) => actual[name] === literal)
  );
}

/** Whether an arm lacks a field it requires or holds one it forbids, in every way it can match. */
function fieldsMismatch(issue: ParseResult.ParseIssue): boolean {
  if (issue._tag === "Refinement" || issue._tag === "Transformation") {
    return fieldsMismatch(issue.issue);
  }
  if (issue._tag !== "Composite") {
    return false;
  }
  const children = Array.ensure(issue.issues);
  if (issue.ast._tag === "Union") {
    return children.every(fieldsMismatch);
  }
  return children.some(
    (child) =>
      child._tag === "Pointer" &&
      (child.issue._tag === "Missing" || child.issue._tag === "Unexpected"),
  );
}

/** A failed value of a named schema whose description states its whole rule. */
function namedValue(issue: ParseResult.Refinement): boolean {
  return (
    Option.isSome(SchemaAST.getIdentifierAnnotation(issue.ast)) &&
    Option.isSome(SchemaAST.getDescriptionAnnotation(issue.ast)) &&
    leafFailure(issue)
  );
}

function leafFailure(issue: ParseResult.ParseIssue): boolean {
  if (issue._tag === "Refinement" || issue._tag === "Transformation") {
    return leafFailure(issue.issue);
  }
  return issue._tag !== "Composite" && issue._tag !== "Pointer";
}

function isRecord(
  value: unknown,
): value is Readonly<Record<PropertyKey, unknown>> {
  return typeof value === "object" && value !== null;
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
